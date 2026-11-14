// @vitest-environment node
import fs from "fs";
import http from "http";
import { generateKeyPair, SignJWT } from "jose";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthApp, type AuthAppHandle } from "../../src/auth/AuthApp";
import { AuthStore } from "../../src/auth/AuthStore";
import { KeyManager } from "../../src/auth/KeyManager";
import {
  PutUsernameResponseSchema,
  TokenPayloadSchema,
  UserMeResponseSchema,
} from "../../src/core/ApiSchemas";
import { uuidToBase64url } from "../../src/core/Base64";
import { ReservedClanTagsResponseSchema } from "../../src/core/ClanApiSchemas";
import { CosmeticsSchema } from "../../src/core/CosmeticSchemas";

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

describe("FrontierX AuthService", () => {
  let tempDir: string;
  let server: http.Server;
  let baseUrl: string;
  let auth: AuthAppHandle;
  const audience = "openfront-2.duckdns.org";
  const issuer = `https://${audience}/api`;
  const serverApiKey = "test-internal-api-key-123456";

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontierx-auth-test-"));
    const keyManager = await KeyManager.create({
      issuer,
      audience,
      keyFilePath: path.join(tempDir, "ed25519-jwk.json"),
    });
    const store = new AuthStore({
      dbPath: path.join(tempDir, "auth.sqlite"),
      guestCanCreatePublicLobbies: false,
      accountCanCreatePublicLobbies: true,
    });
    auth = await createAuthApp({
      issuer,
      audience,
      apiKey: serverApiKey,
      keyManager,
      store,
      dataDir: tempDir,
      allowedOrigins: [`https://${audience}`, "http://localhost:*"],
      verifyTurnstile: async ({ token }) => {
        if (token === "VALID_TURNSTILE_TOKEN") {
          return { ok: true };
        }
        return { ok: false, reason: "invalid-input-response" };
      },
      rateLimits: {
        guestMaxPerMinute: 100,
        authWriteMaxPerMinute: 100,
        refreshMaxPerMinute: 200,
      },
    });
    server = http.createServer(auth.app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected server port");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes EdDSA JWKS and health endpoints", async () => {
    const jwksRes = await fetch(`${baseUrl}/.well-known/jwks.json`);
    expect(jwksRes.status).toBe(200);
    const jwks = (await jwksRes.json()) as {
      keys: Array<{ alg: string; crv: string; kty: string; kid: string }>;
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      alg: "EdDSA",
      crv: "Ed25519",
      kty: "OKP",
    });

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({
      status: "ok",
      service: "frontierx-auth",
      issuer,
      audience,
    });
  });

  it("provisions server-signed guest sessions, rotates refresh cookies, and detects replay reuse", async () => {
    const guestRes = await fetch(`${baseUrl}/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(guestRes.status).toBe(201);
    const guestSetCookies = guestRes.headers.getSetCookie();
    expect(guestSetCookies.some((c) => c.includes("HttpOnly"))).toBe(true);
    expect(guestSetCookies.some((c) => c.includes("SameSite=Lax"))).toBe(true);

    const refreshCookie1 = extractCookieValue(guestSetCookies, "fx_refresh");
    expect(refreshCookie1).toBeTruthy();

    const guestBody = (await guestRes.json()) as {
      jwt: string;
      expiresIn: number;
      accountType: string;
      publicId: string;
    };
    expect(guestBody.accountType).toBe("guest");
    expect(guestBody.expiresIn).toBe(900);

    const claims = await auth.keyManager.verifyAccessToken(guestBody.jwt);
    expect(TokenPayloadSchema.safeParse(claims).success).toBe(true);
    expect(claims.iss).toBe(issuer);
    expect(claims.aud).toBe(audience);
    expect(claims.provider).toBe("guest");

    const meRes = await fetch(`${baseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${guestBody.jwt}` },
    });
    expect(meRes.status).toBe(200);
    const meJson = UserMeResponseSchema.parse(await meRes.json());
    expect(meJson.player.publicId).toBe(guestBody.publicId);
    expect(meJson.player.canCreatePublicLobbies).toBe(false);

    // Rotate refresh token once cleanly.
    const refreshRes1 = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${refreshCookie1}` },
    });
    expect(refreshRes1.status).toBe(200);
    const refreshCookie2 = extractCookieValue(
      refreshRes1.headers.getSetCookie(),
      "fx_refresh",
    );
    expect(refreshCookie2).toBeTruthy();
    expect(refreshCookie2).not.toBe(refreshCookie1);

    // Replay the already-spent cookie: must trigger family revocation and return 401.
    const replayRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${refreshCookie1}` },
    });
    expect(replayRes.status).toBe(401);
    expect(await replayRes.json()).toMatchObject({
      error: "refresh_token_reused",
    });

    // Even the previously-issued valid token #2 in the compromised family is now revoked!
    const followUpRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${refreshCookie2}` },
    });
    expect(followUpRes.status).toBe(401);
  });

  it("upgrades guest accounts to persistent FrontierX accounts preserving publicId/sub and supports login, logout, username, and delete", async () => {
    const guestRes = await fetch(`${baseUrl}/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const guestBody = (await guestRes.json()) as {
      jwt: string;
      publicId: string;
    };
    const guestClaims = await auth.keyManager.verifyAccessToken(guestBody.jwt);

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guestBody.jwt}`,
      },
      body: JSON.stringify({
        email: "Commander@FrontierX.Test",
        password: "StrongPassword!123",
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as {
      jwt: string;
      upgradedFromGuest: boolean;
      publicId: string;
      user: unknown;
    };
    expect(regBody.upgradedFromGuest).toBe(true);
    expect(regBody.publicId).toBe(guestBody.publicId);

    const regClaims = await auth.keyManager.verifyAccessToken(regBody.jwt);
    expect(regClaims.sub).toBe(guestClaims.sub);

    // Duplicate email rejected with 409
    const dupRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "commander@frontierx.test",
        password: "StrongPassword!123",
      }),
    });
    expect(dupRes.status).toBe(409);

    // Update username
    const putNameRes = await fetch(`${baseUrl}/users/@me/username`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${regBody.jwt}`,
      },
      body: JSON.stringify({ username: "VanguardOne" }),
    });
    expect(putNameRes.status).toBe(200);
    const parsedName = PutUsernameResponseSchema.parse(await putNameRes.json());
    expect(parsedName.base).toBe("VanguardOne");
    expect(parsedName.username).toMatch(/^VanguardOne\.\d{4}$/);

    // Wrong password rejected with 401
    const badLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "commander@frontierx.test",
        password: "WrongPassword!999",
      }),
    });
    expect(badLogin.status).toBe(401);

    // Valid login succeeds and preserves identity
    const goodLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "commander@frontierx.test",
        password: "StrongPassword!123",
      }),
    });
    expect(goodLogin.status).toBe(200);
    const loginBody = (await goodLogin.json()) as {
      jwt: string;
      publicId: string;
      user: unknown;
    };
    expect(loginBody.publicId).toBe(guestBody.publicId);
    const loginMe = UserMeResponseSchema.parse(loginBody.user);
    expect(loginMe.user.email).toBe("commander@frontierx.test");
    expect(loginMe.player.canCreatePublicLobbies).toBe(true);

    const loginCookie = extractCookieValue(
      goodLogin.headers.getSetCookie(),
      "fx_refresh",
    );
    expect(loginCookie).toBeTruthy();

    // Logout revokes session
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${loginCookie}` },
    });
    expect(logoutRes.status).toBe(200);
    const afterLogoutRefresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${loginCookie}` },
    });
    expect(afterLogoutRefresh.status).toBe(401);

    // Delete account clears user
    const deleteRes = await fetch(`${baseUrl}/users/@me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${loginBody.jwt}` },
    });
    expect(deleteRes.status).toBe(200);
    const postDeleteMe = await fetch(`${baseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${loginBody.jwt}` },
    });
    expect(postDeleteMe.status).toBe(401);
  });

  it("supports single-use recovery codes and enforces bans, CSRF Origin, forged JWTs, and API keys", async () => {
    const guestRes = await fetch(`${baseUrl}/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const guestBody = (await guestRes.json()) as {
      jwt: string;
      publicId: string;
    };
    const guestClaims = await auth.keyManager.verifyAccessToken(guestBody.jwt);

    const codeRes = await fetch(`${baseUrl}/auth/recovery-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${guestBody.jwt}` },
    });
    expect(codeRes.status).toBe(201);
    const { recoveryCode } = (await codeRes.json()) as { recoveryCode: string };
    expect(recoveryCode).toMatch(/^FXREC-/);

    const recoverRes = await fetch(`${baseUrl}/auth/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode }),
    });
    expect(recoverRes.status).toBe(200);
    const recoveredBody = (await recoverRes.json()) as {
      jwt: string;
      publicId: string;
    };
    expect(recoveredBody.publicId).toBe(guestBody.publicId);

    // Recovery code is single-use
    const reuseCodeRes = await fetch(`${baseUrl}/auth/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode }),
    });
    expect(reuseCodeRes.status).toBe(401);

    // CSRF Origin guard rejects cross-site cookie mutations
    const csrfRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        cookie: "fx_refresh=anything",
      },
    });
    expect(csrfRes.status).toBe(403);

    // Forged Ed25519 JWT rejected at /users/@me
    const rogue = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forgedJwt = await new SignJWT({
      jti: "forged-1",
      sub: uuidToBase64url(guestClaims.sub),
      iss: issuer,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(rogue.privateKey);
    const forgedMeRes = await fetch(`${baseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${forgedJwt}` },
    });
    expect(forgedMeRes.status).toBe(401);

    // Ban blocks /auth/refresh and surfaces ban in /users/@me
    const recoveredCookie = extractCookieValue(
      recoverRes.headers.getSetCookie(),
      "fx_refresh",
    );
    auth.store.setUserBan(guestClaims.sub, {
      category: "cheating",
      reason: "Automated ban enforcement check",
      expiresAt: null,
    });
    const bannedMeRes = await fetch(`${baseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${recoveredBody.jwt}` },
    });
    expect(bannedMeRes.status).toBe(200);
    const bannedMe = UserMeResponseSchema.parse(await bannedMeRes.json());
    expect(bannedMe.ban?.category).toBe("cheating");

    const bannedRefresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `fx_refresh=${recoveredCookie}` },
    });
    expect(bannedRefresh.status).toBe(403);

    // /join_verify requires valid x-api-key, checks Turnstile, and censors slurs
    const unauthJoinVerify = await fetch(`${baseUrl}/join_verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ip: "127.0.0.1",
        token: "VALID_TURNSTILE_TOKEN",
        username: "PlayerOne",
      }),
    });
    expect(unauthJoinVerify.status).toBe(401);

    const rejectedJoinVerify = await fetch(`${baseUrl}/join_verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": serverApiKey,
      },
      body: JSON.stringify({
        ip: "127.0.0.1",
        token: "BAD_TOKEN",
        username: "PlayerOne",
      }),
    });
    expect(rejectedJoinVerify.status).toBe(200);
    expect(await rejectedJoinVerify.json()).toMatchObject({
      status: "rejected",
    });

    const approvedJoinVerify = await fetch(`${baseUrl}/join_verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": serverApiKey,
      },
      body: JSON.stringify({
        ip: "127.0.0.1",
        token: "VALID_TURNSTILE_TOKEN",
        username: "FrontierPilot",
        clanTag: "frx",
      }),
    });
    expect(approvedJoinVerify.status).toBe(200);
    expect(await approvedJoinVerify.json()).toEqual({
      status: "approved",
      username: "FrontierPilot",
      clanTag: "FRX",
    });

    // Privilege endpoints match Worker schemas
    const cosmeticsRes = await fetch(`${baseUrl}/cosmetics.json`, {
      headers: { "x-api-key": serverApiKey },
    });
    expect(cosmeticsRes.status).toBe(200);
    expect(CosmeticsSchema.safeParse(await cosmeticsRes.json()).success).toBe(
      true,
    );

    const tagsRes = await fetch(`${baseUrl}/reserved_clan_tags`, {
      headers: { "x-api-key": serverApiKey },
    });
    expect(tagsRes.status).toBe(200);
    expect(
      ReservedClanTagsResponseSchema.safeParse(await tagsRes.json()).success,
    ).toBe(true);
  });

  it("enforces rate limits on sensitive auth endpoints and persists identities across restarts", async () => {
    const tightDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "frontierx-auth-restart-"),
    );
    try {
      const km1 = await KeyManager.create({
        issuer,
        audience,
        keyFilePath: path.join(tightDir, "ed25519-jwk.json"),
      });
      const store1 = new AuthStore({
        dbPath: path.join(tightDir, "auth.sqlite"),
      });
      const app1 = await createAuthApp({
        issuer,
        audience,
        apiKey: serverApiKey,
        keyManager: km1,
        store: store1,
        dataDir: tightDir,
        rateLimits: {
          guestMaxPerMinute: 2,
          authWriteMaxPerMinute: 5,
          refreshMaxPerMinute: 10,
        },
      });
      const s1 = http.createServer(app1.app);
      await new Promise<void>((r) => s1.listen(0, "127.0.0.1", () => r()));
      const p1 = (s1.address() as { port: number }).port;

      const r1 = await fetch(`http://127.0.0.1:${p1}/auth/guest`, {
        method: "POST",
      });
      expect(r1.status).toBe(201);
      const b1 = (await r1.json()) as { jwt: string; publicId: string };
      const c1 = extractCookieValue(r1.headers.getSetCookie(), "fx_refresh");

      const r2 = await fetch(`http://127.0.0.1:${p1}/auth/guest`, {
        method: "POST",
      });
      expect(r2.status).toBe(201);

      const r3 = await fetch(`http://127.0.0.1:${p1}/auth/guest`, {
        method: "POST",
      });
      expect(r3.status).toBe(429);
      expect(r3.headers.get("retry-after")).toBeTruthy();

      await new Promise<void>((r) => s1.close(() => r()));
      app1.close();

      // Reopen keyManager & AuthStore cleanly (simulating service restart)
      const km2 = await KeyManager.create({
        issuer,
        audience,
        keyFilePath: path.join(tightDir, "ed25519-jwk.json"),
      });
      const store2 = new AuthStore({
        dbPath: path.join(tightDir, "auth.sqlite"),
      });
      const app2 = await createAuthApp({
        issuer,
        audience,
        apiKey: serverApiKey,
        keyManager: km2,
        store: store2,
        dataDir: tightDir,
      });
      const s2 = http.createServer(app2.app);
      await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
      const p2 = (s2.address() as { port: number }).port;

      // Old JWT remains valid because Ed25519 key persisted across restart
      const meAfterRestart = await fetch(`http://127.0.0.1:${p2}/users/@me`, {
        headers: { authorization: `Bearer ${b1.jwt}` },
      });
      expect(meAfterRestart.status).toBe(200);
      expect(
        ((await meAfterRestart.json()) as { player: { publicId: string } })
          .player.publicId,
      ).toBe(b1.publicId);

      // Existing refresh session in SQLite still rotates across restart
      const refreshAfterRestart = await fetch(
        `http://127.0.0.1:${p2}/auth/refresh`,
        {
          method: "POST",
          headers: { cookie: `fx_refresh=${c1}` },
        },
      );
      expect(refreshAfterRestart.status).toBe(200);

      await new Promise<void>((r) => s2.close(() => r()));
      app2.close();
    } finally {
      fs.rmSync(tightDir, { recursive: true, force: true });
    }
  });
});
