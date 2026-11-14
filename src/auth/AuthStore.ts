import crypto from "crypto";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import type { UserMeResponse, UsernameStatus } from "../core/ApiSchemas";

const PUBLIC_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PUBLIC_ID_LENGTH = 8;
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;
const DUMMY_PASSWORD_HASH = `scrypt$00000000000000000000000000000000$${"00".repeat(SCRYPT_KEYLEN)}`;
const USERNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_CODE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_MAX_ROWS = 50_000;

export type AccountType = "guest" | "account";

export interface StoredUser {
  uuid: string;
  publicId: string;
  accountType: AccountType;
  provider: string;
  email: string | null;
  passwordHash: string | null;
  usernameBase: string | null;
  usernameDiscriminator: string | null;
  usernameStatus: UsernameStatus | null;
  nextUsernameChangeAt: number | null;
  role: string | null;
  banCategory: string | null;
  banReason: string | null;
  banExpiresAt: number | null;
  flares: string[];
  canCreatePublicLobbies: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface IssuedRefreshSession {
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: number;
}

export type RotateRefreshResult =
  | {
      status: "ok";
      user: StoredUser;
      session: IssuedRefreshSession;
    }
  | {
      status: "reused";
      userUuid: string;
      familyId: string;
    }
  | {
      status: "invalid";
    };

export interface AuthStoreOptions {
  /** SQLite file path or `:memory:` for ephemeral/test stores. */
  dbPath: string;
  /** Default refresh session lifetime in seconds (default 30 days). */
  refreshTtlSeconds?: number;
  /** Whether newly created guest users may list public custom lobbies (default false). */
  guestCanCreatePublicLobbies?: boolean;
  /** Whether registered accounts may list public custom lobbies (default true). */
  accountCanCreatePublicLobbies?: boolean;
}

interface UserRow {
  uuid: string;
  public_id: string;
  account_type: string;
  provider: string;
  email: string | null;
  password_hash: string | null;
  username_base: string | null;
  username_discriminator: string | null;
  username_status: string | null;
  next_username_change_at: number | null;
  role: string | null;
  ban_category: string | null;
  ban_reason: string | null;
  ban_expires_at: number | null;
  flares_json: string;
  can_create_public_lobbies: number;
  created_at: number;
  updated_at: number;
}

interface SessionRow {
  id: string;
  family_id: string;
  user_uuid: string;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function generatePublicId(): string {
  const bytes = crypto.randomBytes(PUBLIC_ID_LENGTH);
  let out = "";
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    out += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
  }
  return out;
}

function generateOpaqueToken(prefix = "fxrt"): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function generateDiscriminator(): string {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

function generateRecoveryCode(): string {
  const raw = crypto.randomBytes(10).toString("hex").toUpperCase();
  return `FXREC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function parseScryptHash(storedHash: string): {
  salt: string;
  expected: Buffer;
  N: number;
  r: number;
  p: number;
} | null {
  const parts = storedHash.split("$");
  if (parts[0] !== "scrypt") {
    return null;
  }
  if (parts.length === 3) {
    const [, salt, expectedHex] = parts;
    if (!salt || !expectedHex) return null;
    return {
      salt,
      expected: Buffer.from(expectedHex, "hex"),
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM,
    };
  }
  if (parts.length === 6) {
    const [, nStr, rStr, pStr, salt, expectedHex] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      N <= 1 ||
      r <= 0 ||
      p <= 0 ||
      !salt ||
      !expectedHex
    ) {
      return null;
    }
    return {
      salt,
      expected: Buffer.from(expectedHex, "hex"),
      N,
      r,
      p,
    };
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt}$${derived.toString("hex")}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parsed = parseScryptHash(storedHash);
  if (!parsed || parsed.expected.length === 0) {
    return false;
  }
  const actual = crypto.scryptSync(
    password,
    parsed.salt,
    parsed.expected.length,
    {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    },
  );
  return (
    actual.length === parsed.expected.length &&
    crypto.timingSafeEqual(actual, parsed.expected)
  );
}

export async function verifyPasswordAsync(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parsed = parseScryptHash(storedHash);
  if (!parsed || parsed.expected.length === 0) {
    return false;
  }
  const actual = await scryptAsync(
    password,
    parsed.salt,
    parsed.expected.length,
    {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    },
  );
  return (
    actual.length === parsed.expected.length &&
    crypto.timingSafeEqual(actual, parsed.expected)
  );
}

function mapUserRow(row: UserRow): StoredUser {
  let flares: string[] = [];
  try {
    const parsed = JSON.parse(row.flares_json);
    if (Array.isArray(parsed)) {
      flares = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    flares = [];
  }

  return {
    uuid: row.uuid,
    publicId: row.public_id,
    accountType: row.account_type === "account" ? "account" : "guest",
    provider: row.provider,
    email: row.email,
    passwordHash: row.password_hash,
    usernameBase: row.username_base,
    usernameDiscriminator: row.username_discriminator,
    usernameStatus:
      row.username_status === "claimed" ||
      row.username_status === "premium" ||
      row.username_status === "indefinite" ||
      row.username_status === "unclaimed"
        ? row.username_status
        : null,
    nextUsernameChangeAt: row.next_username_change_at,
    role: row.role,
    banCategory: row.ban_category,
    banReason: row.ban_reason,
    banExpiresAt: row.ban_expires_at,
    flares,
    canCreatePublicLobbies: row.can_create_public_lobbies === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isUserBanned(user: StoredUser, now = Date.now()): boolean {
  if (!user.banCategory) {
    return false;
  }
  if (user.banExpiresAt === null) {
    return true;
  }
  return user.banExpiresAt > now;
}

export function formatDisplayUsername(user: StoredUser): string | null {
  if (!user.usernameBase) {
    return null;
  }
  if (user.usernameStatus === "claimed") {
    return user.usernameBase;
  }
  const disc = user.usernameDiscriminator ?? "0000";
  return `${user.usernameBase}.${disc}`;
}

export function toUserMeResponse(
  user: StoredUser,
  now = Date.now(),
): UserMeResponse {
  const activeBan = isUserBanned(user, now)
    ? {
        category: user.banCategory ?? "banned",
        reason: user.banReason,
        expiresAt:
          user.banExpiresAt !== null
            ? new Date(user.banExpiresAt).toISOString()
            : null,
      }
    : null;

  const displayUsername = formatDisplayUsername(user);

  return {
    user: user.email
      ? {
          email: user.email,
        }
      : {},
    ban: activeBan,
    player: {
      publicId: user.publicId,
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: user.canCreatePublicLobbies,
      username: displayUsername,
      usernameBase: user.usernameBase,
      usernameDiscriminator: user.usernameDiscriminator,
      usernameStatus: user.usernameStatus ?? undefined,
      usernameClaimExpiresAt: null,
      nextUsernameChangeAt:
        user.nextUsernameChangeAt !== null
          ? new Date(user.nextUsernameChangeAt).toISOString()
          : null,
      flares: user.flares,
      achievements: {
        singleplayerMap: [],
      },
      friends: [],
      subscription: null,
      marketingConsent: {
        consented: "no_response",
        hasEmail: user.email !== null,
      },
    },
  };
}

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly refreshTtlMs: number;
  private readonly guestCanCreatePublicLobbies: boolean;
  private readonly accountCanCreatePublicLobbies: boolean;

  constructor(options: AuthStoreOptions) {
    const isMemory = options.dbPath === ":memory:";
    if (!isMemory) {
      const dir = path.dirname(options.dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.enforcePosixMode(dir, 0o700);
    }
    this.db = new DatabaseSync(options.dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    this.refreshTtlMs = (options.refreshTtlSeconds ?? 30 * 24 * 3600) * 1000;
    this.guestCanCreatePublicLobbies =
      options.guestCanCreatePublicLobbies ?? false;
    this.accountCanCreatePublicLobbies =
      options.accountCanCreatePublicLobbies ?? true;
    this.initSchema();
    if (!isMemory) {
      this.enforcePosixMode(options.dbPath, 0o600);
      this.enforcePosixMode(`${options.dbPath}-wal`, 0o600);
      this.enforcePosixMode(`${options.dbPath}-shm`, 0o600);
    }
  }

  private enforcePosixMode(targetPath: string, mode: number): void {
    if (process.platform === "win32") {
      return;
    }
    try {
      if (fs.existsSync(targetPath)) {
        fs.chmodSync(targetPath, mode);
      }
    } catch {
      // Ignore chmod errors on virtual/restricted filesystems.
    }
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS users (
        uuid TEXT PRIMARY KEY,
        public_id TEXT UNIQUE NOT NULL,
        account_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT,
        username_base TEXT,
        username_discriminator TEXT,
        username_status TEXT DEFAULT 'unclaimed',
        next_username_change_at INTEGER,
        role TEXT,
        ban_category TEXT,
        ban_reason TEXT,
        ban_expires_at INTEGER,
        flares_json TEXT NOT NULL DEFAULT '[]',
        can_create_public_lobbies INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        user_uuid TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER,
        replaced_by_id TEXT,
        user_agent TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_uuid);

      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        code_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_uuid);

      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        client_id TEXT,
        user_uuid TEXT,
        archive_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    const gameColumns = this.db
      .prepare("PRAGMA table_info(games)")
      .all() as unknown as Array<{ name: string }>;
    if (!gameColumns.some((col) => col.name === "user_uuid")) {
      this.db.exec("ALTER TABLE games ADD COLUMN user_uuid TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at)",
    );
  }

  ping(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 AS ok").get() as
        | { ok?: number }
        | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  private createUniquePublicId(): string {
    const stmt = this.db.prepare(
      "SELECT 1 FROM users WHERE public_id = ? LIMIT 1",
    );
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = generatePublicId();
      if (!stmt.get(candidate)) {
        return candidate;
      }
    }
    return crypto.randomBytes(6).toString("base64url");
  }

  createGuestUser(now = Date.now()): StoredUser {
    const uuid = crypto.randomUUID();
    const publicId = this.createUniquePublicId();
    const canPublic = this.guestCanCreatePublicLobbies ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO users (
          uuid, public_id, account_type, provider, email, password_hash,
          username_base, username_discriminator, username_status,
          flares_json, can_create_public_lobbies, created_at, updated_at
        ) VALUES (?, ?, 'guest', 'guest', NULL, NULL, NULL, NULL, 'unclaimed', '[]', ?, ?, ?)`,
      )
      .run(uuid, publicId, canPublic, now, now);

    return this.getUserByUuid(uuid)!;
  }

