// @vitest-environment node
import express from "express";
import http from "http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { uuidToBase64url } from "../../src/core/Base64";

describe("Production JWT and external auth verification (GAME_ENV=prod)", () => {
  let authServer: http.Server;
  let issuerUrl = "";
  let privateKey: CryptoKey;
  let userMeBehavior: "ok" | "unauthorized" | "malformed" = "ok";
  let lastApiKeyHeader = "";

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.alg = "EdDSA";
    publicJwk.crv = "Ed25519";
    publicJwk.kty = "OKP";

    const app = express();
    app.get("/.well-known/jwks.json", (_req, res) => {
      res.json({ keys: [publicJwk] });
    });
    app.get("/users/@me", (req, res) => {
      lastApiKeyHeader = String(req.headers["x-api-key"] ?? "");
      if (userMeBehavior === "unauthorized") {
        return res.status(401).json({ error: "Invalid token" });
      }
      if (userMeBehavior === "malformed") {
        return res.status(200).json({ unexpected: true });
      }
      res.json({
        user: {
          email: "pilot@frontierx.test",
        },
        ban: null,
        player: {
          publicId: "pub-player-1",
          adfree: true,
          unlimitedRanked: true,
          canCreatePublicLobbies: true,
          username: "CommanderOne",
          usernameStatus: "premium",
          flares: [],
          achievements: { singleplayerMap: [] },
          friends: [],
          clans: [],
          subscription: null,
        },
      });
    });

    authServer = http.createServer(app);
    await new Promise<void>((resolve) =>
      authServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = authServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected auth server address");
    }
    issuerUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      authServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    userMeBehavior = "ok";
    lastApiKeyHeader = "";
    vi.resetModules();
    vi.stubEnv("GAME_ENV", "prod");
    vi.stubEnv("DOMAIN", "openfront-2.duckdns.org");
    vi.stubEnv("API_KEY", "test-server-api-key");
  });

  async function signTestJwt(
    overrides: {
      issuer?: string;
      audience?: string;
      expiresIn?: string | number;
      uuid?: string;
      signingKey?: CryptoKey;
    } = {},
  ) {
    const uuid = overrides.uuid ?? "123e4567-e89b-12d3-a456-426614174000";
    return await new SignJWT({
      jti: "jwt-id-1",
      provider: "discord",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(uuidToBase64url(uuid))
      .setIssuer(overrides.issuer ?? issuerUrl)
      .setAudience(overrides.audience ?? "openfront-2.duckdns.org")
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(overrides.signingKey ?? privateKey);
  }

  it("rejects unsigned UUID persistent-ID tokens in GAME_ENV=prod", async () => {
    const { ServerEnv } = await import("../../src/server/ServerEnv");
    vi.spyOn(ServerEnv, "jwtIssuer").mockReturnValue(issuerUrl);
    const { verifyClientToken } = await import("../../src/server/jwt");

    const res = await verifyClientToken("123e4567-e89b-12d3-a456-426614174000");
    expect(res).toEqual({
      type: "error",
      message: "persistent ID not allowed in production",
    });
  });

  it("verifies valid EdDSA JWTs and rejects wrong issuer, audience, expired, or forged tokens", async () => {
    const { ServerEnv } = await import("../../src/server/ServerEnv");
    vi.spyOn(ServerEnv, "jwtIssuer").mockReturnValue(issuerUrl);
    const { verifyClientToken } = await import("../../src/server/jwt");

    const validJwt = await signTestJwt();
    const ok = await verifyClientToken(validJwt);
    expect(ok).toMatchObject({
      type: "success",
      persistentId: "123e4567-e89b-12d3-a456-426614174000",
    });

    const wrongIssuer = await verifyClientToken(
      await signTestJwt({ issuer: "https://evil.example" }),
    );
    expect(wrongIssuer.type).toBe("error");

    const wrongAudience = await verifyClientToken(
      await signTestJwt({ audience: "other.example.com" }),
    );
    expect(wrongAudience.type).toBe("error");

    const expired = await verifyClientToken(
      await signTestJwt({ expiresIn: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect(expired.type).toBe("error");

    const roguePair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await verifyClientToken(
      await signTestJwt({ signingKey: roguePair.privateKey }),
    );
    expect(forged.type).toBe("error");
  });

  it("validates /users/@me fail-closed and sends x-api-key", async () => {
    const { ServerEnv } = await import("../../src/server/ServerEnv");
    vi.spyOn(ServerEnv, "jwtIssuer").mockReturnValue(issuerUrl);
    const { getUserMe } = await import("../../src/server/jwt");

    const validJwt = await signTestJwt();

    const ok = await getUserMe(validJwt);
    expect(ok.type).toBe("success");
    expect(lastApiKeyHeader).toBe("test-server-api-key");

    userMeBehavior = "unauthorized";
    const rejected = await getUserMe(validJwt);
    expect(rejected.type).toBe("error");

    userMeBehavior = "malformed";
    const invalidShape = await getUserMe(validJwt);
    expect(invalidShape.type).toBe("error");
  });
});
