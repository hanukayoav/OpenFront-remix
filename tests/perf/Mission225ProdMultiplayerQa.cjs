const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const httpProxy = require("http-proxy");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const ROOT = process.cwd();
const API_KEY = "m225-prod-qa-api-key-998877";
const ADMIN_BOT_API_KEY = "m225-prod-qa-admin-bot-key";

function killProcessTreeSync(pid) {
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
    // Already exited.
  }
}

class ResourceTracker {
  constructor() {
    this.cdpClients = new Set();
    this.chromes = new Set();
    this.servers = new Set();
    this.processes = new Set();
    this.tempDirs = new Set();
  }

  async cleanupAll() {
    for (const cdp of this.cdpClients) {
      await cdp.close().catch(() => {});
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
    for (const proc of this.processes) {
      killProcessTreeSync(proc.pid);
    }
    this.processes.clear();
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

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, host);
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
      const timer = setTimeout(
        () => reject(new Error(`CDP [${label}] connect timeout`)),
        10000,
      );
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
        if (msg.error) {
          entry.reject(
            new Error(
              `CDP [${label}] ${entry.method}: ${JSON.stringify(msg.error)}`,
            ),
          );
        } else {
          entry.resolve(msg.result);
        }
        return;
      }
      for (const listener of this.messageListeners) {
        listener(msg);
      }
    });

    this.ws.on("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`CDP [${label}] closed`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    if (this.closed) {
      throw new Error(`CDP [${this.label}] already closed`);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP [${this.label}] timeout (${method})`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalExpr(expression, timeoutMs = 15000) {
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
        `Eval [${this.label}] error: ${JSON.stringify(res.exceptionDetails)}`,
      );
    }
    return res.result?.value;
  }

  async close() {
    if (!this.closed) {
      this.ws.close();
    }
  }
}

async function waitForCondition(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? ` (${lastErr.message})` : ""}`,
  );
}

async function launchChrome(chromePath, width, height, tracker) {
  const debugPort = await findFreePort();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "frontierx-m225-chrome-"),
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
  tracker.processes.add(proc);

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

