import * as dotenv from "dotenv";
import http from "http";
import path from "path";
import { GameEnv } from "../core/configuration/Config";
import { logger } from "../server/Logger";
import { ServerEnv } from "../server/ServerEnv";
import { createAuthApp } from "./AuthApp";
import { KeyManager } from "./KeyManager";
import { createTurnstileVerifier } from "./TurnstileVerifier";

dotenv.config();

const log = logger.child({ component: "AuthServer" });

function nonEmptyEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim() ?? "";
  return value.length > 0 ? value : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

function resolveTurnstileSiteverifyUrl(): string | undefined {
  const raw = process.env.TURNSTILE_SITEVERIFY_URL?.trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  const isOfficial =
    parsed.protocol === "https:" &&
    parsed.hostname === "challenges.cloudflare.com";
  if (!isLoopback && !isOfficial) {
    throw new Error(
      `TURNSTILE_SITEVERIFY_URL must point to challenges.cloudflare.com or loopback, received "${raw}"`,
    );
  }
  return parsed.toString();
}

export async function startAuthServer(): Promise<{
  server: http.Server;
  close: () => Promise<void>;
}> {
  const audience = nonEmptyEnv("AUTH_AUDIENCE", ServerEnv.jwtAudience());
  const issuer = nonEmptyEnv("AUTH_ISSUER", ServerEnv.jwtIssuer());
  const port = parsePositiveIntEnv("AUTH_PORT", 8787);
  const host = nonEmptyEnv("AUTH_HOST", "127.0.0.1");
  const env = ServerEnv.env();
  const isDev = env === GameEnv.Dev;
  const isProd = env === GameEnv.Prod;
  const isLoopbackHost =
    host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (
    isProd &&
    !isLoopbackHost &&
    process.env.AUTH_ALLOW_NON_LOOPBACK !== "true"
  ) {
    throw new Error(
      `AUTH_HOST must bind to a loopback interface in GAME_ENV=prod, received "${host}"`,
    );
  }
  const dataDir = nonEmptyEnv(
    "AUTH_DATA_DIR",
    path.join(process.cwd(), "data", "frontierx-auth"),
  );

  const keyFilePath = nonEmptyEnv(
    "AUTH_PRIVATE_KEY_FILE",
    path.join(dataDir, "ed25519-jwk.json"),
  );

  const accessTokenTtlSeconds = parsePositiveIntEnv(
    "AUTH_ACCESS_TTL_SECONDS",
    900,
  );

  const keyManager = await KeyManager.create({
    issuer,
    audience,
    privateKeyPem: process.env.AUTH_PRIVATE_KEY_PEM,
    keyFilePath,
    accessTokenTtlSeconds,
  });

  const apiKey = process.env.API_KEY?.trim();
  const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  const requestedDevBypass =
    process.env.AUTH_ALLOW_TURNSTILE_DEV_BYPASS === "true";

  if (isProd && requestedDevBypass) {
    throw new Error(
      "AUTH_ALLOW_TURNSTILE_DEV_BYPASS=true is forbidden when GAME_ENV=prod",
    );
  }

  const allowTurnstileDevBypass = isProd ? false : isDev || requestedDevBypass;

  if (!isDev && !apiKey) {
    log.warn(
      "API_KEY is unset; /join_verify and internal worker routes will reject requests (/ready will return 503).",
    );
  }
  if (!isDev && !turnstileSecretKey) {
    log.warn(
      "TURNSTILE_SECRET_KEY is unset; guest provisioning, registration, and /join_verify will fail closed (/ready will return 503).",
    );
  }

  const allowedOrigins = process.env.AUTH_ALLOWED_ORIGINS
    ? process.env.AUTH_ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const siteverifyUrl = resolveTurnstileSiteverifyUrl();
  const verifyTurnstile = createTurnstileVerifier({
    secretKey: turnstileSecretKey,
    allowDevBypass: allowTurnstileDevBypass,
    siteverifyUrl,
  });

  const trustProxyRaw = process.env.AUTH_TRUST_PROXY?.trim();
  const trustProxy =
    trustProxyRaw === "false"
      ? false
      : trustProxyRaw && trustProxyRaw.length > 0
        ? trustProxyRaw
        : "loopback";

  const authHandle = await createAuthApp({
    issuer,
    audience,
    apiKey,
    keyManager,
    dataDir,
    allowedOrigins,
    verifyTurnstile,
    turnstileSecretKey,
    allowTurnstileDevBypass,
    isProd,
    trustProxy,
    trustCloudflareHeader: process.env.AUTH_TRUST_CF_CONNECTING_IP === "true",
    log,
  });

  const pruneTimer = setInterval(
    () => {
      try {
        const deleted = authHandle.store.pruneExpiredSessions();
        const prunedArchives = authHandle.store.pruneOldArchives();
        if (deleted > 0 || prunedArchives > 0) {
          log.info(
            `Pruned ${deleted} expired refresh sessions and ${prunedArchives} expired game archives`,
          );
        }
      } catch (error) {
        log.error(`Failed during scheduled SQLite pruning: ${error}`);
      }
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref();

  const server = http.createServer(authHandle.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  log.info(`FrontierX Auth listening on http://${host}:${port}`, {
    nodeVersion: process.versions.node,
    env,
    issuer,
    audience,
    kid: keyManager.getKid(),
    dataDir,
  });

  const close = async () => {
    clearInterval(pruneTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    authHandle.close();
  };

  return { server, close };
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith(path.join("auth", "Server.ts"));

if (isEntrypoint) {
  startAuthServer()
    .then(({ close }) => {
      const shutdown = (signal: string) => {
        log.info(`Shutting down FrontierX Auth on ${signal}`);
        void close().finally(() => process.exit(0));
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      log.error(`Failed to start FrontierX Auth server: ${error}`);
      process.exit(1);
    });
}
