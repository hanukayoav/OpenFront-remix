import cors from "cors";
import express, { type Request, type Response } from "express";
import path from "path";
import type winston from "winston";
import { z } from "zod";
import { censorPlayer, profanityMatcher } from "../server/Censor";
import { logger } from "../server/Logger";
import {
  AuthStore,
  formatDisplayUsername,
  isUserBanned,
  type StoredUser,
  toUserMeResponse,
} from "./AuthStore";
import { KeyManager } from "./KeyManager";
import {
  createIpRateLimitMiddleware,
  getClientIp,
  isAllowedCookieCsrfRequest,
  isOriginAllowed,
  SlidingWindowLimiter,
  timingSafeEqualStrings,
} from "./RateLimiter";
import {
  createTurnstileVerifier,
  type TurnstileVerifyFn,
} from "./TurnstileVerifier";

const REFRESH_COOKIE_NAME = "fx_refresh";
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const USERNAME_REGEX = /^[a-zA-Z0-9_ ]{2,20}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GuestAuthRequestSchema = z.object({}).optional();

const RegisterRequestSchema = z.object({
  email: z.string().trim().min(3).max(MAX_EMAIL_LENGTH),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  username: z.string().trim().min(2).max(20).optional(),
});

const LoginRequestSchema = z.object({
  email: z.string().trim().min(3).max(MAX_EMAIL_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const RecoverRequestSchema = z.object({
  recoveryCode: z.string().trim().min(8).max(64),
});

const UpdateUsernameRequestSchema = z.object({
  username: z.string().trim().min(2).max(20),
});

const JoinVerifyRequestSchema = z.object({
  ip: z.string().nullable().optional(),
  token: z.string().nullable(),
  username: z.string(),
  clanTag: z.string().nullable().optional(),
});

export interface AuthAppOptions {
  /** Expected JWT issuer URL (`iss` claim). */
  issuer: string;
  /** Expected JWT audience (`aud` claim, usually `DOMAIN`). */
  audience: string;
  /** Shared API key required for server-only endpoints (`/join_verify`, etc.). */
  apiKey?: string;
  /** KeyManager instance (created automatically if omitted). */
  keyManager?: KeyManager;
  /** AuthStore instance (created automatically if omitted). */
  store?: AuthStore;
  /** Directory for default SQLite DB and Ed25519 key files when `store`/`keyManager` are omitted. */
  dataDir?: string;
  /** Allowed browser origins for CORS & CSRF checks. */
  allowedOrigins?: string[];
  /** Custom Turnstile verification hook (for tests or Cloudflare siteverify override). */
  verifyTurnstile?: TurnstileVerifyFn;
  /** Cloudflare Turnstile secret key (used if `verifyTurnstile` omitted). */
  turnstileSecretKey?: string;
  /** Explicitly allow missing Turnstile secret bypass (only for local Dev). */
  allowTurnstileDevBypass?: boolean;
  /** Refresh cookie TTL in seconds (default 30 days). */
  refreshTtlSeconds?: number;
  /** Set `Secure` attribute on refresh cookie (default `issuer.startsWith("https://")`). */
  cookieSecure?: boolean;
  /** Allow cookie auth rate limits overrides (primarily for automated tests). */
  rateLimits?: {
    guestMaxPerMinute?: number;
    authWriteMaxPerMinute?: number;
    refreshMaxPerMinute?: number;
  };
  /** Custom logger instance. */
  log?: winston.Logger;
}

export interface AuthAppHandle {
  app: express.Express;
  keyManager: KeyManager;
  store: AuthStore;
  close: () => void;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const rawVal = part.slice(eqIndex + 1).trim();
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

function serializeRefreshCookie(
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.header("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

function isValidUsernameInput(raw: string): {
  valid: boolean;
  reason?: string;
} {
  const trimmed = raw.trim();
  if (!USERNAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      reason:
        "Username must be 2-20 characters and contain only letters, numbers, spaces, or underscores.",
    };
  }
  return { valid: true };
}

function isValidEmail(raw: string): boolean {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_REGEX.test(email);
}

function buildDefaultAllowedOrigins(
  issuer: string,
  audience: string,
): Set<string> {
  const origins = new Set<string>(["http://localhost:*"]);
  try {
    origins.add(new URL(issuer).origin);
  } catch {
    // Ignore non-URL issuer overrides.
  }
  if (audience && audience !== "localhost") {
    origins.add(`https://${audience}`);
    origins.add(`http://${audience}`);
  }
  origins.add("http://localhost:9000");
  origins.add("http://localhost:3000");
  origins.add("http://127.0.0.1:9000");
  origins.add("http://127.0.0.1:3000");
  return origins;
}

export async function createAuthApp(
  options: AuthAppOptions,
): Promise<AuthAppHandle> {
  const log = (options.log ?? logger).child({ component: "AuthService" });
  const dataDir =
    options.dataDir ?? path.join(process.cwd(), "data", "frontierx-auth");
  const refreshTtlSeconds = options.refreshTtlSeconds ?? 30 * 24 * 3600;
  const cookieSecure =
    options.cookieSecure ?? options.issuer.startsWith("https://");

  const keyManager =
    options.keyManager ??
    (await KeyManager.create({
      issuer: options.issuer,
      audience: options.audience,
      keyFilePath: path.join(dataDir, "ed25519-jwk.json"),
    }));

  const store =
    options.store ??
    new AuthStore({
      dbPath: path.join(dataDir, "auth.sqlite"),
      refreshTtlSeconds,
      guestCanCreatePublicLobbies:
        process.env.AUTH_GUEST_PUBLIC_LOBBIES === "true",
      accountCanCreatePublicLobbies:
        process.env.AUTH_ACCOUNT_PUBLIC_LOBBIES !== "false",
    });

  const verifyTurnstile =
    options.verifyTurnstile ??
    createTurnstileVerifier({
      secretKey: options.turnstileSecretKey,
      allowDevBypass: options.allowTurnstileDevBypass,
    });

  const allowedOrigins = options.allowedOrigins
    ? new Set(options.allowedOrigins)
    : buildDefaultAllowedOrigins(options.issuer, options.audience);

  const guestLimiter = new SlidingWindowLimiter({
    windowMs: 60_000,
    maxRequests: options.rateLimits?.guestMaxPerMinute ?? 30,
  });
  const authWriteLimiter = new SlidingWindowLimiter({
    windowMs: 60_000,
    maxRequests: options.rateLimits?.authWriteMaxPerMinute ?? 20,
  });
  const refreshLimiter = new SlidingWindowLimiter({
    windowMs: 60_000,
    maxRequests: options.rateLimits?.refreshMaxPerMinute ?? 120,
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isOriginAllowed(origin, allowedOrigins)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const router = express.Router();

  const requireApiKey = (req: Request, res: Response): boolean => {
    const expected = options.apiKey?.trim();
    if (!expected) {
      res.status(503).json({
        error: "api_key_not_configured",
        message: "Server API key is not configured.",
      });
      return false;
    }
    const provided = req.header("x-api-key") ?? "";
    if (!provided || !timingSafeEqualStrings(provided, expected)) {
      res.status(401).json({
        error: "unauthorized_api_key",
        message: "Invalid or missing x-api-key.",
      });
      return false;
    }
    return true;
  };

  const requireCsrf = (req: Request, res: Response): boolean => {
    if (!isAllowedCookieCsrfRequest(req, allowedOrigins)) {
      res.status(403).json({
        error: "csrf_origin_denied",
        message: "Cross-site cookie mutation rejected.",
      });
      return false;
    }
    return true;
  };

  const setRefreshCookie = (res: Response, token: string): void => {
    res.setHeader(
      "Set-Cookie",
      serializeRefreshCookie(token, refreshTtlSeconds, cookieSecure),
    );
  };

  const clearRefreshCookie = (res: Response): void => {
    res.setHeader("Set-Cookie", serializeRefreshCookie("", 0, cookieSecure));
  };

  const resolveUserFromBearer = async (
    req: Request,
    res: Response,
  ): Promise<StoredUser | null> => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "missing_bearer_token" });
      return null;
    }
    try {
      const claims = await keyManager.verifyAccessToken(token);
      const user = store.getUserByUuid(claims.sub);
      if (!user) {
        res.status(401).json({ error: "unknown_user" });
        return null;
      }
      return user;
    } catch (error) {
      res.status(401).json({
        error: "invalid_token",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const resolveOptionalGuestUuid = async (
    req: Request,
  ): Promise<string | undefined> => {
    const token = extractBearerToken(req);
    if (token) {
      try {
        const claims = await keyManager.verifyAccessToken(token);
        const existing = store.getUserByUuid(claims.sub);
        if (
          existing &&
          existing.accountType === "guest" &&
          !isUserBanned(existing)
        ) {
          return existing.uuid;
        }
      } catch {
        // Ignore expired/invalid optional bearer during registration upgrade.
      }
    }
    const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      const rotated = store.rotateRefreshSession({
        refreshToken,
        userAgent: req.header("user-agent") ?? null,
        ip: getClientIp(req),
      });
      if (
        rotated.status === "ok" &&
        rotated.user.accountType === "guest" &&
        !isUserBanned(rotated.user)
      ) {
        return rotated.user.uuid;
      }
    }
    return undefined;
  };

  const issueAuthResponse = async (args: {
    req: Request;
    res: Response;
    user: StoredUser;
    familyId?: string;
    includeUser?: boolean;
    statusCode?: number;
    extra?: Record<string, unknown>;
  }): Promise<void> => {
    const session = store.issueRefreshSession({
      userUuid: args.user.uuid,
      familyId: args.familyId,
      userAgent: args.req.header("user-agent") ?? null,
      ip: getClientIp(args.req),
    });

    const signed = await keyManager.signAccessToken({
      userUuid: args.user.uuid,
      provider: args.user.provider,
      role: args.user.role ?? undefined,
    });

    args.res.setHeader("Cache-Control", "no-store");
    setRefreshCookie(args.res, session.refreshToken);

    const body: Record<string, unknown> = {
      jwt: signed.jwt,
      expiresIn: signed.expiresIn,
      accountType: args.user.accountType,
      publicId: args.user.publicId,
      ...(args.extra ?? {}),
    };
    if (args.includeUser) {
      body.user = toUserMeResponse(args.user);
    }
    args.res.status(args.statusCode ?? 200).json(body);
  };

  // --- Discovery & Health ---

  router.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(keyManager.getPublicJwks());
  });

  router.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      service: "frontierx-auth",
      issuer: keyManager.getIssuer(),
      audience: keyManager.getAudience(),
      kid: keyManager.getKid(),
    });
  });

  router.get("/auth/providers", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      providers: {
        guest: true,
        frontierx: true,
        recovery: true,
        discord: Boolean(process.env.DISCORD_CLIENT_ID),
        google: Boolean(process.env.GOOGLE_CLIENT_ID),
      },
      turnstileRequired:
        (options.turnstileSecretKey?.trim().length ?? 0) > 0 ||
        Boolean(options.verifyTurnstile),
    });
  });

  // --- Guest Provisioning & Account Lifecycle ---

  router.post(
    "/auth/guest",
    createIpRateLimitMiddleware(guestLimiter, "auth-guest"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      GuestAuthRequestSchema.parse(req.body);

      const cookies = parseCookies(req);
      const existingRefresh = cookies[REFRESH_COOKIE_NAME];
      if (existingRefresh) {
        const rotated = store.rotateRefreshSession({
          refreshToken: existingRefresh,
          userAgent: req.header("user-agent") ?? null,
          ip: getClientIp(req),
        });
        if (rotated.status === "ok") {
          if (isUserBanned(rotated.user)) {
            clearRefreshCookie(res);
            res.status(403).json({
              error: "account_banned",
              message: rotated.user.banReason ?? "Account is banned.",
            });
            return;
          }
          const signed = await keyManager.signAccessToken({
            userUuid: rotated.user.uuid,
            provider: rotated.user.provider,
            role: rotated.user.role ?? undefined,
          });
          res.setHeader("Cache-Control", "no-store");
          setRefreshCookie(res, rotated.session.refreshToken);
          res.status(200).json({
            jwt: signed.jwt,
            expiresIn: signed.expiresIn,
            accountType: rotated.user.accountType,
            publicId: rotated.user.publicId,
          });
          return;
        }
      }

      const guest = store.createGuestUser();
      await issueAuthResponse({
        req,
        res,
        user: guest,
        statusCode: 201,
      });
    },
  );

  router.post(
    "/auth/register",
    createIpRateLimitMiddleware(authWriteLimiter, "auth-register"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      const parsed = RegisterRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          message: "Valid email and password (8-128 chars) are required.",
        });
        return;
      }

      if (!isValidEmail(parsed.data.email)) {
        res.status(400).json({
          error: "invalid_email",
          message: "Please enter a valid email address.",
        });
        return;
      }

      if (parsed.data.username) {
        const nameCheck = isValidUsernameInput(parsed.data.username);
        if (!nameCheck.valid) {
          res.status(400).json({
            error: "invalid_username",
            message: nameCheck.reason,
          });
          return;
        }
        if (profanityMatcher.hasMatch(parsed.data.username)) {
          res.status(400).json({
            error: "profane_username",
            code: "USERNAME_PROFANE",
            message: "Username contains prohibited language.",
          });
          return;
        }
      }

      const upgradeGuestUuid = await resolveOptionalGuestUuid(req);
      const created = store.registerAccount({
        email: parsed.data.email,
        password: parsed.data.password,
        upgradeGuestUuid,
        usernameBase: parsed.data.username ?? null,
      });

      if (created.status === "email_taken") {
        res.status(409).json({
          error: "email_taken",
          message: "An account with this email already exists.",
        });
        return;
      }

      await issueAuthResponse({
        req,
        res,
        user: created.user,
        includeUser: true,
        statusCode: 201,
        extra: { upgradedFromGuest: created.upgradedFromGuest },
      });
    },
  );

  router.post(
    "/auth/login",
    createIpRateLimitMiddleware(authWriteLimiter, "auth-login"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      const parsed = LoginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          message: "Email and password are required.",
        });
        return;
      }

      const emailLimit = authWriteLimiter.consume(
        `auth-login-email:${parsed.data.email.trim().toLowerCase()}`,
      );
      if (!emailLimit.allowed) {
        res.setHeader("Retry-After", String(emailLimit.retryAfterSeconds));
        res.status(429).json({
          error: "rate_limit_exceeded",
          message: "Too many login attempts for this account.",
        });
        return;
      }

      const user = store.authenticateAccount(
        parsed.data.email,
        parsed.data.password,
      );
      if (!user) {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Incorrect email or password.",
        });
        return;
      }

      if (isUserBanned(user)) {
        clearRefreshCookie(res);
        res.status(403).json({
          error: "account_banned",
          message: user.banReason ?? "Account is banned.",
        });
        return;
      }

      await issueAuthResponse({
        req,
        res,
        user,
        includeUser: true,
        statusCode: 200,
      });
    },
  );

  router.post(
    "/auth/refresh",
    createIpRateLimitMiddleware(refreshLimiter, "auth-refresh"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      res.setHeader("Cache-Control", "no-store");

      const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
      if (!refreshToken) {
        res.status(401).json({ error: "missing_refresh_token" });
        return;
      }

      const rotated = store.rotateRefreshSession({
        refreshToken,
        userAgent: req.header("user-agent") ?? null,
        ip: getClientIp(req),
      });

      if (rotated.status === "reused") {
        clearRefreshCookie(res);
        log.warn("Refresh token reuse detected; session family revoked", {
          userUuid: rotated.userUuid,
          familyId: rotated.familyId,
          ip: getClientIp(req),
        });
        res.status(401).json({ error: "refresh_token_reused" });
        return;
      }

      if (rotated.status === "invalid") {
        clearRefreshCookie(res);
        res.status(401).json({ error: "invalid_refresh_token" });
        return;
      }

      if (isUserBanned(rotated.user)) {
        store.revokeAllUserSessions(rotated.user.uuid);
        clearRefreshCookie(res);
        res.status(403).json({
          error: "account_banned",
          message: rotated.user.banReason ?? "Account is banned.",
        });
        return;
      }

      const signed = await keyManager.signAccessToken({
        userUuid: rotated.user.uuid,
        provider: rotated.user.provider,
        role: rotated.user.role ?? undefined,
      });

      setRefreshCookie(res, rotated.session.refreshToken);
      res.status(200).json({
        jwt: signed.jwt,
        expiresIn: signed.expiresIn,
      });
    },
  );

  router.post("/auth/logout", (req, res) => {
    if (!requireCsrf(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      store.revokeRefreshToken(refreshToken);
    }
    clearRefreshCookie(res);
    res.status(200).json({ ok: true });
  });

  router.post("/auth/revoke", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    res.setHeader("Cache-Control", "no-store");

    let targetUuid: string | null = null;
    const token = extractBearerToken(req);
    if (token) {
      try {
        const claims = await keyManager.verifyAccessToken(token);
        targetUuid = claims.sub;
      } catch {
        // Fall through to refresh cookie check.
      }
    }

    const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
    if (!targetUuid && refreshToken) {
      const rotated = store.rotateRefreshSession({
        refreshToken,
        userAgent: req.header("user-agent") ?? null,
        ip: getClientIp(req),
      });
      if (rotated.status === "ok") {
        targetUuid = rotated.user.uuid;
      }
    }

    clearRefreshCookie(res);
    if (!targetUuid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const revokedSessions = store.revokeAllUserSessions(targetUuid);
    res.status(200).json({ ok: true, revokedSessions });
  });

  router.post(
    "/auth/recovery-code",
    createIpRateLimitMiddleware(authWriteLimiter, "auth-recovery-code"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      res.setHeader("Cache-Control", "no-store");
      const user = await resolveUserFromBearer(req, res);
      if (!user) return;
      if (isUserBanned(user)) {
        res.status(403).json({
          error: "account_banned",
          message: user.banReason ?? "Account is banned.",
        });
        return;
      }
      const created = store.createRecoveryCode(user.uuid);
      res.status(201).json({
        recoveryCode: created.recoveryCode,
        expiresAt: new Date(created.expiresAt).toISOString(),
      });
    },
  );

  router.post(
    "/auth/recover",
    createIpRateLimitMiddleware(authWriteLimiter, "auth-recover"),
    async (req, res) => {
      if (!requireCsrf(req, res)) return;
      res.setHeader("Cache-Control", "no-store");
      const parsed = RecoverRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          message: "A valid recovery code is required.",
        });
        return;
      }
      const redeemed = store.redeemRecoveryCode({
        recoveryCode: parsed.data.recoveryCode,
        userAgent: req.header("user-agent") ?? null,
        ip: getClientIp(req),
      });
      if (redeemed.status !== "ok") {
        res.status(401).json({
          error: "invalid_recovery_code",
          message: "Recovery code is invalid or already used.",
        });
        return;
      }
      if (isUserBanned(redeemed.user)) {
        store.revokeAllUserSessions(redeemed.user.uuid);
        clearRefreshCookie(res);
        res.status(403).json({
          error: "account_banned",
          message: redeemed.user.banReason ?? "Account is banned.",
        });
        return;
      }

      const signed = await keyManager.signAccessToken({
        userUuid: redeemed.user.uuid,
        provider: redeemed.user.provider,
        role: redeemed.user.role ?? undefined,
      });
      setRefreshCookie(res, redeemed.session.refreshToken);
      res.status(200).json({
        jwt: signed.jwt,
        expiresIn: signed.expiresIn,
        accountType: redeemed.user.accountType,
        publicId: redeemed.user.publicId,
        user: toUserMeResponse(redeemed.user),
      });
    },
  );

  // --- User Endpoints ---

  router.get("/users/@me", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = await resolveUserFromBearer(req, res);
    if (!user) return;
    res.status(200).json(toUserMeResponse(user));
  });

  router.delete("/users/@me", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const user = await resolveUserFromBearer(req, res);
    if (!user) return;
    store.deleteUser(user.uuid);
    clearRefreshCookie(res);
    res.status(200).json({ ok: true });
  });

  router.put("/users/@me/username", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const user = await resolveUserFromBearer(req, res);
    if (!user) return;
    if (isUserBanned(user)) {
      res.status(403).json({ error: "account_banned" });
      return;
    }

    const parsed = UpdateUsernameRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_username",
        reason:
          "Username must be 2-20 characters and contain only letters, numbers, spaces, or underscores.",
      });
      return;
    }

    const check = isValidUsernameInput(parsed.data.username);
    if (!check.valid) {
      res.status(400).json({
        error: "invalid_username",
        reason: check.reason,
      });
      return;
    }

    if (profanityMatcher.hasMatch(parsed.data.username)) {
      res.status(400).json({
        code: "USERNAME_PROFANE",
        reason: "Username contains prohibited language.",
      });
      return;
    }

    const updated = store.updateUsername(
      user.uuid,
      parsed.data.username.trim(),
    );
    if (updated.status === "cooldown") {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((updated.nextUsernameChangeAt - Date.now()) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "username_cooldown" });
      return;
    }
    if (updated.status !== "ok") {
      res.status(404).json({ error: "unknown_user" });
      return;
    }

    const displayUsername =
      formatDisplayUsername(updated.user) ?? parsed.data.username.trim();
    res.status(200).json({
      username: displayUsername,
      base: updated.user.usernameBase ?? parsed.data.username.trim(),
      discriminator: updated.user.usernameDiscriminator ?? "0000",
      usernameStatus: updated.user.usernameStatus ?? "unclaimed",
      nextUsernameChangeAt:
        updated.user.nextUsernameChangeAt !== null
          ? new Date(updated.user.nextUsernameChangeAt).toISOString()
          : null,
    });
  });

  // --- Worker Verification & Privilege Feeds ---

  router.post("/join_verify", async (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.setHeader("Cache-Control", "no-store");

    const parsed = JoinVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        status: "rejected",
        reason: "invalid_join_verify_payload",
      });
      return;
    }

    const { token, ip, username, clanTag } = parsed.data;
    if (token !== null) {
      const turnstile = await verifyTurnstile({
        token,
        ip: ip ?? null,
      });
      if (!turnstile.ok) {
        res.status(200).json({
          status: "rejected",
          reason: turnstile.reason ?? "turnstile_failed",
        });
        return;
      }
    }

    const censored = censorPlayer(username, clanTag ?? null);
    res.status(200).json({
      status: "approved",
      username: censored.username,
      clanTag: censored.clanTag,
    });
  });

  router.get("/cosmetics.json", (_req, res) => {
    res.json({ patterns: {}, flags: {} });
  });

  router.get("/reserved_clan_tags", (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json([]);
  });

  router.post("/custom_tribes", (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json({ tribes: [] });
  });

  // --- Game Archive & Non-Auth Support Endpoints ---

  router.post("/game/:id", (req, res) => {
    if (!requireApiKey(req, res)) return;
    const gameId = String(req.params.id ?? "").trim();
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(gameId)) {
      res.status(400).json({ error: "invalid_game_id" });
      return;
    }
    store.saveArchivedGame(gameId, JSON.stringify(req.body ?? {}), null);
    res.status(200).json({ ok: true });
  });

  router.get("/game/:id", (req, res) => {
    if (!requireApiKey(req, res)) return;
    const gameId = String(req.params.id ?? "").trim();
    const raw = store.getArchivedGame(gameId);
    if (!raw) {
      res.status(404).json({ error: "game_not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(raw);
  });

  router.post("/archive_singleplayer_game", async (req, res) => {
    const user = await resolveUserFromBearer(req, res);
    if (!user) return;
    const body = req.body as { gameID?: unknown } | undefined;
    const gameId =
      typeof body?.gameID === "string"
        ? body.gameID.trim()
        : `sp-${Date.now()}`;
    store.saveArchivedGame(
      gameId,
      JSON.stringify(req.body ?? {}),
      user.publicId,
    );
    res.status(200).json({ ok: true });
  });

  router.post("/matchmaking/checkin", (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.status(200).json({ assignment: null });
  });

  router.get("/news.json", (_req, res) => {
    res.json([]);
  });

  router.get("/streams.json", (_req, res) => {
    res.json({
      verifiedAt: "1970-01-01T00:00:00.000Z",
      featured: [],
      live: [],
    });
  });

  // Mount at both root and `/api` so both direct calls (`http://localhost:8787/*`)
  // and reverse-proxy setups that retain or strip `/api` resolve identically.
  app.use("/", router);
  app.use("/api", router);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return {
    app,
    keyManager,
    store,
    close: () => {
      store.close();
    },
  };
}