  private registerAccountWithHash(args: {
    normalizedEmail: string;
    passwordHash: string;
    upgradeGuestUuid?: string;
    usernameBase?: string | null;
    now: number;
  }):
    | { status: "ok"; user: StoredUser; upgradedFromGuest: boolean }
    | { status: "email_taken" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingByEmail = this.getUserByEmail(args.normalizedEmail);
      if (existingByEmail) {
        this.db.exec("COMMIT");
        return { status: "email_taken" };
      }

      const canPublic = this.accountCanCreatePublicLobbies ? 1 : 0;

      if (args.upgradeGuestUuid) {
        const guest = this.getUserByUuid(args.upgradeGuestUuid);
        if (guest && guest.accountType === "guest") {
          this.db
            .prepare(
              `UPDATE users SET
                account_type = 'account',
                provider = 'frontierx',
                email = ?,
                password_hash = ?,
                can_create_public_lobbies = CASE WHEN can_create_public_lobbies = 1 THEN 1 ELSE ? END,
                updated_at = ?
              WHERE uuid = ?`,
            )
            .run(
              args.normalizedEmail,
              args.passwordHash,
              canPublic,
              args.now,
              guest.uuid,
            );
          this.db.exec("COMMIT");
          return {
            status: "ok",
            user: this.getUserByUuid(guest.uuid)!,
            upgradedFromGuest: true,
          };
        }
      }

      const uuid = crypto.randomUUID();
      const publicId = this.createUniquePublicId();
      const trimmedBase = args.usernameBase?.trim() ?? "";
      const base = trimmedBase.length > 0 ? trimmedBase : null;
      const disc = base ? generateDiscriminator() : null;
      const status: UsernameStatus = "unclaimed";

      this.db
        .prepare(
          `INSERT INTO users (
            uuid, public_id, account_type, provider, email, password_hash,
            username_base, username_discriminator, username_status,
            flares_json, can_create_public_lobbies, created_at, updated_at
          ) VALUES (?, ?, 'account', 'frontierx', ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
        )
        .run(
          uuid,
          publicId,
          args.normalizedEmail,
          args.passwordHash,
          base,
          disc,
          status,
          canPublic,
          args.now,
          args.now,
        );

      this.db.exec("COMMIT");
      return {
        status: "ok",
        user: this.getUserByUuid(uuid)!,
        upgradedFromGuest: false,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerAccount(args: {
    email: string;
    password: string;
    upgradeGuestUuid?: string;
    usernameBase?: string | null;
    now?: number;
  }):
    | { status: "ok"; user: StoredUser; upgradedFromGuest: boolean }
    | { status: "email_taken" } {
    const now = args.now ?? Date.now();
    const normalizedEmail = args.email.trim().toLowerCase();
    if (this.getUserByEmail(normalizedEmail)) {
      return { status: "email_taken" };
    }
    const passwordHash = hashPassword(args.password);
    return this.registerAccountWithHash({
      normalizedEmail,
      passwordHash,
      upgradeGuestUuid: args.upgradeGuestUuid,
      usernameBase: args.usernameBase,
      now,
    });
  }

  async registerAccountAsync(args: {
    email: string;
    password: string;
    upgradeGuestUuid?: string;
    usernameBase?: string | null;
    now?: number;
  }): Promise<
    | { status: "ok"; user: StoredUser; upgradedFromGuest: boolean }
    | { status: "email_taken" }
  > {
    const now = args.now ?? Date.now();
    const normalizedEmail = args.email.trim().toLowerCase();
    if (this.getUserByEmail(normalizedEmail)) {
      return { status: "email_taken" };
    }
    const passwordHash = await hashPasswordAsync(args.password);
    return this.registerAccountWithHash({
      normalizedEmail,
      passwordHash,
      upgradeGuestUuid: args.upgradeGuestUuid,
      usernameBase: args.usernameBase,
      now,
    });
  }

  authenticateAccount(email: string, password: string): StoredUser | null {
    const user = this.getUserByEmail(email.trim().toLowerCase());
    if (!user || !user.passwordHash) {
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return null;
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return null;
    }
    return user;
  }

  async authenticateAccountAsync(
    email: string,
    password: string,
  ): Promise<StoredUser | null> {
    const user = this.getUserByEmail(email.trim().toLowerCase());
    if (!user || !user.passwordHash) {
      await verifyPasswordAsync(password, DUMMY_PASSWORD_HASH);
      return null;
    }
    if (!(await verifyPasswordAsync(password, user.passwordHash))) {
      return null;
    }
    return user;
  }

  getUserByUuid(uuid: string): StoredUser | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE uuid = ? LIMIT 1")
      .get(uuid) as unknown as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  getUserByEmail(email: string): StoredUser | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
      .get(email.trim().toLowerCase()) as unknown as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  setUserBan(
    uuid: string,
    ban: {
      category: string;
      reason: string | null;
      expiresAt: number | null;
    } | null,
    now = Date.now(),
  ): void {
    if (ban === null) {
      this.db
        .prepare(
          `UPDATE users
           SET ban_category = NULL, ban_reason = NULL, ban_expires_at = NULL,
               role = CASE WHEN role = 'banned' THEN NULL ELSE role END,
               updated_at = ?
           WHERE uuid = ?`,
        )
        .run(now, uuid);
      return;
    }
    this.db
      .prepare(
        `UPDATE users
         SET ban_category = ?, ban_reason = ?, ban_expires_at = ?, role = 'banned', updated_at = ?
         WHERE uuid = ?`,
      )
      .run(ban.category, ban.reason, ban.expiresAt, now, uuid);
  }

  setUserPrivileges(
    uuid: string,
    updates: {
      role?: string | null;
      flares?: string[];
      canCreatePublicLobbies?: boolean;
    },
    now = Date.now(),
  ): void {
    const user = this.getUserByUuid(uuid);
    if (!user) return;
    const role = updates.role !== undefined ? updates.role : user.role;
    const flaresJson = JSON.stringify(updates.flares ?? user.flares);
    const canPublic =
      updates.canCreatePublicLobbies !== undefined
        ? updates.canCreatePublicLobbies
          ? 1
          : 0
        : user.canCreatePublicLobbies
          ? 1
          : 0;
    this.db
      .prepare(
        "UPDATE users SET role = ?, flares_json = ?, can_create_public_lobbies = ?, updated_at = ? WHERE uuid = ?",
      )
      .run(role, flaresJson, canPublic, now, uuid);
  }

  updateUsername(
    uuid: string,
    base: string,
    now = Date.now(),
  ):
    | { status: "ok"; user: StoredUser }
    | { status: "cooldown"; nextUsernameChangeAt: number }
    | { status: "not_found" } {
    const user = this.getUserByUuid(uuid);
    if (!user) {
      return { status: "not_found" };
    }
    if (user.nextUsernameChangeAt !== null && user.nextUsernameChangeAt > now) {
      return {
        status: "cooldown",
        nextUsernameChangeAt: user.nextUsernameChangeAt,
      };
    }
    const discriminator = generateDiscriminator();
    const nextChangeAt = now + USERNAME_COOLDOWN_MS;
    this.db
      .prepare(
        `UPDATE users
         SET username_base = ?, username_discriminator = ?, username_status = 'unclaimed',
             next_username_change_at = ?, updated_at = ?
         WHERE uuid = ?`,
      )
      .run(base, discriminator, nextChangeAt, now, uuid);
    return { status: "ok", user: this.getUserByUuid(uuid)! };
  }

  deleteUser(uuid: string): boolean {
    const result = this.db
      .prepare("DELETE FROM users WHERE uuid = ?")
      .run(uuid);
    return result.changes > 0;
  }

  issueRefreshSession(args: {
    userUuid: string;
    familyId?: string;
    userAgent?: string | null;
    ip?: string | null;
    now?: number;
  }): IssuedRefreshSession {
    const now = args.now ?? Date.now();
    const sessionId = crypto.randomUUID();
    const familyId = args.familyId ?? crypto.randomUUID();
    const refreshToken = generateOpaqueToken();
    const tokenHash = sha256Hex(refreshToken);
    const expiresAt = now + this.refreshTtlMs;

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, family_id, user_uuid, token_hash, expires_at,
          used_at, revoked_at, replaced_by_id, user_agent, ip, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        sessionId,
        familyId,
        args.userUuid,
        tokenHash,
        expiresAt,
        args.userAgent ?? null,
        args.ip ?? null,
        now,
      );

    return { sessionId, familyId, refreshToken, expiresAt };
  }

  /**
   * Read-only lookup of a valid, unspent, non-revoked refresh session. Does not
   * consume or rotate the token so failed upstream calls cannot burn sessions.
   */
  peekRefreshSession(
    refreshToken: string,
    now = Date.now(),
  ): StoredUser | null {
    const tokenHash = sha256Hex(refreshToken);
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? LIMIT 1")
      .get(tokenHash) as unknown as SessionRow | undefined;
    if (
      !row ||
      row.revoked_at !== null ||
      row.used_at !== null ||
      row.expires_at <= now
    ) {
      return null;
    }
    return this.getUserByUuid(row.user_uuid);
  }

  rotateRefreshSession(args: {
    refreshToken: string;
    userAgent?: string | null;
    ip?: string | null;
    now?: number;
  }): RotateRefreshResult {
    const now = args.now ?? Date.now();
    const tokenHash = sha256Hex(args.refreshToken);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM sessions WHERE token_hash = ? LIMIT 1")
        .get(tokenHash) as unknown as SessionRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      if (row.revoked_at !== null || row.expires_at <= now) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      if (row.used_at !== null) {
        // Reuse detected: invalidate the entire token family immediately.
        this.db
          .prepare(
            "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
          )
          .run(now, row.family_id);
        this.db.exec("COMMIT");
        return {
          status: "reused",
          userUuid: row.user_uuid,
          familyId: row.family_id,
        };
      }

      const user = this.getUserByUuid(row.user_uuid);
      if (!user) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      const nextId = crypto.randomUUID();
      const nextRefreshToken = generateOpaqueToken();
      const nextHash = sha256Hex(nextRefreshToken);
      const nextExpiresAt = now + this.refreshTtlMs;

      this.db
        .prepare(
          "UPDATE sessions SET used_at = ?, replaced_by_id = ? WHERE id = ?",
        )
        .run(now, nextId, row.id);

      this.db
        .prepare(
          `INSERT INTO sessions (
            id, family_id, user_uuid, token_hash, expires_at,
            used_at, revoked_at, replaced_by_id, user_agent, ip, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          nextId,
          row.family_id,
          row.user_uuid,
          nextHash,
          nextExpiresAt,
          args.userAgent ?? null,
          args.ip ?? null,
          now,
        );

      this.db.exec("COMMIT");
      return {
        status: "ok",
        user,
        session: {
          sessionId: nextId,
          familyId: row.family_id,
          refreshToken: nextRefreshToken,
          expiresAt: nextExpiresAt,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeRefreshToken(refreshToken: string, now = Date.now()): void {
    const tokenHash = sha256Hex(refreshToken);
    const row = this.db
      .prepare("SELECT family_id FROM sessions WHERE token_hash = ? LIMIT 1")
      .get(tokenHash) as unknown as { family_id: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
      )
      .run(now, row.family_id);
  }

  revokeAllUserSessions(userUuid: string, now = Date.now()): number {
    const result = this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE user_uuid = ? AND revoked_at IS NULL",
      )
      .run(now, userUuid);
    return Number(result.changes);
  }

  /**
   * Issues a new recovery code for `userUuid`, revoking any previously unused
   * codes for that user so at most one active recovery code exists at a time.
   */
  createRecoveryCode(
    userUuid: string,
    now = Date.now(),
  ): { recoveryCode: string; expiresAt: number } {
    const recoveryCode = generateRecoveryCode();
    const codeHash = sha256Hex(normalizeRecoveryCode(recoveryCode));
    const expiresAt = now + RECOVERY_CODE_TTL_MS;
    const id = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE recovery_codes SET used_at = ? WHERE user_uuid = ? AND used_at IS NULL",
        )
        .run(now, userUuid);
      this.db
        .prepare(
          `INSERT INTO recovery_codes (id, user_uuid, code_hash, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, userUuid, codeHash, expiresAt, now);
      this.db.exec("COMMIT");
      return { recoveryCode, expiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  redeemRecoveryCode(args: {
    recoveryCode: string;
    userAgent?: string | null;
    ip?: string | null;
    now?: number;
  }):
    | { status: "ok"; user: StoredUser; session: IssuedRefreshSession }
    | { status: "invalid" } {
    const now = args.now ?? Date.now();
    const codeHash = sha256Hex(normalizeRecoveryCode(args.recoveryCode));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT id, user_uuid, expires_at, used_at FROM recovery_codes WHERE code_hash = ? LIMIT 1",
        )
        .get(codeHash) as
        | {
            id: string;
            user_uuid: string;
            expires_at: number;
            used_at: number | null;
          }
        | undefined;

      if (!row || row.used_at !== null || row.expires_at <= now) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      const user = this.getUserByUuid(row.user_uuid);
      if (!user) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      const markUsed = this.db
        .prepare(
          "UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
        )
        .run(now, row.id);
      if (Number(markUsed.changes) !== 1) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      // Revoke all previously issued refresh sessions for this user upon recovery.
      this.db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE user_uuid = ? AND revoked_at IS NULL",
        )
        .run(now, user.uuid);

      const session = this.issueRefreshSession({
        userUuid: user.uuid,
        userAgent: args.userAgent,
        ip: args.ip,
        now,
      });

      this.db.exec("COMMIT");
      return { status: "ok", user, session };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveArchivedGame(
    gameId: string,
    archiveJson: string,
    clientId: string | null,
    userUuid: string | null = null,
    now = Date.now(),
  ): { status: "ok" } | { status: "forbidden" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT user_uuid FROM games WHERE game_id = ? LIMIT 1")
        .get(gameId) as unknown as { user_uuid: string | null } | undefined;
      if (existing && existing.user_uuid && existing.user_uuid !== userUuid) {
        this.db.exec("COMMIT");
        return { status: "forbidden" };
      }
      this.db
        .prepare(
          `INSERT INTO games (game_id, client_id, user_uuid, archive_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(game_id) DO UPDATE SET
             archive_json = excluded.archive_json,
             client_id = COALESCE(excluded.client_id, games.client_id),
             user_uuid = COALESCE(games.user_uuid, excluded.user_uuid)`,
        )
        .run(gameId, clientId, userUuid, archiveJson, now);
      this.db.exec("COMMIT");
      return { status: "ok" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getArchivedGameRecord(
    gameId: string,
  ): { archiveJson: string; userUuid: string | null } | null {
    const row = this.db
      .prepare(
        "SELECT archive_json, user_uuid FROM games WHERE game_id = ? LIMIT 1",
      )
      .get(gameId) as
      | { archive_json: string; user_uuid: string | null }
      | undefined;
    return row
      ? { archiveJson: row.archive_json, userUuid: row.user_uuid }
      : null;
  }

  getArchivedGame(gameId: string): string | null {
    const record = this.getArchivedGameRecord(gameId);
    return record ? record.archiveJson : null;
  }

  pruneExpiredSessions(now = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  pruneOldArchives(
    now = Date.now(),
    maxAgeMs = DEFAULT_ARCHIVE_RETENTION_MS,
    maxRows = DEFAULT_ARCHIVE_MAX_ROWS,
  ): number {
    let removed = 0;
    const cutoff = now - maxAgeMs;
    const byAge = this.db
      .prepare("DELETE FROM games WHERE created_at < ?")
      .run(cutoff);
    removed += Number(byAge.changes);

    const countRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM games")
      .get() as unknown as { cnt: number };
    const excess = countRow.cnt - maxRows;
    if (excess > 0) {
      const byCount = this.db
        .prepare(
          `DELETE FROM games WHERE game_id IN (
             SELECT game_id FROM games ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(excess);
      removed += Number(byCount.changes);
    }
    return removed;
  }
}
