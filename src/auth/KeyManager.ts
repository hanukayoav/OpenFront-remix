import crypto from "crypto";
import fs from "fs";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import path from "path";
import { z } from "zod";
import { type TokenPayload, TokenPayloadSchema } from "../core/ApiSchemas";
import { uuidToBase64url } from "../core/Base64";

export interface KeyManagerOptions {
  /** PEM-encoded PKCS8 Ed25519 private key (optional override via env/secret). */
  privateKeyPem?: string;
  /** Optional previous public JWKs to retain during PEM-based key rotation. */
  previousPublicJwks?: JWK[];
  /** File path to persist or load the Ed25519 JWK keypair. */
  keyFilePath?: string;
  /** If true, keeps generated keys strictly in memory (for tests). */
  ephemeral?: boolean;
  /** Expected issuer URL included in signed JWTs and verified against tokens. */
  issuer: string;
  /** Expected audience domain included in signed JWTs and verified against tokens. */
  audience: string;
  /** Access token lifetime in seconds (default 900s / 15m). */
  accessTokenTtlSeconds?: number;
}

export interface AccessTokenSignInput {
  userUuid: string;
  provider?: string;
  role?: string;
  ttlSeconds?: number;
}

export interface SignedAccessToken {
  jwt: string;
  jti: string;
  expiresIn: number;
  issuedAt: number;
  expiresAt: number;
}

type KeyLike = Awaited<ReturnType<typeof importJWK>>;
type LocalJwkSet = ReturnType<typeof createLocalJWKSet>;

const PersistedKeySchema = z.object({
  privateJwk: z.record(z.string(), z.unknown()),
  publicJwk: z.record(z.string(), z.unknown()),
  previousPublicJwks: z.array(z.record(z.string(), z.unknown())).optional(),
});

function enforceOwnerOnlyFileMode(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ignores POSIX chmod; file permissions stay user-scoped.
  }
}

function enforceOwnerOnlyDirMode(dirPath: string): void {
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Windows NTFS ignores POSIX chmod.
  }
}

