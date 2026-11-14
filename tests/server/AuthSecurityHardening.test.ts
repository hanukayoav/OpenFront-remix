// @vitest-environment node
import fs from "fs";
import http from "http";
import { SignJWT } from "jose";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthApp, type AuthAppHandle } from "../../src/auth/AuthApp";
import {
  AuthStore,
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
} from "../../src/auth/AuthStore";
import { KeyManager } from "../../src/auth/KeyManager";
import { startAuthServer } from "../../src/auth/Server";
import { uuidToBase64url } from "../../src/core/Base64";
import { ServerEnv } from "../../src/server/ServerEnv";
import { verifyClientToken } from "../../src/server/jwt";

function extractCookieValue(
  setCookieHeaders: string[],
  name: string,
): string | null {
  for (const header of setCookieHeaders) {
    const firstSegment = header.split(";")[0]?.trim() ?? "";
    const eqIndex = firstSegment.indexOf("=");
    if (eqIndex <= 0) continue;
    if (firstSegment.slice(0, eqIndex) === name) {
      return decodeURIComponent(firstSegment.slice(eqIndex + 1));
    }
  }
  return null;
}

describe("FrontierX Auth Security Hardening Regressions (Mission 22.7)", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "frontierx-sec-hardening-"),
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("supports controlled multi-key Ed25519 JWKS rotation in both KeyManager and ServerEnv/verifyClientToken", async () => {
    const rotDir = path.join(tempDir, "key-rot");
    const keyFilePath = path.join(rotDir, "ed25519-jwk.json");
    const audience = "openfront-2.duckdns.org";
    const issuer = `https://${audience}/api`;

    const km1 = await KeyManager.create({
      issuer,
      audience,
      keyFilePath,
    });
    const oldKid = km1.getKid();
    const userUuid = "11111111-2222-4333-8444-555555555555";
    const oldJwt = await km1.signAccessToken({
      userUuid,
      provider: "frontierx",
    });

    const rotated = await KeyManager.rotateKeyFile(keyFilePath, 2);
    expect(rotated.currentKid).not.toBe(oldKid);

    const km2 = await KeyManager.create({
      issuer,
      audience,
      keyFilePath,
    });
    expect(km2.getKid()).toBe(rotated.currentKid);
    expect(km2.getPublicJwks().keys).toHaveLength(2);

    const newJwt = await km2.signAccessToken({
      userUuid,
      provider: "frontierx",
    });

    // KeyManager verifies BOTH old still-valid tokens and newly signed tokens
    const verifiedOld = await km2.verifyAccessToken(oldJwt.jwt);
    const verifiedNew = await km2.verifyAccessToken(newJwt.jwt);
    expect(verifiedOld.sub).toBe(userUuid);
    expect(verifiedNew.sub).toBe(userUuid);

    // Worker ServerEnv + verifyClientToken verifies BOTH via JWKS endpoint too
    const app = await createAuthApp({
      issuer,
      audience,
      keyManager: km2,
      dataDir: rotDir,
      apiKey: "rot-api-key",
      verifyTurnstile: async () => ({ ok: true }),
    });
    const srv = http.createServer(app.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;

    const origEnv = { ...process.env };
    try {
      process.env.GAME_ENV = "prod";
      process.env.DOMAIN = audience;
      process.env.AUTH_INTERNAL_URL = `http://127.0.0.1:${port}`;
      ServerEnv.reset();

      const wOld = await verifyClientToken(oldJwt.jwt);
      const wNew = await verifyClientToken(newJwt.jwt);
      expect(wOld.type).toBe("success");
      expect(wNew.type).toBe("success");
      if (wOld.type === "success") {
        expect(wOld.persistentId).toBe(userUuid);
      }

      // Expired / wrong-kid / forged JWT fails cleanly
      const forgedJwt = await new SignJWT({
        sub: uuidToBase64url(userUuid),
        iss: issuer,
        aud: audience,
        jti: "bad-jti",
      })
        .setProtectedHeader({ alg: "none", kid: oldKid })
        .sign(new Uint8Array(0))
        .catch(() => "invalid.jwt.token");
      const wBad = await verifyClientToken(forgedJwt);
      expect(wBad.type).toBe("error");
    } finally {
      process.env = origEnv;
      ServerEnv.reset();
      await new Promise<void>((r) => srv.close(() => r()));
      app.close();
    }
  });

  it("ignores spoofed X-Forwarded-For / CF-Connecting-IP headers so rate limits cannot be bypassed", async () => {
    const ipDir = path.join(tempDir, "spoof-ip");
    const app = await createAuthApp({
      issuer: "https://openfront-2.duckdns.org/api",
      audience: "openfront-2.duckdns.org",
      dataDir: ipDir,
      isProd: true,
      apiKey: "test-key",
      verifyTurnstile: async ({ token }) => ({ ok: token === "ok" }),
      rateLimits: { guestMaxPerMinute: 2 },
    });
    const srv = http.createServer(app.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;

    try {
      for (let i = 0; i < 2; i++) {
        const okRes = await fetch(`http://127.0.0.1:${port}/auth/guest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${i + 1}`,
            "cf-connecting-ip": `203.0.113.${i + 1}`,
          },
          body: JSON.stringify({ turnstileToken: "ok" }),
        });
        expect(okRes.status).toBe(201);
      }

      // With default `loopback` trustProxy (Nginx appends real client IP to X-Forwarded-For),
      // spoofing leftmost X-Forwarded-For entries or CF-Connecting-IP cannot evade the limit
      // when the rightmost untrusted hop (e.g. set by Nginx) stays constant.
      const proxyRes1 = await fetch(`http://127.0.0.1:${port}/auth/guest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.99, 203.0.113.50",
          "cf-connecting-ip": "203.0.113.99",
        },
        body: JSON.stringify({ turnstileToken: "ok" }),
      });
      expect(proxyRes1.status).toBe(201);

      const proxyRes2 = await fetch(`http://127.0.0.1:${port}/auth/guest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.123, 203.0.113.50",
          "cf-connecting-ip": "203.0.113.123",
        },
        body: JSON.stringify({ turnstileToken: "ok" }),
      });
      expect(proxyRes2.status).toBe(201);

      const proxyBlocked = await fetch(`http://127.0.0.1:${port}/auth/guest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.200, 203.0.113.50",
          "cf-connecting-ip": "203.0.113.200",
        },
        body: JSON.stringify({ turnstileToken: "ok" }),
      });
      expect(proxyBlocked.status).toBe(429);

      const directApp = await createAuthApp({
        issuer: "https://openfront-2.duckdns.org/api",
        audience: "openfront-2.duckdns.org",
        dataDir: path.join(tempDir, "spoof-ip-direct"),
        isProd: true,
        trustProxy: false,
        apiKey: "test-key",
        verifyTurnstile: async ({ token }) => ({ ok: token === "ok" }),
        rateLimits: { guestMaxPerMinute: 2 },
      });
      const directSrv = http.createServer(directApp.app);
      await new Promise<void>((r) =>
        directSrv.listen(0, "127.0.0.1", () => r()),
      );
      const dPort = (directSrv.address() as { port: number }).port;
      try {
        for (let i = 0; i < 2; i++) {
          const r = await fetch(`http://127.0.0.1:${dPort}/auth/guest`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": `198.51.100.${i + 10}`,
              "cf-connecting-ip": `203.0.113.${i + 10}`,
            },
            body: JSON.stringify({ turnstileToken: "ok" }),
          });
          expect(r.status).toBe(201);
        }
        const limited = await fetch(`http://127.0.0.1:${dPort}/auth/guest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.200",
            "cf-connecting-ip": "203.0.113.200",
          },
          body: JSON.stringify({ turnstileToken: "ok" }),
        });
        expect(limited.status).toBe(429);
      } finally {
        await new Promise<void>((r) => directSrv.close(() => r()));
        directApp.close();
      }
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      app.close();
    }
  });

  it("enforces Turnstile on guest/register (fail closed) and forbids AUTH_ALLOW_TURNSTILE_DEV_BYPASS in prod", async () => {
    const tDir = path.join(tempDir, "turnstile-prod");
    const app = await createAuthApp({
      issuer: "https://openfront-2.duckdns.org/api",
      audience: "openfront-2.duckdns.org",
      dataDir: tDir,
      isProd: true,
      // Attempt to pass dev bypass flag in prod must be ignored/disabled!
      allowTurnstileDevBypass: true,
      apiKey: "api-key",
    });
    const srv = http.createServer(app.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;

    try {
      const noTokenGuest = await fetch(`http://127.0.0.1:${port}/auth/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noTokenGuest.status).toBe(403);
      expect(await noTokenGuest.json()).toMatchObject({
        error: "turnstile_failed",
      });

      const noTokenReg = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "blocked@frontierx.test",
          password: "StrongPassword!123",
        }),
      });
      expect(noTokenReg.status).toBe(403);

      const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(readyRes.status).toBe(503);
      expect(await readyRes.json()).toMatchObject({
        status: "not_ready",
        reasons: ["turnstile_secret_missing"],
      });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      app.close();
    }

    // Server.ts startup rejects AUTH_ALLOW_TURNSTILE_DEV_BYPASS=true in GAME_ENV=prod
    const origEnv = { ...process.env };
    try {
      process.env.GAME_ENV = "prod";
      process.env.DOMAIN = "openfront-2.duckdns.org";
      process.env.AUTH_DATA_DIR = path.join(tempDir, "bypass-forbid");
      process.env.AUTH_ALLOW_TURNSTILE_DEV_BYPASS = "true";
      ServerEnv.reset();
      await expect(startAuthServer()).rejects.toThrow(/forbidden/);
    } finally {
      process.env = origEnv;
      ServerEnv.reset();
    }
  });

  it("hardens production CSRF checks, preserves guest session on failed register, revokes sessions on recovery, and blocks banned self-delete", async () => {
    const hDir = path.join(tempDir, "csrf-recovery-ban");
    const prodOrigin = "https://openfront-2.duckdns.org";
    const app: AuthAppHandle = await createAuthApp({
      issuer: `${prodOrigin}/api`,
      audience: "openfront-2.duckdns.org",
      dataDir: hDir,
      isProd: true,
      apiKey: "sec-api-key",
      verifyTurnstile: async ({ token }) => ({ ok: token === "VALID" }),
      cookieSecure: false,
    });
    const srv = http.createServer(app.app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Malformed JSON -> 400 invalid_json (never 500)
      const malformedRes = await fetch(`${baseUrl}/auth/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      });
      expect(malformedRes.status).toBe(400);
      expect(await malformedRes.json()).toMatchObject({
        error: "invalid_json",
      });

      // Seed guest A
      const gRes = await fetch(`${baseUrl}/auth/guest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: prodOrigin,
        },
        body: JSON.stringify({ turnstileToken: "VALID" }),
      });
      expect(gRes.status).toBe(201);
      const guestA = (await gRes.json()) as { jwt: string; publicId: string };
      const guestCookie = extractCookieValue(
        gRes.headers.getSetCookie(),
        "fx_refresh",
      );
      expect(guestCookie).toBeTruthy();

      // Pre-seed another user with taken email
      const takenRes = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: prodOrigin,
        },
        body: JSON.stringify({
          email: "taken@frontierx.test",
          password: "StrongPassword!123",
          turnstileToken: "VALID",
        }),
      });
      expect(takenRes.status).toBe(201);

      // Failed registration (409 email_taken) while sending Guest A cookie MUST NOT consume Guest A cookie!
      const failedUpgradeRes = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: prodOrigin,
          cookie: `fx_refresh=${guestCookie}`,
        },
        body: JSON.stringify({
          email: "taken@frontierx.test",
          password: "StrongPassword!123",
          turnstileToken: "VALID",
        }),
      });
      expect(failedUpgradeRes.status).toBe(409);

      // CSRF tests against Guest A's still-valid cookie
      const localhostCsrf = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: "http://localhost:9000",
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(localhostCsrf.status).toBe(403);

      const crossSiteCsrf = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: prodOrigin,
          "sec-fetch-site": "cross-site",
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(crossSiteCsrf.status).toBe(403);

      const untrustedSameSiteCsrf = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: "https://untrusted.openfront-2.duckdns.org",
          "sec-fetch-site": "same-site",
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(untrustedSameSiteCsrf.status).toBe(403);

      const headerlessSameSiteCsrf = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          "sec-fetch-site": "same-site",
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(headerlessSameSiteCsrf.status).toBe(403);

      const headerlessCookieReq = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(headerlessCookieReq.status).toBe(403);

      // Legitimate same-origin refresh STILL works after failed upgrade attempt!
      const legitRefresh = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: prodOrigin,
          cookie: `fx_refresh=${guestCookie}`,
        },
      });
      expect(legitRefresh.status).toBe(200);
      const guestCookie2 = extractCookieValue(
        legitRefresh.headers.getSetCookie(),
        "fx_refresh",
      )!;

      // Recovery code limit (max 1 active) and session revocation upon redeem
      const rc1Res = await fetch(`${baseUrl}/auth/recovery-code`, {
        method: "POST",
        headers: { authorization: `Bearer ${guestA.jwt}` },
      });
      expect(rc1Res.status).toBe(201);
      const rc1 = ((await rc1Res.json()) as { recoveryCode: string })
        .recoveryCode;

      const rc2Res = await fetch(`${baseUrl}/auth/recovery-code`, {
        method: "POST",
        headers: { authorization: `Bearer ${guestA.jwt}` },
      });
      expect(rc2Res.status).toBe(201);
      const rc2 = ((await rc2Res.json()) as { recoveryCode: string })
        .recoveryCode;

      // Old rc1 was invalidated when rc2 was issued
      const oldRcAttempt = await fetch(`${baseUrl}/auth/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recoveryCode: rc1 }),
      });
      expect(oldRcAttempt.status).toBe(401);

      const redeemRes = await fetch(`${baseUrl}/auth/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recoveryCode: rc2 }),
      });
      expect(redeemRes.status).toBe(200);

      // Prior refresh cookie MUST be revoked after recovery!
      const oldSessionAfterRecovery = await fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: prodOrigin,
          cookie: `fx_refresh=${guestCookie2}`,
        },
      });
      expect(oldSessionAfterRecovery.status).toBe(401);

      // Archive endpoint security (ownership, size, gameID validation, ban)
      const spOk = await fetch(`${baseUrl}/archive_singleplayer_game`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${guestA.jwt}`,
        },
        body: JSON.stringify({ gameID: "sp-valid-001", winner: "A" }),
      });
      expect(spOk.status).toBe(200);

      const spBadId = await fetch(`${baseUrl}/archive_singleplayer_game`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${guestA.jwt}`,
        },
        body: JSON.stringify({ gameID: "../bad" }),
      });
      expect(spBadId.status).toBe(400);

      // Banned user cannot archive games or self-delete account
      const guestClaims = await app.keyManager.verifyAccessToken(guestA.jwt);
      app.store.setUserBan(guestClaims.sub, {
        category: "cheating",
        reason: "Hardening ban test",
        expiresAt: null,
      });

      const bannedArchive = await fetch(
        `${baseUrl}/archive_singleplayer_game`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${guestA.jwt}`,
          },
          body: JSON.stringify({ gameID: "sp-valid-002" }),
        },
      );
      expect(bannedArchive.status).toBe(403);

      const bannedDelete = await fetch(`${baseUrl}/users/@me`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${guestA.jwt}`,
        },
      });
      expect(bannedDelete.status).toBe(403);
      expect(app.store.getUserByUuid(guestClaims.sub)).not.toBeNull();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      app.close();
    }
  });

  it("verifies async password hashing compatibility and SQLite online backup/restore persistence", async () => {
    const syncHash = hashPassword("SecretPass!99");
    expect(verifyPassword("SecretPass!99", syncHash)).toBe(true);
    expect(await verifyPasswordAsync("SecretPass!99", syncHash)).toBe(true);
    const asyncHash = await hashPasswordAsync("AsyncSecret!88");
    expect(await verifyPasswordAsync("AsyncSecret!88", asyncHash)).toBe(true);
    expect(await verifyPasswordAsync("Wrong", asyncHash)).toBe(false);

    const dbDir = path.join(tempDir, "sqlite-backup");
    fs.mkdirSync(dbDir, { recursive: true });
    const liveDbPath = path.join(dbDir, "auth.sqlite");
    const backupDbPath = path.join(dbDir, "auth.backup.sqlite");

    const store1 = new AuthStore({ dbPath: liveDbPath });
    const created = await store1.registerAccountAsync({
      email: "backup@frontierx.test",
      password: "BackupPassword!123",
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") throw new Error("expected ok");

    // Simulate live online SQLite backup while store1 is open in WAL mode
    const rawConn = new DatabaseSync(liveDbPath, { timeout: 5000 });
    try {
      rawConn.exec(`VACUUM INTO '${backupDbPath.replace(/'/g, "''")}'`);
    } finally {
      rawConn.close();
    }
    store1.close();

    const restoredStore = new AuthStore({ dbPath: backupDbPath });
    try {
      expect(restoredStore.ping()).toBe(true);
      const authUser = await restoredStore.authenticateAccountAsync(
        "backup@frontierx.test",
        "BackupPassword!123",
      );
      expect(authUser?.uuid).toBe(created.user.uuid);
    } finally {
      restoredStore.close();
    }
  });
});
