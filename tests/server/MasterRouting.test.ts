// @vitest-environment node
import express from "express";
import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createMasterApp, MasterAppOptions } from "../../src/server/Master";

interface StartedServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

async function listenExpress(app: express.Express): Promise<StartedServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected TCP server address");
  }
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("Master routing and proxy behavior", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      await cleanup();
    }
  });

  function createMockWorkerApp() {
    const workerApp = express();
    workerApp.use(express.json());
    workerApp.post("/api/create_game", (req, res) => {
      res.status(200).json({
        routedPath: req.path,
        auth: req.headers.authorization ?? null,
        body: req.body,
      });
    });
    workerApp.post("/api/adminbot/create_game", (req, res) => {
      res.status(200).json({
        routedPath: req.path,
        adminKey: req.headers["x-admin-bot-key"] ?? null,
        body: req.body,
      });
    });
    workerApp.post("/w0/api/create_game", (req, res) => {
      res.status(200).json({
        routedPath: req.path,
        body: req.body,
      });
    });
    return workerApp;
  }

  async function startMasterWithOptions(options: MasterAppOptions) {
    const { app, handleUpgrade } = createMasterApp({
      isDev: false,
      getGitCommit: () => "deadbeef1234",
      ...options,
    });
    const started = await listenExpress(app);
    started.server.on("upgrade", handleUpgrade);
    cleanups.push(started.close);
    return started;
  }

  it("streams JSON POST bodies intact for /api/create_game and /api/adminbot/create_game to ready workers", async () => {
    const worker = await listenExpress(createMockWorkerApp());
    cleanups.push(worker.close);

    const master = await startMasterWithOptions({
      numWorkers: () => 2,
      getReadyWorkerIds: () => [1],
      getWorkerTarget: (workerId) => {
        expect(workerId).toBe(1);
        return worker.url;
      },
      isClusterHealthy: () => true,
    });

    const createRes = await fetch(`${master.url}/api/create_game`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-jwt",
      },
      body: JSON.stringify({ gameConfig: { maxPlayers: 10 } }),
    });
    expect(createRes.status).toBe(200);
    expect(createRes.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    expect(await createRes.json()).toEqual({
      routedPath: "/api/create_game",
      auth: "Bearer test-jwt",
      body: { gameConfig: { maxPlayers: 10 } },
    });

    const adminRes = await fetch(`${master.url}/api/adminbot/create_game`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-bot-key": "bot-secret",
      },
      body: JSON.stringify({ config: { gameMap: "World" } }),
    });
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({
      routedPath: "/api/adminbot/create_game",
      adminKey: "bot-secret",
      body: { config: { gameMap: "World" } },
    });
  });

  it("streams JSON POST bodies through /w0/... instead of stalling on Master body parsing", async () => {
    const worker = await listenExpress(createMockWorkerApp());
    cleanups.push(worker.close);

    const master = await startMasterWithOptions({
      numWorkers: () => 2,
      getReadyWorkerIds: () => [0],
      getWorkerTarget: () => worker.url,
      isClusterHealthy: () => true,
    });

    const res = await fetch(`${master.url}/w0/api/create_game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      routedPath: "/w0/api/create_game",
      body: { hello: "world" },
    });
  });

  it("returns 503 on /api/create_game when no workers are ready and 404 on invalid worker index", async () => {
    const master = await startMasterWithOptions({
      numWorkers: () => 2,
      getReadyWorkerIds: () => [],
      isClusterHealthy: () => false,
    });

    const noWorkerRes = await fetch(`${master.url}/api/create_game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noWorkerRes.status).toBe(503);
    expect(await noWorkerRes.json()).toEqual({
      error: "No ready workers available",
    });

    const badWorkerRes = await fetch(`${master.url}/w5/api/health`);
    expect(badWorkerRes.status).toBe(404);
  });

  it("serves /commit.txt with no-store headers and returns 404 for unbacked /api/* endpoints instead of SPA HTML", async () => {
    const master = await startMasterWithOptions({
      numWorkers: () => 1,
      getReadyWorkerIds: () => [0],
      isClusterHealthy: () => true,
      getGitCommit: () => "139da335ef5fe8c68be9d048ad71cf2f3f3e9760",
    });

    const commitRes = await fetch(`${master.url}/commit.txt`);
    expect(commitRes.status).toBe(200);
    expect(commitRes.headers.get("content-type")).toContain("text/plain");
    expect(commitRes.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    expect((await commitRes.text()).trim()).toBe(
      "139da335ef5fe8c68be9d048ad71cf2f3f3e9760",
    );

    const refreshRes = await fetch(`${master.url}/api/auth/refresh`, {
      method: "POST",
    });
    expect(refreshRes.status).toBe(404);

    const usersMeRes = await fetch(`${master.url}/api/users/@me`);
    expect(usersMeRes.status).toBe(404);

    const jwksRes = await fetch(`${master.url}/api/.well-known/jwks.json`);
    expect(jwksRes.status).toBe(404);
  });

  it("enforces rate limiting on proxied creation and worker routes", async () => {
    const worker = await listenExpress(createMockWorkerApp());
    cleanups.push(worker.close);

    const master = await startMasterWithOptions({
      numWorkers: () => 1,
      getReadyWorkerIds: () => [0],
      getWorkerTarget: () => worker.url,
      isClusterHealthy: () => true,
      rateLimitMax: 2,
    });

    const r1 = await fetch(`${master.url}/api/create_game`, { method: "POST" });
    const r2 = await fetch(`${master.url}/api/create_game`, { method: "POST" });
    const r3 = await fetch(`${master.url}/api/create_game`, { method: "POST" });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it("proxies valid /w0 WebSocket upgrades and rejects invalid worker upgrades", async () => {
    const workerServer = http.createServer();
    const wss = new WebSocketServer({ server: workerServer });
    wss.on("connection", (ws, req) => {
      ws.send(`connected:${req.url}`);
      ws.on("message", (msg) => ws.send(`echo:${msg.toString()}`));
    });
    await new Promise<void>((resolve) =>
      workerServer.listen(0, "127.0.0.1", () => resolve()),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => workerServer.close(() => resolve()));
        }),
    );
    const addr = workerServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected worker WS port");
    }

    const master = await startMasterWithOptions({
      numWorkers: () => 1,
      getReadyWorkerIds: () => [0],
      getWorkerTarget: () => `http://127.0.0.1:${addr.port}`,
      isClusterHealthy: () => true,
    });

    const wsPort = new URL(master.url).port;
    const received = await new Promise<string[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/w0`);
      const msgs: string[] = [];
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (data) => {
        msgs.push(data.toString());
        if (msgs.length === 2) {
          ws.close();
          resolve(msgs);
        }
      });
      ws.on("error", reject);
    });
    expect(received).toEqual(["connected:/w0", "echo:ping"]);

    await expect(
      new Promise<void>((resolve, reject) => {
        const badWs = new WebSocket(`ws://127.0.0.1:${wsPort}/w9`);
        badWs.on("open", () => reject(new Error("Should not open /w9")));
        badWs.on("error", () => resolve());
        badWs.on("close", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });
});
