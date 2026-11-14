const { execFileSync, spawn } = require("child_process");
const express = require("express");
const fs = require("fs");
const http = require("http");
const httpProxy = require("http-proxy");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const OP_TIMEOUT_MS = 12000;
const SUITE_TIMEOUT_MS = 180000;
const AUTH_PORT = 8787;
const API_KEY = "prod-qa-server-api-key";

function uuidToBase64url(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

function killProcessTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

class ResourceTracker {
  constructor() {
    this.cdpClients = new Set();
    this.chromes = new Set();
    this.servers = new Set();
    this.clusters = new Set();
    this.tempDirs = new Set();
    this.cleaning = false;
  }

  async cleanupAll() {
    if (this.cleaning) return;
    this.cleaning = true;
    for (const c of this.cdpClients) {
      await c.close().catch(() => {});
    }
    this.cdpClients.clear();
    for (const ch of this.chromes) {
      await ch.cleanup().catch(() => {});
    }
    this.chromes.clear();
    for (const srv of this.servers) {
      try {
        srv.closeAllConnections?.();
        srv.close?.();
      } catch {
        // ignore
      }
    }
    this.servers.clear();
    for (const cl of this.clusters) {
      cl.stop();
    }
    this.clusters.clear();
    for (const dir of this.tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.tempDirs.clear();
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Could not find Chrome executable");
}

class CdpClient {
  constructor(wsUrl, label) {
    this.label = label;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.messageListeners = new Set();
    this.closed = false;

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP [${label}] connect timeout`));
      }, 10000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.messageListeners) l(msg);
      }
    });

    this.ws.on("close", () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`CDP [${label}] closed`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = OP_TIMEOUT_MS) {
    await this.ready;
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP [${this.label}] not open`);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP [${this.label}] ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalExpr(expression, timeoutMs = OP_TIMEOUT_MS) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      throw new Error(
        `Runtime error [${this.label}]: ${JSON.stringify(res.exceptionDetails)}`,
      );
    }
    return res.result?.value;
  }

  async close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function waitForCondition(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? ` (${lastErr.message})` : ""}`,
  );
}

async function launchChrome(chromePath, width, height, tracker) {
  const debugPort = await findFreePort();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "frontierx-prod-qa-"),
  );
  tracker.tempDirs.add(userDataDir);

  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--use-gl=angle",
      "--use-angle=d3d11",
      "--enable-gpu-rasterization",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let firstWsUrl = null;
  await waitForCondition(
    async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!res.ok) return false;
      const list = await res.json();
      const page = list.find(
        (p) => p.type === "page" && p.webSocketDebuggerUrl,
      );
      if (page) {
        firstWsUrl = page.webSocketDebuggerUrl;
        return true;
      }
      return false;
    },
    15000,
    "Chrome CDP ready",
  );

  const chrome = {
    debugPort,
    firstWsUrl,
    async cleanup() {
      killProcessTreeSync(proc.pid);
    },
  };
  tracker.chromes.add(chrome);
  return chrome;
}

async function startMockExternalAuthServer(tracker) {
  const { exportJWK, generateKeyPair, SignJWT } = await import("jose");
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const roguePair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = "EdDSA";
  publicJwk.crv = "Ed25519";
  publicJwk.kty = "OKP";

  const users = {
    host: {
      uuid: "11111111-1111-4111-8111-111111111111",
      publicId: "pub_host_1",
      username: "ProdHostAlpha",
    },
    joiner: {
      uuid: "22222222-2222-4222-8222-222222222222",
      publicId: "pub_joiner_2",
      username: "ProdJoinerBravo",
    },
  };

  async function issueJwtFor(userKey, opts = {}) {
    const profile = users[userKey];
    const nowSec = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      jti: `jti-${userKey}-${nowSec}`,
      provider: "discord",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(uuidToBase64url(profile.uuid))
      .setIssuer(`http://localhost:${AUTH_PORT}`)
      .setAudience("localhost")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "10m")
      .sign(opts.key ?? pair.privateKey);
  }

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, x-api-key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });

  app.get("/test/login/:role", (req, res) => {
    const role = req.params.role;
    if (!users[role]) return res.status(400).send("Unknown role");
    res.setHeader("Set-Cookie", `fx_test_role=${role}; Path=/; HttpOnly`);
    res.send(`logged in as ${role}`);
  });

  app.get("/.well-known/jwks.json", (_req, res) => {
    res.json({ keys: [publicJwk] });
  });

  app.post("/auth/refresh", async (req, res) => {
    const cookieHeader = String(req.headers.cookie ?? "");
    const match = cookieHeader.match(/fx_test_role=(host|joiner)/);
    if (!match) {
      return res.status(401).json({ error: "No session cookie" });
    }
    const jwt = await issueJwtFor(match[1]);
    res.json({ jwt, expiresIn: 600 });
  });

  app.post("/auth/logout", (_req, res) => res.json({ ok: true }));
  app.post("/auth/revoke", (_req, res) => res.json({ ok: true }));

  app.get("/users/@me", (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing bearer" });
    }
    const reqApiKey = req.headers["x-api-key"];
    if (reqApiKey !== undefined && reqApiKey !== API_KEY) {
      return res.status(403).json({ error: "Bad api key" });
    }
    const token = auth.slice("Bearer ".length);
    let profile = users.host;
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
      );
      if (payload.sub === uuidToBase64url(users.joiner.uuid)) {
        profile = users.joiner;
      }
    } catch {
      return res.status(401).json({ error: "Malformed JWT" });
    }
    res.json({
      user: { email: `${profile.username.toLowerCase()}@frontierx.test` },
      ban: null,
      player: {
        publicId: profile.publicId,
        adfree: true,
        unlimitedRanked: true,
        canCreatePublicLobbies: true,
        username: profile.username,
        usernameStatus: "premium",
        flares: [],
        achievements: { singleplayerMap: [] },
        friends: [],
        clans: [],
        subscription: null,
      },
    });
  });

  app.post("/join_verify", (req, res) => {
    if (req.headers["x-api-key"] !== API_KEY) {
      return res.status(403).json({ error: "Unauthorized server api key" });
    }
    const token = req.body?.token;
    if (token === "test-turnstile-ok") {
      return res.json({ success: true });
    }
    return res.json({ success: false, reason: "Invalid test turnstile token" });
  });

  app.get("/cosmetics.json", (_req, res) => res.json({}));
  app.get("/reserved_clan_tags", (_req, res) => res.json([]));

  const server = http.createServer(app);
  await new Promise((resolve) =>
    server.listen(AUTH_PORT, "127.0.0.1", resolve),
  );
  tracker.servers.add(server);
  return { server, issueJwtFor, roguePair };
}