function writePersistedKeyAtomic(
  keyFilePath: string,
  payload: {
    privateJwk: JWK;
    publicJwk: JWK;
    previousPublicJwks: JWK[];
  },
): void {
  const dir = path.dirname(keyFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  enforceOwnerOnlyDirMode(dir);
  const tmpPath = `${keyFilePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  enforceOwnerOnlyFileMode(tmpPath);
  fs.renameSync(tmpPath, keyFilePath);
  enforceOwnerOnlyFileMode(keyFilePath);
}

export class KeyManager {
  private readonly verifyKeySet: LocalJwkSet;

  private constructor(
    private readonly privateKey: KeyLike,
    private readonly publicJwk: JWK,
    private readonly previousPublicJwks: JWK[],
    private readonly issuer: string,
    private readonly audience: string,
    private readonly accessTokenTtlSeconds: number,
  ) {
    this.verifyKeySet = createLocalJWKSet({
      keys: [this.publicJwk, ...this.previousPublicJwks],
    });
  }

  static async create(options: KeyManagerOptions): Promise<KeyManager> {
    const ttl = options.accessTokenTtlSeconds ?? 900;
    const pem = options.privateKeyPem?.trim();
    if (pem) {
      const normalizedPem = pem.replace(/\\n/g, "\n");
      const privateKey = await importPKCS8(normalizedPem, "EdDSA", {
        extractable: true,
      });
      const privateJwk = await exportJWK(privateKey);
      const rawPublic: JWK = { ...privateJwk };
      delete rawPublic.d;
      const kid = await calculateJwkThumbprint(rawPublic, "sha256");
      const publicJwk: JWK = {
        ...rawPublic,
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        kid,
      };
      return new KeyManager(
        privateKey,
        publicJwk,
        options.previousPublicJwks ?? [],
        options.issuer,
        options.audience,
        ttl,
      );
    }

    const keyFilePath = options.ephemeral ? undefined : options.keyFilePath;
    if (keyFilePath && fs.existsSync(keyFilePath)) {
      enforceOwnerOnlyDirMode(path.dirname(keyFilePath));
      enforceOwnerOnlyFileMode(keyFilePath);
      const raw = JSON.parse(fs.readFileSync(keyFilePath, "utf8"));
      const parsed = PersistedKeySchema.parse(raw);
      const privateJwk = parsed.privateJwk as JWK;
      const publicJwk = parsed.publicJwk as JWK;
      const previousPublicJwks = (parsed.previousPublicJwks ?? []) as JWK[];
      const privateKey = await importJWK(privateJwk, "EdDSA");
      // Validate public key parses cleanly as EdDSA.
      await importJWK(publicJwk, "EdDSA");
      return new KeyManager(
        privateKey,
        publicJwk,
        previousPublicJwks,
        options.issuer,
        options.audience,
        ttl,
      );
    }

    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const rawPrivateJwk = await exportJWK(privateKey);
    const rawPublicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(rawPublicJwk, "sha256");
    const publicJwk: JWK = {
      ...rawPublicJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    };
    const privateJwk: JWK = {
      ...rawPrivateJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    };

    if (keyFilePath) {
      writePersistedKeyAtomic(keyFilePath, {
        privateJwk,
        publicJwk,
        previousPublicJwks: options.previousPublicJwks ?? [],
      });
    }

    return new KeyManager(
      privateKey,
      publicJwk,
      options.previousPublicJwks ?? [],
      options.issuer,
      options.audience,
      ttl,
    );
  }

  /**
   * Atomically generates a new active Ed25519 key in `keyFilePath` while retaining
   * up to `maxPrevious` prior public JWKs so unexpired tokens remain valid during rollover.
   */
  static async rotateKeyFile(
    keyFilePath: string,
    maxPrevious = 2,
  ): Promise<{ currentKid: string; previousKids: string[] }> {
    let previousPublicJwks: JWK[] = [];
    if (fs.existsSync(keyFilePath)) {
      enforceOwnerOnlyFileMode(keyFilePath);
      const raw = JSON.parse(fs.readFileSync(keyFilePath, "utf8"));
      const parsed = PersistedKeySchema.parse(raw);
      const oldCurrent = parsed.publicJwk as JWK;
      const oldPrev = (parsed.previousPublicJwks ?? []) as JWK[];
      previousPublicJwks = [oldCurrent, ...oldPrev].slice(
        0,
        Math.max(0, maxPrevious),
      );
    }

    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const rawPrivateJwk = await exportJWK(privateKey);
    const rawPublicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(rawPublicJwk, "sha256");
    const publicJwk: JWK = {
      ...rawPublicJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    };
    const privateJwk: JWK = {
      ...rawPrivateJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    };

    writePersistedKeyAtomic(keyFilePath, {
      privateJwk,
      publicJwk,
      previousPublicJwks,
    });

    return {
      currentKid: kid,
      previousKids: previousPublicJwks
        .map((k) => k.kid)
        .filter((k): k is string => typeof k === "string"),
    };
  }

  getPublicJwks(): { keys: JWK[] } {
    return {
      keys: [this.publicJwk, ...this.previousPublicJwks],
    };
  }

  getKid(): string {
    return this.publicJwk.kid ?? "frontierx-ed25519";
  }

  getIssuer(): string {
    return this.issuer;
  }

  getAudience(): string {
    return this.audience;
  }

  async signAccessToken(
    input: AccessTokenSignInput,
  ): Promise<SignedAccessToken> {
    const jti = crypto.randomUUID();
    const expiresIn = input.ttlSeconds ?? this.accessTokenTtlSeconds;
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + expiresIn;
    const sub = uuidToBase64url(input.userUuid);

    const payload: Record<string, unknown> = {
      jti,
      sub,
      iss: this.issuer,
      aud: this.audience,
      iat: nowSec,
      exp: expSec,
    };
    if (input.provider) {
      payload.provider = input.provider;
    }
    if (input.role) {
      payload.role = input.role;
    }

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({
        alg: "EdDSA",
        typ: "JWT",
        kid: this.getKid(),
      })
      .sign(this.privateKey);

    return {
      jwt,
      jti,
      expiresIn,
      issuedAt: nowSec,
      expiresAt: expSec,
    };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const { payload } = await jwtVerify(token, this.verifyKeySet, {
      algorithms: ["EdDSA"],
      issuer: this.issuer,
      audience: this.audience,
    });
    return TokenPayloadSchema.parse(payload);
  }
}