async function startRealAuthDaemon(tracker, authDataDir) {
  const occupied = await isPortOpen(8787, "127.0.0.1");
  if (occupied) {
    throw new Error(
      "Port 8787 is already in use; stop any conflicting local auth daemon first.",
    );
  }

  const tsxBin =
    process.platform === "win32"
      ? path.join(ROOT, "node_modules", ".bin", "tsx.cmd")
      : path.join(ROOT, "node_modules", ".bin", "tsx");

  const authProc = spawn(tsxBin, ["src/auth/Server.ts"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GAME_ENV: "prod",
      DOMAIN: "localhost",
      AUTH_HOST: "127.0.0.1",
      AUTH_PORT: "8787",
      AUTH_DATA_DIR: authDataDir,
      AUTH_ALLOW_TURNSTILE_DEV_BYPASS: "true",
      API_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  authProc.stdout?.on("data", (d) => logs.push(d.toString()));
  authProc.stderr?.on("data", (d) => logs.push(d.toString()));
  tracker.processes.add(authProc);

  await waitForCondition(
    async () => {
      if (authProc.exitCode !== null) {
        throw new Error(
          `frontierx-auth exited early (${authProc.exitCode}):\n${logs.join("")}`,
        );
      }
      const res = await fetch("http://localhost:8787/health");
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === "ok";
    },
    15000,
    "frontierx-auth ready on :8787",
  );

  return { logs };
}

async function startProdCluster(masterPort, tracker) {
  const tsxBin =
    process.platform === "win32"
      ? path.join(ROOT, "node_modules", ".bin", "tsx.cmd")
      : path.join(ROOT, "node_modules", ".bin", "tsx");

  const serverProc = spawn(tsxBin, ["src/server/Server.ts"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GAME_ENV: "prod",
      NUM_WORKERS: "2",
      PORT: String(masterPort),
      DOMAIN: "localhost",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      API_KEY,
      ADMIN_BOT_API_KEY,
      AUTH_SERVICE_URL: "http://127.0.0.1:8787",
      AUTH_INTERNAL_URL: "http://127.0.0.1:8787",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  serverProc.stdout?.on("data", (d) => logs.push(d.toString()));
  serverProc.stderr?.on("data", (d) => logs.push(d.toString()));
  tracker.processes.add(serverProc);

  await waitForCondition(
    async () => {
      if (serverProc.exitCode !== null) {
        throw new Error(
          `prod cluster exited early (${serverProc.exitCode}):\n${logs.join("")}`,
        );
      }
      const res = await fetch(`http://127.0.0.1:${masterPort}/api/health`);
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === "ok";
    },
    25000,
    `prod cluster ready on :${masterPort}`,
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

async function prepareGuestBrowserPage(page, url, playerName) {
  const pageErrors = [];
  const consoleLogs = [];
  page.messageListeners.add((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(msg.params.exceptionDetails));
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params?.args ?? [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      consoleLogs.push(`[${msg.params?.type}] ${text}`);
    }
  });
  page._consoleLogs = consoleLogs;
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
      window.__fxQaState = { glFrames: 0 };
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        const ctx = origGetContext.call(this, type, attrs);
        if (ctx && (type === "webgl2" || type === "webgl")) {
          const origClear = ctx.clear.bind(ctx);
          ctx.clear = function(mask) {
            window.__fxQaState.glFrames++;
            return origClear(mask);
          };
        }
        return ctx;
      };
    })()`,
  });

  await page.send("Page.navigate", { url });
  await waitForCondition(
    () =>
      page.evalExpr(
        'Boolean(window.BOOTSTRAP_CONFIG && document.querySelector("username-input") && document.querySelector("host-lobby-modal"))',
      ),
    20000,
    "UI shell boot",
  );

  await page.evalExpr(`(() => {
    const ui = document.querySelector("username-input");
    const input = ui?.querySelector("input");
    if (input) {
      input.value = ${JSON.stringify(playerName)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);

  return pageErrors;
}

async function main() {
  const tracker = new ResourceTracker();
  const report = { checks: {}, failures: [] };
  const record = (name, ok, details) => {
    report.checks[name] = { ok, ...details };
    if (!ok) {
      report.failures.push({ name, details });
    }
  };

  const watchdog = setTimeout(() => {
    console.error("[M22.5-QA] Watchdog timeout reached (150s); aborting.");
    void tracker.cleanupAll().finally(() => process.exit(1));
  }, 150000);
  watchdog.unref();

  try {
    assert(
      fs.existsSync(path.join(ROOT, "static", "index.html")),
      "Run npm run build-prod before running Mission225ProdMultiplayerQa.cjs",
    );

    const authDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "frontierx-m225-authdata-"),
    );
    tracker.tempDirs.add(authDataDir);

    await startRealAuthDaemon(tracker, authDataDir);
    const masterPort = await findFreePort();
    const clusterLogs = await startProdCluster(masterPort, tracker);
    const gateway = await startTransparentGateway(masterPort, tracker);
    const baseUrl = `http://localhost:${gateway.port}`;
    const chromePath = resolveChromePath();

    // 1. Launch two independent headless Chrome instances on this desktop
    const chromeA = await launchChrome(chromePath, 1440, 900, tracker);
    const chromeB = await launchChrome(chromePath, 1440, 900, tracker);
    const browserA = new CdpClient(chromeA.firstWsUrl, "Browser-A");
    const browserB = new CdpClient(chromeB.firstWsUrl, "Browser-B");
    tracker.cdpClients.add(browserA);
    tracker.cdpClients.add(browserB);

    const errorsA = await prepareGuestBrowserPage(
      browserA,
      baseUrl,
      "CommanderA",
    );
    const errorsB = await prepareGuestBrowserPage(
      browserB,
      baseUrl,
      "CommanderB",
    );

    // Verify AccountModal FrontierX Account / Recovery panel & v1.0.7 branding intact
    await browserA.evalExpr(
      'document.querySelector("account-modal")?.open?.()',
    );
    const accountPanelOk = await waitForCondition(
      () =>
        browserA.evalExpr(`(() => {
          const am = document.querySelector("account-modal");
          if (!am) return false;
          const text =
            (am.innerText || am.textContent || "") +
            " " +
            (am.shadowRoot?.textContent || "");
          return (
            text.includes("FrontierX Account") &&
            text.includes("Guest / Session Recovery")
          )
            ? true
            : null;
        })()`),
      10000,
      "AccountModal FrontierX Account & Recovery panel renders",
    );
    await browserA.evalExpr(
      'document.querySelector("account-modal")?.close?.()',
    );
    const versionMeta = await browserA.evalExpr(`(() => {
      const startText =
        document.querySelector("game-starting-modal")?.textContent ?? "";
      const footerText = document.body.innerText ?? "";
      return {
        gameEnv: window.BOOTSTRAP_CONFIG?.gameEnv,
        hasV107: footerText.includes("v1.0.7") || startText.includes("v1.0.7"),
        hasV105: footerText.includes("v1.0.5") || startText.includes("v1.0.5"),
      };
    })()`);
    record(
      "account_modal_and_branding_v107",
      Boolean(
        accountPanelOk &&
        versionMeta.gameEnv === "prod" &&
        versionMeta.hasV107 &&
        !versionMeta.hasV105,
      ),
      { accountPanelOk, versionMeta },
    );

    // 2. Browser A hosts a private lobby -> automatic server-issued signed guest session + /api/create_game
    await browserA.evalExpr(`(() => {
      document.querySelector("host-lobby-modal").open();
    })()`);
    const lobbyId = await waitForCondition(
      () =>
        browserA.evalExpr(`(() => {
          const hm = document.querySelector("host-lobby-modal");
          return hm?.lobbyId && hm.lobbyId.length > 0 && (hm.clients?.length ?? 0) >= 1
            ? hm.lobbyId
            : null;
        })()`),
      20000,
      "Browser A creates and joins lobby",
    );

    await browserA.evalExpr(`(async () => {
      const hm = document.querySelector("host-lobby-modal");
      hm.selectedMap = "World";
      hm.bots = 4;
      hm.startDelayValue = 0;
      hm.supplyDropFrequency = "extreme";
      hm.startingGold = true;
      hm.startingGoldValue = 2;
      await hm.putGameConfig?.();
    })()`);

    const inviteUrl = await browserA.evalExpr("location.href");

    // 3. Browser B joins the lobby cleanly as a second independent authenticated guest
    await browserB.send("Page.navigate", { url: inviteUrl });
    try {
      await waitForCondition(
        () =>
          browserA.evalExpr(
            '(document.querySelector("host-lobby-modal")?.clients?.length ?? 0) >= 2',
          ),
        20000,
        "Browser B joins Browser A lobby",
      );
    } catch (joinErr) {
      const diag = await Promise.all([
        browserA
          .evalExpr(
            `(() => ({
          href: location.href,
          hmLobby: document.querySelector("host-lobby-modal")?.lobbyId ?? null,
          hmClients: document.querySelector("host-lobby-modal")?.clients ?? null,
        }))()`,
          )
          .catch((e) => e.message),
        browserB
          .evalExpr(
            `(() => ({
          href: location.href,
          jmLobby: document.querySelector("join-lobby-modal")?.currentLobbyId ?? null,
          jmPlayers: document.querySelector("join-lobby-modal")?.players ?? null,
          bodyText: document.body.innerText.slice(0, 400),
        }))()`,
          )
          .catch((e) => e.message),
      ]);
      console.error(
        "[M225-QA] Join timeout diag:",
        JSON.stringify(diag, null, 2),
      );
      console.error(
        "[M225-QA] Browser A logs:",
        (browserA._consoleLogs ?? []).slice(-15),
      );
      console.error(
        "[M225-QA] Browser B logs:",
        (browserB._consoleLogs ?? []).slice(-15),
      );
      console.error("[M225-QA] Errors B:", errorsB);
      throw joinErr;
    }

    await browserA.evalExpr(`(async () => {
      const hm = document.querySelector("host-lobby-modal");
      await hm.toggleGameStartTimer();
    })()`);

    // 4. Wait for both clients to enter match & render synchronized WebGL ticks
    let startTicks;
    try {
      startTicks = await waitForCondition(
        async () => {
          const a = await browserA.evalExpr(
            'document.querySelector("build-menu")?.game?.ticks?.() ?? 0',
          );
          const b = await browserB.evalExpr(
            'document.querySelector("build-menu")?.game?.ticks?.() ?? 0',
          );
          return a >= 2 && b >= 2 ? { a, b } : null;
        },
        35000,
        "both clients enter active match and tick",
      );
    } catch (startErr) {
      const diag = await Promise.all([
        browserA
          .evalExpr(
            `(() => ({
          href: location.href,
          hmLobby: document.querySelector("host-lobby-modal")?.lobbyId ?? null,
          hmClients: document.querySelector("host-lobby-modal")?.clients?.length ?? 0,
          hmStartsAt: document.querySelector("host-lobby-modal")?.startsAt ?? null,
          inGame: document.body.classList.contains("in-game"),
          ticks: document.querySelector("build-menu")?.game?.ticks?.() ?? null,
          bodyText: document.body.innerText.slice(0, 300),
        }))()`,
          )
          .catch((e) => e.message),
        browserB
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
      console.error("[M225-QA] Start diag:", JSON.stringify(diag, null, 2));
      console.error(
        "[M225-QA] Browser A logs:",
        (browserA._consoleLogs ?? []).slice(-15),
      );
      console.error(
        "[M225-QA] Browser B logs:",
        (browserB._consoleLogs ?? []).slice(-15),
      );
      console.error("[M225-QA] Cluster tail:", clusterLogs.slice(-30).join(""));
      throw startErr;
    }

    // Spawn both players near the center on unclaimed land
    for (const p of [browserA, browserB]) {
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
        const a = await browserA.evalExpr(
          '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
        );
        const b = await browserB.evalExpr(
          '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
        );
        return a > 0 && b > 0 ? { a, b } : null;
      },
      35000,
      "exit spawn phase",
    );

    // 5. Expand territory & build a Tank Factory on Browser A, wait for a Tank unit to spawn
    const buildResult = await browserA.evalExpr(`(() => {
      const bm = document.querySelector("build-menu");
      const g = bm?.game;
      const my = g?.myPlayer?.();
      if (!g || !my || typeof bm?.sendBuildOrUpgrade !== "function") {
        return { built: false, reason: "no_build_menu" };
      }
      const mySmallId = my.smallID();
      const w = g.width(), h = g.height();
      let buildTile = undefined;
      for (let x = 2; x < w && buildTile === undefined; x += 2) {
        for (let y = 2; y < h; y += 2) {
          const t = g.ref(x, y);
          if (g.ownerID(t) === mySmallId && g.isLand(t)) {
            buildTile = t;
            break;
          }
        }
      }
      if (buildTile === undefined) {
        return { built: false, reason: "no_owned_tile" };
      }
      bm.sendBuildOrUpgrade(
        { type: "Tank Factory", canBuild: true, canUpgrade: false },
        buildTile,
      );
      return { built: true, mySmallId, gold: String(my.gold?.() ?? 0) };
    })()`);

    // Wait for Tank Factory construction + Tank production to appear identically on BOTH Browser A and Browser B
    const tankParity = await waitForCondition(
      async () => {
        const aState = await browserA.evalExpr(`(() => {
          const g = document.querySelector("build-menu")?.game;
          const my = g?.myPlayer?.();
          if (!g || !my) return null;
          const sid = my.smallID();
          const factories = g.units("Tank Factory").filter((u) => u.owner().smallID() === sid).length;
          const tanks = g.units("Tank")
            .filter((u) => u.owner().smallID() === sid)
            .map((u) => ({
              id: u.id(),
              x: g.x(u.tile()),
              y: g.y(u.tile()),
            }));
          return { ticks: g.ticks(), ownerSmallId: sid, factories, tanks };
        })()`);
        if (!aState || aState.factories < 1 || aState.tanks.length < 1) {
          return null;
        }
        const bState = await browserB.evalExpr(`((ownerSid) => {
          const g = document.querySelector("build-menu")?.game;
          if (!g) return null;
          const factories = g.units("Tank Factory").filter((u) => u.owner().smallID() === ownerSid).length;
          const tanks = g.units("Tank")
            .filter((u) => u.owner().smallID() === ownerSid)
            .map((u) => ({
              id: u.id(),
              x: g.x(u.tile()),
              y: g.y(u.tile()),
            }));
          return { ticks: g.ticks(), factories, tanks };
        })(${JSON.stringify(aState.ownerSmallId)})`);
        if (
          bState &&
          bState.factories >= 1 &&
          bState.tanks.some((bt) => aState.tanks.some((at) => at.id === bt.id))
        ) {
          return { aState, bState };
        }
        return null;
      },
      45000,
      "Tank Factory and Tank deterministic parity across both browsers",
    );

    // 6. Verify supply drop synchronization across clients + active WebGL frames
    const supplyClaimCheck = await waitForCondition(
      async () => {
        const aSup = await browserA.evalExpr(`(() => {
          const bm = document.querySelector("build-menu");
          const g = bm?.game;
          const my = g?.myPlayer?.();
          if (!g || !my) return null;
          const goldBefore = Number(my.gold?.() ?? 0);
          return {
            supplyDropFrequency: g.config?.()?.supplyDropFrequency?.() ?? null,
            ticks: g.ticks(),
            goldBefore,
            glFrames: window.__fxQaState?.glFrames ?? 0,
          };
        })()`);
        const bFreq = await browserB.evalExpr(
          'document.querySelector("build-menu")?.game?.config?.()?.supplyDropFrequency?.() ?? null',
        );
        if (
          aSup &&
          aSup.supplyDropFrequency === "extreme" &&
          bFreq === "extreme"
        ) {
          return { aSup, bFreq };
        }
        return null;
      },
      10000,
      "supply drop mutator synced across clients",
    );

    // 7. Browser B disconnects and reconnects mid-match cleanly without restart
    const bTickBeforeDrop = await browserB.evalExpr(
      'document.querySelector("build-menu")?.game?.ticks?.() ?? 0',
    );
    const wsDropped = gateway.killLatestWs();
    await new Promise((r) => setTimeout(r, 2000));
    const reconnectParity = await waitForCondition(
      async () => {
        const a = await browserA.evalExpr(
          'document.querySelector("build-menu")?.game?.ticks?.() ?? 0',
        );
        const b = await browserB.evalExpr(
          'document.querySelector("build-menu")?.game?.ticks?.() ?? 0',
        );
        return b >= bTickBeforeDrop + 8 && Math.abs(a - b) <= 15
          ? { tickA: a, tickB: b, bTickBeforeDrop, wsDropped }
          : null;
      },
      25000,
      "Browser B reconnect parity without match restart",
    );

    // 8. End match cleanly & verify Single-Player mode still starts and ticks cleanly
    await browserB.send("Page.navigate", { url: baseUrl });
    await browserA.send("Page.navigate", { url: baseUrl });
    await waitForCondition(
      () =>
        browserA.evalExpr(
          'Boolean(document.querySelector("single-player-modal"))',
        ),
      15000,
      "return to main menu after match",
    );

    const spResult = await browserA.evalExpr(`(async () => {
      const spm = document.querySelector("single-player-modal");
      if (!spm) return false;
      spm.open?.();
      await spm.updateComplete;
      await new Promise((r) => setTimeout(r, 300));
      const startBtn =
        spm.querySelector(
          'o-button[translationKey="single_modal.start"], o-button[translationkey="single_modal.start"]',
        ) ??
        Array.from(spm.querySelectorAll("button, o-button")).find((el) =>
          (el.shadowRoot?.textContent || el.textContent || "")
            .toLowerCase()
            .includes("start"),
        );
      if (!startBtn) return false;
      startBtn.click();
      return true;
    })()`);

    const spTicking = await waitForCondition(
      () =>
        browserA.evalExpr(
          '(document.querySelector("build-menu")?.game?.ticks?.() ?? 0) >= 2',
        ),
      20000,
      "singleplayer launches cleanly",
    );

    record(
      "two_browser_prod_multiplayer_and_sp_e2e",
      Boolean(
        lobbyId &&
        startTicks.a >= 2 &&
        buildResult.built &&
        tankParity.aState.tanks.length >= 1 &&
        tankParity.bState.tanks.length >= 1 &&
        supplyClaimCheck.aSup.glFrames > 0 &&
        wsDropped &&
        reconnectParity &&
        spResult &&
        spTicking &&
        errorsA.length === 0 &&
        errorsB.length === 0,
      ),
      {
        lobbyId,
        startTicks,
        buildResult,
        tankCounts: {
          browserA: tankParity.aState.tanks.length,
          browserB: tankParity.bState.tanks.length,
          factoriesA: tankParity.aState.factories,
          factoriesB: tankParity.bState.factories,
        },
        supplyClaimCheck,
        reconnectParity,
        spTicking,
        errorsA,
        errorsB,
      },
    );
  } finally {
    clearTimeout(watchdog);
    await tracker.cleanupAll();
  }

  console.log("M225_PROD_QA_SUMMARY:", JSON.stringify(report, null, 2));
  if (report.failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("M225_PROD_QA_FATAL:", err);
  process.exit(1);
});