async function startProdCluster(root, masterPort, tracker) {
  const tsxCli = path.join(root, "node_modules/tsx/dist/cli.mjs");
  const serverProc = spawn(
    process.execPath,
    [tsxCli, path.join(root, "src/server/Server.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        GAME_ENV: "prod",
        NUM_WORKERS: "2",
        PORT: String(masterPort),
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        DOMAIN: "localhost",
        API_KEY,
        ADMIN_BOT_API_KEY: "prod-qa-admin-bot-key",
        // Intentionally supply a stale env commit to verify static/build-metadata.json wins in Prod!
        GIT_COMMIT: "stale6731",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs = [];
  serverProc.stdout?.on("data", (d) => logs.push(d.toString()));
  serverProc.stderr?.on("data", (d) => logs.push(d.toString()));

  tracker.clusters.add({
    stop: () => killProcessTreeSync(serverProc.pid),
  });

  await waitForCondition(
    async () => {
      if (serverProc.exitCode !== null) {
        throw new Error(
          `Prod cluster exited prematurely (${serverProc.exitCode}):\n${logs.join("")}`,
        );
      }
      const r = await fetch(`http://127.0.0.1:${masterPort}/api/health`);
      if (!r.ok) return false;
      const body = await r.json();
      return body.status === "ok";
    },
    30000,
    `prod cluster on :${masterPort}`,
  );
  return logs;
}

async function startTransparentGateway(masterPort, tracker) {
  const proxy = httpProxy.createProxyServer({
    target: `http://localhost:${masterPort}`,
    ws: true,
  });
  proxy.on("error", () => {});

  const server = http.createServer((req, res) => {
    proxy.web(req, res, { target: `http://localhost:${masterPort}` });
  });

  let latestClientWsSocket = null;
  let wsConnections = 0;
  server.on("upgrade", (req, socket, head) => {
    wsConnections++;
    if (wsConnections >= 2) {
      latestClientWsSocket = socket;
    }
    proxy.ws(req, socket, head, { target: `http://localhost:${masterPort}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  tracker.servers.add(server);
  const port = server.address().port;
  return {
    port,
    killLatestWs() {
      if (latestClientWsSocket && !latestClientWsSocket.destroyed) {
        latestClientWsSocket.destroy();
        return true;
      }
      return false;
    },
  };
}

async function prepareAuthenticatedPage(page, authRole, gatewayUrl) {
  const pageErrors = [];
  page.messageListeners.add((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(msg.params.exceptionDetails));
    }
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.turnstile = {
        render: () => "mock-widget-id",
        execute: (_id, opts) => {
          setTimeout(() => opts?.callback?.("test-turnstile-ok"), 20);
        },
        remove: () => {},
      };
      window.__fxQaState = { canvas: null, gl: null, glFrames: 0 };
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        const ctx = origGetContext.call(this, type, attrs);
        if (ctx && (type === "webgl2" || type === "webgl")) {
          window.__fxQaState.canvas = this;
          window.__fxQaState.gl = ctx;
          const origDrawArrays = ctx.drawArrays.bind(ctx);
          ctx.drawArrays = function(...args) {
            window.__fxQaState.glFrames++;
            return origDrawArrays(...args);
          };
          const origDrawElements = ctx.drawElements.bind(ctx);
          ctx.drawElements = function(...args) {
            window.__fxQaState.glFrames++;
            return origDrawElements(...args);
          };
        }
        return ctx;
      };
    })()`,
  });

  await page.send("Page.navigate", {
    url: `http://localhost:${AUTH_PORT}/test/login/${authRole}`,
  });
  await waitForCondition(
    () =>
      page.evalExpr(
        `document.body?.innerText?.includes("logged in as ${authRole}")`,
      ),
    10000,
    `auth session cookie for ${authRole}`,
  );
  await page.send("Page.navigate", { url: gatewayUrl });
  await waitForCondition(
    () =>
      page.evalExpr(
        'document.readyState === "complete" && typeof document.querySelector("host-lobby-modal")?.open === "function" && Boolean(document.querySelector("#game-version, .game-version-display")?.textContent?.trim())',
      ),
    20000,
    `${authRole} app shell ready`,
  );
  return pageErrors;
}

async function runSuite() {
  const root = process.cwd();
  const metadataPath = path.join(root, "static/build-metadata.json");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      `Missing ${metadataPath}; run npm run build-prod before running ProdMultiplayerMetadataQa`,
    );
  }
  const builtMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const expectedCommit = builtMetadata.gitCommit;
  const chromePath = resolveChromePath();
  const tracker = new ResourceTracker();

  const report = {
    expectedCommit,
    expectedVersion: "v1.0.7",
    checks: {},
    failures: [],
  };

  function record(name, passed, details) {
    report.checks[name] = { passed, details };
    console.log(
      `[PROD-QA] ${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(details)}`,
    );
    if (!passed) report.failures.push({ name, details });
  }

  const masterPort = await findFreePort();
  const watchdog = setTimeout(() => {
    console.error("[PROD-QA] Suite watchdog expired!");
    process.exit(1);
  }, SUITE_TIMEOUT_MS).unref();

  try {
    const authSrv = await startMockExternalAuthServer(tracker);
    const clusterLogs = await startProdCluster(root, masterPort, tracker);
    const gateway = await startTransparentGateway(masterPort, tracker);
    const baseUrl = `http://localhost:${gateway.port}`;

    // 1. Metadata & Negative Security Checks directly through Master + Gateway
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = await healthRes.json();
    const commitRes = await fetch(`${baseUrl}/commit.txt`);
    const liveCommit = (await commitRes.text()).trim();
    record(
      "prod_health_and_commit_metadata",
      healthRes.status === 200 &&
        healthJson.status === "ok" &&
        commitRes.status === 200 &&
        liveCommit === expectedCommit &&
        liveCommit !== "stale6731",
      {
        healthStatus: healthRes.status,
        commitStatus: commitRes.status,
        liveCommit,
        expectedCommit,
      },
    );

    const noAuthCreate = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const unsignedCreate = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer 123e4567-e89b-12d3-a456-426614174000",
      },
      body: JSON.stringify({}),
    });
    const forgedJwt = await authSrv.issueJwtFor("host", {
      key: authSrv.roguePair.privateKey,
    });
    const forgedCreate = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${forgedJwt}`,
      },
      body: JSON.stringify({}),
    });
    const validJwt = await authSrv.issueJwtFor("host");
    const validCreate = await fetch(`${baseUrl}/api/create_game`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validJwt}`,
      },
      body: JSON.stringify({}),
    });
    const validCreateJson = await validCreate.json().catch(() => ({}));

    record(
      "prod_create_game_auth_enforcement_and_routing",
      noAuthCreate.status >= 400 &&
        noAuthCreate.status !== 404 &&
        unsignedCreate.status >= 400 &&
        unsignedCreate.status !== 404 &&
        forgedCreate.status >= 400 &&
        forgedCreate.status !== 404 &&
        validCreate.status === 200 &&
        typeof validCreateJson.gameID === "string",
      {
        noAuthStatus: noAuthCreate.status,
        unsignedUuidStatus: unsignedCreate.status,
        forgedJwtStatus: forgedCreate.status,
        validCreateStatus: validCreate.status,
        createdGameId: validCreateJson.gameID ?? null,
      },
    );

    // Verify invalid / unsigned WS join is rejected in GAME_ENV=prod
    const badWsClose = await new Promise((resolve) => {
      const ws = new WebSocket(
        `ws://localhost:${gateway.port}/${validCreateJson.workerPath ?? "w0"}`,
      );
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "join",
            gameID: validCreateJson.gameID,
            clientID: "badc01",
            token: "123e4567-e89b-12d3-a456-426614174000",
            turnstileToken: "test-turnstile-ok",
            username: "UnsignedUser",
            cosmetics: {},
          }),
        );
      });
      ws.on("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
      ws.on("error", () => resolve({ code: 1006, reason: "error" }));
      setTimeout(() => resolve({ code: -1, reason: "timeout" }), 5000);
    });
    record(
      "prod_ws_rejects_unsigned_persistent_id",
      badWsClose.code !== -1 && badWsClose.code !== 1000,
      badWsClose,
    );

    // 2. Launch TWO independent Chrome instances (Host & Joiner)
    const hostChrome = await launchChrome(chromePath, 1440, 900, tracker);
    const joinerChrome = await launchChrome(chromePath, 1440, 900, tracker);
    const hostPage = new CdpClient(hostChrome.firstWsUrl, "Prod-Host");
    const joinerPage = new CdpClient(joinerChrome.firstWsUrl, "Prod-Joiner");
    tracker.cdpClients.add(hostPage);
    tracker.cdpClients.add(joinerPage);

    const hostErrors = await prepareAuthenticatedPage(
      hostPage,
      "host",
      baseUrl,
    );
    const joinerErrors = await prepareAuthenticatedPage(
      joinerPage,
      "joiner",
      baseUrl,
    );

    const metadataUi = await hostPage.evalExpr(`(() => {
      const verText = document.querySelector("#game-version, .game-version-display")?.textContent?.trim() ?? "";
      const startModal = document.querySelector("game-starting-modal");
      const startModalVer = startModal?.shadowRoot?.textContent?.trim() || startModal?.textContent?.trim() || "";
      return {
        bootstrapCommit: window.BOOTSTRAP_CONFIG?.gitCommit ?? null,
        bootstrapGameEnv: window.BOOTSTRAP_CONFIG?.gameEnv ?? null,
        verText,
        hasV107InStartingModal: startModalVer.includes("v1.0.7"),
        hasV105Anywhere: document.body.innerText.includes("v1.0.5") || startModalVer.includes("v1.0.5"),
      };
    })()`);
    record(
      "ui_version_and_bootstrap_metadata",
      metadataUi.bootstrapCommit === expectedCommit &&
        metadataUi.bootstrapGameEnv === "prod" &&
        metadataUi.verText.includes("v1.0.7") &&
        metadataUi.hasV107InStartingModal &&
        !metadataUi.hasV105Anywhere,
      metadataUi,
    );

    // Host creates authenticated lobby with Extreme supply drops via UI
    await hostPage.evalExpr(`(() => {
      const hm = document.querySelector("host-lobby-modal");
      hm.open();
    })()`);

    const lobbyId = await waitForCondition(
      () =>
        hostPage.evalExpr(
          `(() => {
            const hm = document.querySelector("host-lobby-modal");
            return hm?.lobbyId && hm.lobbyId.length > 0 ? hm.lobbyId : null;
          })()`,
        ),
      15000,
      "prod host lobby creation via /api/create_game",
    );

    await hostPage.evalExpr(`(async () => {
      const hm = document.querySelector("host-lobby-modal");
      hm.selectedMap = "World";
      hm.bots = 4;
      hm.startDelayValue = 0;
      hm.supplyDropFrequency = "extreme";
      await hm.putGameConfig?.();
    })()`);

    const inviteUrl = await hostPage.evalExpr("location.href");
    await joinerPage.send("Page.navigate", { url: inviteUrl });

    await waitForCondition(
      () =>
        hostPage.evalExpr(
          '(document.querySelector("host-lobby-modal")?.clients?.length ?? 0) >= 2',
        ),
      35000,
      "second authenticated browser joins lobby",
    );

    await hostPage.evalExpr(`(async () => {
      const hm = document.querySelector("host-lobby-modal");
      await hm.toggleGameStartTimer();
    })()`);

    let startTicks;
    try {
      startTicks = await waitForCondition(
        async () => {
          const h = await hostPage.evalExpr(
            '(() => { const g = document.querySelector("build-menu")?.game; return g && g.ticks() >= 2 ? g.ticks() : 0; })()',
          );
          const j = await joinerPage.evalExpr(
            '(() => { const g = document.querySelector("build-menu")?.game; return g && g.ticks() >= 2 ? g.ticks() : 0; })()',
          );
          return h >= 2 && j >= 2 ? { h, j } : null;
        },
        35000,
        "both authenticated clients ticking",
      );
    } catch (err) {
      const diag = await Promise.all([
        hostPage
          .evalExpr(
            `(() => ({
          href: location.href,
          hmOpen: document.querySelector("host-lobby-modal")?.open !== undefined,
          hmLobby: document.querySelector("host-lobby-modal")?.lobbyId ?? null,
          hmClients: document.querySelector("host-lobby-modal")?.clients?.length ?? 0,
          hmStartsAt: document.querySelector("host-lobby-modal")?.startsAt ?? null,
          inGame: document.body.classList.contains("in-game"),
          ticks: document.querySelector("build-menu")?.game?.ticks?.() ?? null,
          bodyText: document.body.innerText.slice(0, 300),
        }))()`,
          )
          .catch((e) => e.message),
        joinerPage
          .evalExpr(
            `(() => ({
          href: location.href,
          jmLobby: document.querySelector("join-lobby-modal")?.currentLobbyId ?? null,
          jmPlayers: document.querySelector("join-lobby-modal")?.players?.length ?? 0,
          inGame: document.body.classList.contains("in-game"),
          ticks: document.querySelector("build-menu")?.game?.ticks?.() ?? null,
          bodyText: document.body.innerText.slice(0, 300),
        }))()`,
          )
          .catch((e) => e.message),
      ]);
      console.error("[PROD-QA] Start diag:", JSON.stringify(diag, null, 2));
      console.error("[PROD-QA] Cluster tail:", clusterLogs.slice(-30).join(""));
      throw err;
    }

    // Spawn both players near center
    for (const p of [hostPage, joinerPage]) {
      const pt = await p.evalExpr(`(() => {
        const bm = document.querySelector("build-menu");
        const g = bm?.game;
        const th = bm?.transformHandler;
        if (!g || !th) return null;
        const w = g.width(), h = g.height();
        for (let r = 20; r < 260; r += 12) {
          for (let a = 0; a < 360; a += 30) {
            const rad = (a * Math.PI) / 180;
            const cx = Math.floor(w / 2 + r * Math.cos(rad));
            const cy = Math.floor(h / 2 + r * Math.sin(rad));
            if (g.isValidCoord(cx, cy)) {
              const t = g.ref(cx, cy);
              if (g.isLand(t) && !g.hasOwner(t)) {
                return th.worldToScreenCoordinates({ x: cx, y: cy });
              }
            }
          }
        }
        return null;
      })()`);
      if (pt) {
        await p.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          button: "left",
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 60));
        await p.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          button: "left",
          clickCount: 1,
        });
      }
    }

    await waitForCondition(
      async () => {
        const h = await hostPage.evalExpr(
          '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
        );
        const j = await joinerPage.evalExpr(
          '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
        );
        return h > 0 && j > 0 ? { h, j } : null;
      },
      35000,
      "exit spawn phase",
    );

    // Wait briefly and inspect WebGL rendering + supply-drop config parity + WS reconnect
    await new Promise((r) => setTimeout(r, 2500));

    const hostSnapBeforeDrop = await hostPage.evalExpr(`(() => {
      const g = document.querySelector("build-menu")?.game;
      return {
        ticks: g?.ticks() ?? 0,
        supplyDropFrequency: g?.config?.()?.supplyDropFrequency?.() ?? null,
        glFrames: window.__fxQaState?.glFrames ?? 0,
      };
    })()`);

    const tickBeforeKill = await joinerPage.evalExpr(
      'document.querySelector("build-menu")?.game?.ticks() ?? 0',
    );
    const wsDropped = gateway.killLatestWs();
    await new Promise((r) => setTimeout(r, 2000));

    const reconnectParity = await waitForCondition(
      async () => {
        const h = await hostPage.evalExpr(
          'document.querySelector("build-menu")?.game?.ticks() ?? 0',
        );
        const j = await joinerPage.evalExpr(
          'document.querySelector("build-menu")?.game?.ticks() ?? 0',
        );
        return j >= tickBeforeKill + 10 && Math.abs(h - j) <= 15
          ? { hostTick: h, joinerTick: j, tickBeforeKill, wsDropped }
          : null;
      },
      25000,
      "prod WS disconnect + rejoin recovery",
    );

    const joinerMutatorSnap = await joinerPage.evalExpr(`(() => {
      const g = document.querySelector("build-menu")?.game;
      return {
        supplyDropFrequency: g?.config?.()?.supplyDropFrequency?.() ?? null,
        playerCount: g?.players?.()?.length ?? 0,
      };
    })()`);

    record(
      "prod_two_browser_mp_webgl_mutators_and_reconnect",
      lobbyId.length > 0 &&
        startTicks.h >= 2 &&
        hostSnapBeforeDrop.glFrames > 0 &&
        hostSnapBeforeDrop.supplyDropFrequency === "extreme" &&
        joinerMutatorSnap.supplyDropFrequency === "extreme" &&
        wsDropped &&
        hostErrors.length === 0 &&
        joinerErrors.length === 0,
      {
        lobbyId,
        inviteUrl,
        hostSnapBeforeDrop,
        joinerMutatorSnap,
        reconnectParity,
        hostErrors,
        joinerErrors,
      },
    );
  } finally {
    clearTimeout(watchdog);
    await tracker.cleanupAll();
  }

  console.log("PROD_QA_SUMMARY:", JSON.stringify(report, null, 2));
  if (report.failures.length > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("PROD_QA_FATAL:", err);
  process.exit(1);
});
