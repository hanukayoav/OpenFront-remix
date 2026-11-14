// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import { generateKeyPair, SignJWT } from "jose";
import net from "net";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { base64urlToUuid, uuidToBase64url } from "../../src/core/Base64";

const ROOT = process.cwd();
const API_KEY = "mp-e2e-internal-api-key-987654";
const ADMIN_BOT_API_KEY = "mp-e2e-admin-bot-key-987654";
const AUDIENCE = "openfront-2.duckdns.org";
const ISSUER = `https://${AUDIENCE}/api`;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Expected numeric port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function killProcessTreeSync(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Process already exited.
  }
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  check: (res: Response) => Promise<boolean> | boolean = (res) => res.ok,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timeout";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (await check(res)) {
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url} (${lastError})`);
}

function extractCookie(res: Response, name: string): string | null {
  for (const header of res.headers.getSetCookie()) {
    const first = header.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq > 0 && first.slice(0, eq) === name) {
      return decodeURIComponent(first.slice(eq + 1));
    }
  }
  return null;
}

function workerIndexFromPath(workerPath: string): number {
  const m = /^w(\d+)$/.exec(workerPath);
  if (!m) throw new Error(`Unexpected workerPath: ${workerPath}`);
  return parseInt(m[1], 10);
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WS connect timeout: ${url}`));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WS close"));
    }, timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString("utf8") });
    });
  });
}

function waitForServerMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for WS message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      } catch {
        // Ignore malformed non-JSON test frames.
      }
    };
    ws.on("message", onMessage);
  });
}

