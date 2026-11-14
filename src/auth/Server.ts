import * as dotenv from "dotenv";
import http from "http";
import path from "path";
import { GameEnv } from "../core/configuration/Config";
import { logger } from "../server/Logger";
import { ServerEnv } from "../server/ServerEnv";
import { createAuthApp } from "./AuthApp";
import { KeyManager } from "./KeyManager";

dotenv.config();

const log = logger.child({ component: "AuthServer" });

function nonEmptyEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim() ?? "";
  return value.length > 0 ? value : fallback;
}

export async function startAuthServer(): Promise<{
  server: http.Server;
  close: () => Promise<void>;
}> {
  const audience = nonEmptyEnv("AUTH_AUDIENCE", ServerEnv.jwtAudience());
  const issuer = nonEmptyEnv("AUTH_ISSUER", ServerEnv.jwtIssuer());
  const port = Number(process.env.AUTH_PORT ?? 8787);
  const host = nonEmptyEnv("AUTH_HOST", "127.0.0.1");
  const dataDir = nonEmptyEnv(
    "AUTH_DATA_DIR",
    path.join(process.cwd(), "data", "frontierx-auth"),
  );

  const keyFilePath = nonEmptyEnv(
    "AUTH_PRIVATE_KEY_FILE",
    path.join(dataDir, "ed25519-jwk.json"),
  );

  const keyManager = await KeyManager.create({
    issuer,
    audience,
    privateKeyPem: process.env.AUTH_PRIVATE_KEY_PEM,
    keyFilePath,
    accessTokenTtlSeconds: process.env.AUTH_ACCESS_TTL_SECONDS
      ? Number(process.env.AUTH_ACCESS_TTL_SECONDS)
      : 900,
  });

  const apiKey = process.env.API_KEY?.trim();
  const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  const isDev = ServerEnv.env() === GameEnv.Dev;
  const allowTurnstileDevBypass =
    isDev || process.env.AUTH_ALLOW_TURNSTILE_DEV_BYPASS === "true";

  if (!isDev && !apiKey) {
    log.warn(
      "API_KEY is unset; /join_verify and internal worker routes will reject requests.",
    );
  }
  if (!isDev && !turnstileSecretKey) {
    log.warn(
      "TURNSTILE_SECRET_KEY is unset; /join_verify will fail closed unless AUTH_ALLOW_TURNSTILE_DEV_BYPASS=true.",
    );
  }

  const allowedOrigins = process.env.AUTH_ALLOWED_ORIGINS
    ? process.env.AUTH_ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const authHandle = await createAuthApp({
    issuer,
    audience,
    apiKey,
    keyManager,
    dataDir,
    allowedOrigins,
    turnstileSecretKey,
    allowTurnstileDevBypass,
    log,
  });

  const pruneTimer = setInterval(
    () => {
      try {
        const deleted = authHandle.store.pruneExpiredSessions();
        if (deleted > 0) {
          log.info(`Pruned ${deleted} expired refresh sessions`);
        }
      } catch (error) {
        log.error(`Failed to prune expired sessions: ${error}`);
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