describe("Production Multiplayer + Auth End-to-End Integration", () => {
  let tempDir: string;
  let turnstileServer: http.Server | undefined;
  let turnstilePort: number;
  let authProc: ChildProcess | undefined;
  let clusterProc: ChildProcess | undefined;
  let authPort: number;
  let masterPort: number;
  let baseUrl: string;
  const authLogs: string[] = [];
  const clusterLogs: string[] = [];
  const turnstileSecret = "mp-e2e-turnstile-secret";

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontierx-mp-e2e-"));
    authPort = await findFreePort();
    masterPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${masterPort}`;

    turnstileServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        const ok =
          form.get("secret") === turnstileSecret &&
          (form.get("response") === "ok" ||
            form.get("response") === "VALID_TEST_TURNSTILE_TOKEN");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            ok
              ? { success: true }
              : { success: false, "error-codes": ["invalid-input-response"] },
          ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      turnstileServer!.listen(0, "127.0.0.1", () => resolve()),
    );
    turnstilePort = (turnstileServer.address() as { port: number }).port;

    const tsxBin =
      process.platform === "win32"
        ? path.join(ROOT, "node_modules", ".bin", "tsx.cmd")
        : path.join(ROOT, "node_modules", ".bin", "tsx");

    authProc = spawn(tsxBin, ["src/auth/Server.ts"], {
      cwd: ROOT,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GAME_ENV: "prod",
        DOMAIN: AUDIENCE,
        AUTH_HOST: "127.0.0.1",
        AUTH_PORT: String(authPort),
        AUTH_ISSUER: ISSUER,
        AUTH_AUDIENCE: AUDIENCE,
        AUTH_DATA_DIR: tempDir,
        AUTH_ALLOWED_ORIGINS: `https://${AUDIENCE},${baseUrl}`,
        TURNSTILE_SECRET_KEY: turnstileSecret,
        TURNSTILE_SITEVERIFY_URL: `http://127.0.0.1:${turnstilePort}/siteverify`,
        API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    authProc.stdout?.on("data", (d) => authLogs.push(d.toString()));
    authProc.stderr?.on("data", (d) => authLogs.push(d.toString()));

    await waitForUrl(`http://127.0.0.1:${authPort}/health`, 15000);

    clusterProc = spawn(tsxBin, ["src/server/Server.ts"], {
      cwd: ROOT,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GAME_ENV: "prod",
        NUM_WORKERS: "2",
        PORT: String(masterPort),
        DOMAIN: AUDIENCE,
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        API_KEY,
        ADMIN_BOT_API_KEY,
        GIT_COMMIT: "testcommit",
        AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
        AUTH_INTERNAL_URL: `http://127.0.0.1:${authPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    clusterProc.stdout?.on("data", (d) => clusterLogs.push(d.toString()));
    clusterProc.stderr?.on("data", (d) => clusterLogs.push(d.toString()));

    await waitForUrl(`${baseUrl}/api/health`, 25000, async (res) => {
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === "ok";
    });
  }, 45000);

  afterAll(async () => {
    killProcessTreeSync(clusterProc?.pid);
    killProcessTreeSync(authProc?.pid);
    if (turnstileServer) {
      await new Promise<void>((resolve) =>
        turnstileServer!.close(() => resolve()),
      );
    }
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("rejects unauthorized lobby creation and forged/unsigned WebSocket joins in GAME_ENV=prod", async () => {
    // Missing Authorization header -> 400
    const noAuthRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuthRes.status).toBe(400);

    // Unsigned UUID persistent ID -> 401
    const unsignedRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer 123e4567-e89b-12d3-a456-426614174000",
      },
      body: "{}",
    });
    expect(unsignedRes.status).toBe(401);

    // Wrong-audience EdDSA token -> 401
    const rogue = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const badJwt = await new SignJWT({
      jti: "bad-1",
      sub: uuidToBase64url("123e4567-e89b-12d3-a456-426614174000"),
      iss: ISSUER,
      aud: "wrong.example.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(rogue.privateKey);
    const badJwtRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${badJwt}`,
      },
      body: "{}",
    });
    expect(badJwtRes.status).toBe(401);

    // Authenticated guest provisions valid game first so WS connects to a live worker
    const gRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: "VALID_TEST_TURNSTILE_TOKEN" }),
    });
    expect(gRes.status).toBe(201);
    const guest = (await gRes.json()) as { jwt: string };

    const createRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guest.jwt}`,
      },
      body: "{}",
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      gameID: string;
      workerPath: string;
    };
    const wIdx = workerIndexFromPath(created.workerPath);
    expect([0, 1]).toContain(wIdx);

    // Unsigned UUID WS join must be closed with 1002
    const ws = await openWs(
      `ws://127.0.0.1:${masterPort}/${created.workerPath}/`,
    );
    const closedPromise = waitForClose(ws);
    ws.send(
      JSON.stringify({
        type: "join",
        gameID: created.gameID,
        username: "RogueUnsigned",
        clanTag: null,
        cosmetics: {},
        turnstileToken: "ok",
        token: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    const closeInfo = await closedPromise;
    expect(closeInfo.code).toBe(1002);
  }, 20000);

  it("supports guest/account lobby creation, two-client WS join, public listing gating, duplicate connection handling, and reconnect with rotated JWT", async () => {
    // Provision two independent guest sessions through Master proxy (/api/auth/guest)
    const guestARes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: "VALID_TEST_TURNSTILE_TOKEN" }),
    });
    expect(guestARes.status).toBe(201);
    const guestA = (await guestARes.json()) as { jwt: string };

    const guestBRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: "VALID_TEST_TURNSTILE_TOKEN" }),
    });
    expect(guestBRes.status).toBe(201);
    const guestBCookie = extractCookie(guestBRes, "fx_refresh");
    const guestB = (await guestBRes.json()) as { jwt: string };

    // Host A creates a private game routed by Master to a ready worker
    const createRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guestA.jwt}`,
      },
      body: "{}",
    });
    expect(createRes.status).toBe(200);
    const game = (await createRes.json()) as {
      gameID: string;
      workerPath: string;
    };

    // Guest A cannot list the lobby publicly without registered account entitlement
    const guestListRes = await fetch(
      `${baseUrl}/${game.workerPath}/api/game/${game.gameID}/listing`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${guestA.jwt}`,
        },
        body: JSON.stringify({ listed: true }),
      },
    );
    expect(guestListRes.status).toBe(403);

    // Upgrade Guest A -> persistent FrontierX account (keeps creator sub identity!)
    const regARes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guestA.jwt}`,
      },
      body: JSON.stringify({
        email: `host-${Date.now()}@frontierx.test`,
        password: "HostPassword!123",
        turnstileToken: "VALID_TEST_TURNSTILE_TOKEN",
      }),
    });
    expect(regARes.status).toBe(201);
    const accountA = (await regARes.json()) as { jwt: string };

    // Upgraded Host A can now publicly list and unlist the lobby
    const listRes = await fetch(
      `${baseUrl}/${game.workerPath}/api/game/${game.gameID}/listing`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accountA.jwt}`,
        },
        body: JSON.stringify({ listed: true }),
      },
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ listed: true });

    const unlistRes = await fetch(
      `${baseUrl}/${game.workerPath}/api/game/${game.gameID}/listing`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accountA.jwt}`,
        },
        body: JSON.stringify({ listed: false }),
      },
    );
    expect(unlistRes.status).toBe(200);

    // Connect both Player A and Player B over WS through Master proxy
    const wsUrl = `ws://127.0.0.1:${masterPort}/${game.workerPath}`;
    const wsA = await openWs(wsUrl);
    const wsB = await openWs(wsUrl);

    try {
      const joinAckA = waitForServerMessage(
        wsA,
        (m) =>
          m.type === "lobby_info" ||
          m.type === "prestart" ||
          m.type === "start",
      );
      const joinAckB = waitForServerMessage(
        wsB,
        (m) =>
          m.type === "lobby_info" ||
          m.type === "prestart" ||
          m.type === "start",
      );
      const startAPromise = waitForServerMessage(
        wsA,
        (m) => m.type === "start",
        15000,
      );
      const startBPromise = waitForServerMessage(
        wsB,
        (m) => m.type === "start",
        15000,
      );

      wsA.send(
        JSON.stringify({
          type: "join",
          gameID: game.gameID,
          username: "HostAlpha",
          clanTag: null,
          turnstileToken: "ok",
          token: accountA.jwt,
        }),
      );
      wsB.send(
        JSON.stringify({
          type: "join",
          gameID: game.gameID,
          username: "PlayerBravo",
          clanTag: null,
          turnstileToken: "ok",
          token: guestB.jwt,
        }),
      );

      await Promise.all([joinAckA, joinAckB]);

      // Start the private lobby as host creator
      wsA.send(
        JSON.stringify({
          type: "intent",
          intent: { type: "toggle_game_start_timer" },
        }),
      );
      await Promise.all([startAPromise, startBPromise]);

      // Duplicate connection with Player A kicks the stale socket in prod
      const wsADup = await openWs(wsUrl);
      const oldAClose = waitForClose(wsA);
      wsADup.send(
        JSON.stringify({
          type: "join",
          gameID: game.gameID,
          username: "HostAlpha",
          clanTag: null,
          turnstileToken: "ok",
          token: accountA.jwt,
        }),
      );
      const dupClosedInfo = await oldAClose;
      expect(dupClosedInfo.code).toBeGreaterThanOrEqual(1000);

      // Simulate network drop for Player B + refresh JWT + reconnect (`type: "rejoin"`)
      wsB.close();
      const refreshBRes = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: {
          origin: baseUrl,
          cookie: `fx_refresh=${guestBCookie}`,
        },
      });
      expect(refreshBRes.status).toBe(200);
      const refreshedB = (await refreshBRes.json()) as { jwt: string };

      const wsBReconnect = await openWs(wsUrl);
      const rejoinStart = waitForServerMessage(
        wsBReconnect,
        (m) => m.type === "start" || m.type === "turn",
      );
      wsBReconnect.send(
        JSON.stringify({
          type: "rejoin",
          gameID: game.gameID,
          lastTurn: 0,
          token: refreshedB.jwt,
        }),
      );
      const recoveredMsg = await rejoinStart;
      expect(["start", "turn"]).toContain(recoveredMsg.type);

      wsADup.close();
      wsBReconnect.close();
    } finally {
      wsA.close();
      wsB.close();
    }
  }, 30000);

  it("rejects newly banned players on WebSocket join even if their cached 15m JWT has not expired yet", async () => {
    const gRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: "VALID_TEST_TURNSTILE_TOKEN" }),
    });
    expect(gRes.status).toBe(201);
    const hostGuest = (await gRes.json()) as { jwt: string };

    const gBanRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: "VALID_TEST_TURNSTILE_TOKEN" }),
    });
    expect(gBanRes.status).toBe(201);
    const bannedGuest = (await gBanRes.json()) as { jwt: string };

    const createRes = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hostGuest.jwt}`,
      },
      body: "{}",
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      gameID: string;
      workerPath: string;
    };

    // Decode sub from the un-banned guest JWT and ban them directly in SQLite
    // BEFORE expiry (simulating an admin ban issued mid-session).
    const payloadJson = JSON.parse(
      Buffer.from(bannedGuest.jwt.split(".")[1], "base64url").toString("utf8"),
    ) as { sub: string };
    const uuid = base64urlToUuid(payloadJson.sub);
    expect(uuid).toBeTruthy();

    const db = new DatabaseSync(path.join(tempDir, "auth.sqlite"), {
      timeout: 5000,
    });
    try {
      db.prepare(
        "UPDATE users SET ban_category = 'abuse', ban_reason = 'Suspended during test' WHERE uuid = ?",
      ).run(uuid!);
    } finally {
      db.close();
    }

    const ws = await openWs(
      `ws://127.0.0.1:${masterPort}/${created.workerPath}`,
    );
    const closedPromise = waitForClose(ws);
    ws.send(
      JSON.stringify({
        type: "join",
        gameID: created.gameID,
        username: "BannedPlayer",
        clanTag: null,
        turnstileToken: "ok",
        token: bannedGuest.jwt,
      }),
    );
    const closed = await closedPromise;
    expect(closed.code).toBe(1002);
    expect(closed.reason).toContain("Account Banned");
  }, 15000);
});
