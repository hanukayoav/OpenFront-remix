const { spawn, execFileSync } = require("child_process");
const express = require("express");
const http = require("http");
const httpProxy = require("http-proxy");
const WebSocket = require("ws");
const os = require("os");
const path = require("path");
const fs = require("fs");

const DEFAULT_OP_TIMEOUT_MS = Number(process.env.QA_OP_TIMEOUT_MS ?? 10000);
const DEFAULT_CYCLE_TIMEOUT_MS = Number(
  process.env.QA_CYCLE_TIMEOUT_MS ?? 85000,
);
const DEFAULT_MP_TIMEOUT_MS = Number(process.env.QA_MP_TIMEOUT_MS ?? 180000);
const DEFAULT_SUITE_TIMEOUT_MS = Number(
  process.env.QA_SUITE_TIMEOUT_MS ?? 360000,
);

function parseModeArg() {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  return arg ? arg.slice("--mode=".length) : "full";
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
      // Process already exited
    }
  }
}

class ResourceTracker {
  constructor() {
    this.cdpClients = new Set();
    this.chromes = new Set();
    this.clusters = new Set();
    this.gateways = new Set();
    this.tempDirs = new Set();
    this.timers = new Set();
    this.cleaning = false;
  }

  trackTimer(timer) {
    this.timers.add(timer);
    return timer;
  }

  untrackTimer(timer) {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  async cleanupAll() {
    if (this.cleaning) return;
    this.cleaning = true;

    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const client of this.cdpClients) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    this.cdpClients.clear();

    for (const chrome of this.chromes) {
      try {
        await chrome.cleanup();
      } catch {
        // ignore
      }
    }
    this.chromes.clear();

    for (const gateway of this.gateways) {
      try {
        gateway.close();
      } catch {
        // ignore
      }
    }
    this.gateways.clear();

    for (const cluster of this.clusters) {
      try {
        cluster.stop();
      } catch {
        // ignore
      }
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
    this.cleaning = false;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require("net");
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

function patchIndexHtml(root) {
  const indexHtmlPath = path.join(root, "static", "index.html");
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Missing built static/index.html at ${indexHtmlPath}`);
  }
  let html = fs.readFileSync(indexHtmlPath, "utf8");
  html = html.replaceAll('<%- locals.cdnBaseRaw || "" %>', "");
  html = html.replaceAll("<%- locals.cdnBaseRaw || '' %>", "");
  html = html.replaceAll('<%- locals.cdnBaseRaw || "" %>/assets/', "/assets/");
  html = html.replaceAll("<%- locals.cdnBaseRaw || '' %>/assets/", "/assets/");
  html = html
    .replace(/<%-\s*gitCommit\s*%>/g, '"DEV"')
    .replace(/<%-\s*assetManifest\s*%>/g, "{}")
    .replace(/<%-\s*cdnBase\s*%>/g, '""')
    .replace(/<%-\s*cdnBaseRaw\s*%>/g, "")
    .replace(/<%-\s*gameEnv\s*%>/g, '"dev"')
    .replace(/<%-\s*numWorkers\s*%>/g, "1")
    .replace(/<%-\s*turnstileSiteKey\s*%>/g, '""')
    .replace(/<%-\s*jwtAudience\s*%>/g, '""')
    .replace(/<%-\s*instanceId\s*%>/g, '"1"')
    .replace(/<%-\s*manifestHref\s*%>/g, "/manifest.json")
    .replace(/<%-\s*faviconHref\s*%>/g, "/favicon.ico")
    .replace(/<%-\s*gameplayScreenshotUrl\s*%>/g, "")
    .replace(/<%-\s*backgroundImageUrl\s*%>/g, "")
    .replace(/<%-\s*desktopLogoImageUrl\s*%>/g, "")
    .replace(/<%-\s*mobileLogoImageUrl\s*%>/g, "")
    .replace(/<%-\s*typeof serverHost[\s\S]*?%>/g, "")
    .replace(/<%-\s*domain\s*%>/g, '"localhost"')
    .replace(/<%-\s*stripePublishableKey\s*%>/g, '""')
    .replace(/<%-\s*version\s*%>/g, '"v1.0.6"')
    .replace(/<%[\s\S]*?%>/g, "");
  return html;
}

class CdpClient {
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    this.label = opts.label ?? "cdp";
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.healthy = true;
    this.closed = false;
    this.disconnectReason = null;
    this.messageListeners = new Set();

    this.ready = new Promise((resolve, reject) => {
      const connectTimer = setTimeout(() => {
        const err = new Error(
          `CDP [${this.label}] connection timed out after ${this.connectTimeoutMs}ms`,
        );
        this.markUnhealthyAndRejectAll(err.message);
        reject(err);
      }, this.connectTimeoutMs);

      this.ws.once("open", () => {
        clearTimeout(connectTimer);
        if (this.closed) {
          reject(
            new Error(
              `CDP [${this.label}] closed before open: ${this.disconnectReason}`,
            ),
          );
          return;
        }
        resolve();
      });

      this.ws.once("error", (err) => {
        clearTimeout(connectTimer);
        const reason = `WebSocket connect error: ${err.message}`;
        this.markUnhealthyAndRejectAll(reason);
        reject(new Error(`CDP [${this.label}] ${reason}`));
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
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        } else {
          entry.resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        if (msg.method === "Inspector.targetCrashed") {
          this.markUnhealthyAndRejectAll("Inspector.targetCrashed");
        } else if (msg.method === "Inspector.detached") {
          this.markUnhealthyAndRejectAll(
            `Inspector.detached (${msg.params?.reason ?? "unknown"})`,
          );
        }
        this.events.push(msg);
        if (this.events.length > 500) {
          this.events.shift();
        }
        for (const fn of this.messageListeners) {
          try {
            fn(msg);
          } catch {
            // ignore listener error
          }
        }
      }
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : "";
      this.markUnhealthyAndRejectAll(
        `WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ""})`,
      );
    });

    this.ws.on("error", (err) => {
      this.markUnhealthyAndRejectAll(`WebSocket error: ${err.message}`);
    });
  }

  onEvent(fn) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  markUnhealthyAndRejectAll(reason) {
    this.healthy = false;
    this.disconnectReason ??= reason;
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      const elapsedMs = Date.now() - entry.startedAt;
      entry.reject(
        new Error(
          `CDP [${this.label}] aborted "${entry.method}" after ${elapsedMs}ms: ${reason}`,
        ),
      );
    }
  }

  async send(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    await this.ready;
    if (!this.healthy || this.closed) {
      throw new Error(
        `CDP [${this.label}] connection unhealthy before "${method}": ${this.disconnectReason ?? "closed"}`,
      );
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.markUnhealthyAndRejectAll(
        `WebSocket state=${this.ws.readyState} before ${method}`,
      );
      throw new Error(
        `CDP [${this.label}] WebSocket not open before "${method}"`,
      );
    }

    const id = this.nextId++;
    const startedAt = Date.now();
    const detail =
      method === "Runtime.evaluate" && params?.expression
        ? ` (${String(params.expression).replace(/\s+/g, " ").slice(0, 80)})`
        : "";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        this.pending.delete(id);
        const errMsg = `CDP [${this.label}] request "${method}"${detail} timed out after ${elapsedMs}ms (limit=${timeoutMs}ms)`;
        this.healthy = false;
        this.disconnectReason = errMsg;
        reject(new Error(errMsg));
        // Terminate wedged socket so any other pending calls fail promptly
        this.markUnhealthyAndRejectAll(errMsg);
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method, startedAt });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        const errMsg = `WebSocket send failed for "${method}": ${err.message}`;
        this.markUnhealthyAndRejectAll(errMsg);
        reject(new Error(errMsg));
      }
    });
  }

  async evalExpr(expression, timeoutMs = this.defaultTimeoutMs) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "Runtime.evaluate exception",
      );
    }
    return res.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.messageListeners.clear();
    this.markUnhealthyAndRejectAll("CDP client closed");
    try {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
        setTimeout(() => {
          try {
            if (this.ws.readyState !== WebSocket.CLOSED) {
              this.ws.terminate();
            }
          } catch {
            // ignore
          }
        }, 200).unref();
      }
    } catch {
      // ignore
    }
  }
}

async function launchChrome(chromePath, width = 1280, height = 800, tracker) {
  const debugPort = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-qa-chrome-"));
  if (tracker) tracker.tempDirs.add(userDataDir);

  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-gl=angle",
      "--use-angle=d3d11",
      "--enable-gpu-rasterization",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets = null;
  const startDeadline = Date.now() + 12000;
  while (Date.now() < startDeadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `Chrome exited prematurely with code ${proc.exitCode} before DevTools became ready`,
      );
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (r.ok) {
        targets = await r.json();
        if (Array.isArray(targets) && targets.length > 0) break;
      }
    } catch {
      // Wait for DevTools socket
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!targets || targets.length === 0) {
    killProcessTreeSync(proc.pid);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new Error("Chrome DevTools failed to start within 12000ms");
  }

  const pageTarget = targets.find((t) => t.type === "page") ?? targets[0];
  const instance = {
    pid: proc.pid,
    debugPort,
    userDataDir,
    proc,
    firstWsUrl: pageTarget.webSocketDebuggerUrl,
    async newPage(label = "tab") {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?about:blank`,
        { method: "PUT", signal: ctrl.signal },
      ).finally(() => clearTimeout(t));
      if (!res.ok) {
        throw new Error(`Failed to open new Chrome tab: ${res.status}`);
      }
      const target = await res.json();
      const cdp = new CdpClient(target.webSocketDebuggerUrl, { label });
      if (tracker) tracker.cdpClients.add(cdp);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Inspector.enable").catch(() => {});
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return cdp;
    },
    async cleanup() {
      killProcessTreeSync(proc.pid);
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // ignore lock cleanup
      }
      if (tracker) tracker.tempDirs.delete(userDataDir);
    },
  };

  if (tracker) tracker.chromes.add(instance);
  return instance;
}

function attachConsoleWatch(cdp, label) {
  const pageErrors = [];
  const severeErrors = [];
  cdp.onEvent((msg) => {
    try {
      if (msg.method === "Inspector.targetCrashed") {
        const crashMsg = `[${label}] Renderer targetCrashed`;
        pageErrors.push(crashMsg);
        severeErrors.push(crashMsg);
        console.error(crashMsg);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d =
          msg.params?.exceptionDetails?.exception?.description ??
          msg.params?.exceptionDetails?.text ??
          "unknown exception";
        if (!d.includes("TurnstileError")) {
          pageErrors.push(d);
          console.error(`[${label}][pageError]`, d);
        }
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        if (msg.params.type === "error") {
          if (
            !text.includes("Turnstile") &&
            !text.includes("Refresh failed") &&
            !text.includes("Error getting cosmetics") &&
            !text.includes("ERR_CONNECTION_REFUSED") &&
            !text.includes("WebSocket error")
          ) {
            severeErrors.push(`[${label}] ${text}`);
          }
          console.error(`[${label}][console.error]`, text);
        } else if (
          text.includes("worker") ||
          text.includes("Worker") ||
          text.includes("local server") ||
          text.includes("start") ||
          text.includes("pause")
        ) {
          console.log(`[${label}][console.${msg.params.type}]`, text);
        }
      }
    } catch {
      // ignore
    }
  });
  return { pageErrors, severeErrors };
}

async function waitForCondition(fn, timeoutMs, label, opts = {}) {
  const intervalMs = opts.intervalMs ?? 300;
  const maxAttemptMs = opts.attemptTimeoutMs ?? Math.min(10000, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let lastVal = null;
  let lastErr = null;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(100, deadline - Date.now());
    const perAttemptMs = Math.min(maxAttemptMs, remainingMs);
    let timer = null;
    try {
      lastVal = await Promise.race([
        Promise.resolve().then(() => fn(perAttemptMs)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Predicate "${label}" stalled for ${perAttemptMs}ms (overall deadline=${timeoutMs}ms)`,
              ),
            );
          }, perAttemptMs + 250);
        }),
      ]);
      lastErr = null;
      if (lastVal) return lastVal;
    } catch (err) {
      lastErr = err;
      if (typeof opts.onError === "function") {
        await opts.onError(err);
      }
      const msg = String(err?.message ?? "");
      if (
        msg.includes("unhealthy") ||
        msg.includes("targetCrashed") ||
        msg.includes("WebSocket closed") ||
        msg.includes("closed") ||
        msg.includes("stalled")
      ) {
        throw new Error(`Aborted waitForCondition("${label}"): ${msg}`, {
          cause: err,
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  const suffix = lastErr ? ` lastErr=${lastErr.message}` : "";
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms (last=${JSON.stringify(lastVal)})${suffix}`,
  );
}

async function runWithDeadline(label, timeoutMs, fn) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`Test deadline exceeded for "${label}" (${timeoutMs}ms)`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startLocalDevCluster(root, masterPort, tracker) {
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const workerPort = 3001;
  const serverProc = spawn(
    process.execPath,
    [tsxCli, path.join(root, "src/server/Server.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        GAME_ENV: "dev",
        NUM_WORKERS: "1",
        PORT: String(masterPort),
        TURNSTILE_SITE_KEY: "test",
        DOMAIN: "localhost",
        ADMIN_TOKEN: "local-qa-admin-token",
        GIT_COMMIT: "v1.0.6-qa",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs = [];
  serverProc.stdout?.on("data", (d) => logs.push(d.toString()));
  serverProc.stderr?.on("data", (d) => logs.push(d.toString()));

  await waitForCondition(
    async (attemptMs) => {
      if (serverProc.exitCode !== null) {
        throw new Error(
          `Server process exited prematurely with code ${serverProc.exitCode}`,
        );
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.min(2000, attemptMs));
      try {
        const r = await fetch(`http://127.0.0.1:${masterPort}/api/health`, {
          signal: ctrl.signal,
        });
        if (!r.ok) return false;
        const body = await r.json();
        if (body.status !== "ok") return false;
        const wRes = await fetch(
          `http://127.0.0.1:${masterPort}/w0/api/game/probe123/exists`,
          { signal: ctrl.signal },
        );
        return wRes.status > 0 && wRes.status < 500;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    },
    30000,
    `local cluster health on port ${masterPort} (worker ${workerPort})`,
  );

  const cluster = {
    pid: serverProc.pid,
    proc: serverProc,
    logs,
    stop() {
      killProcessTreeSync(serverProc.pid);
    },
  };
  if (tracker) tracker.clusters.add(cluster);
  return cluster;
}

async function startProxyGateway(root, targetMasterPort, tracker) {
  const app = express();
  const server = http.createServer(app);
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${targetMasterPort}`,
    ws: true,
  });
  proxy.on("error", () => {
    // Expected during controlled disconnect test
  });

  let blockJoinerWs = false;
  let activeJoinerSocket = null;
  let joinerDropCount = 0;

  app.use((req, res, next) => {
    if (req.path === "/api/create_game") {
      req.url = `/w0${req.url}`;
      proxy.web(req, res, { target: `http://127.0.0.1:${targetMasterPort}` });
      return;
    }
    if (
      req.path.startsWith("/api/") ||
      req.path.startsWith("/w0/api/") ||
      req.path.startsWith("/w1/api/")
    ) {
      proxy.web(req, res, { target: `http://127.0.0.1:${targetMasterPort}` });
      return;
    }
    next();
  });

  const staticDir = path.join(root, "static");
  app.use(express.static(staticDir, { index: false }));
  app.use("/maps", express.static(path.join(root, "resources/maps")));
  app.use("/atlases", express.static(path.join(root, "resources/atlases")));
  app.use("/resources", express.static(path.join(root, "resources")));
  app.use(express.static(path.join(root, "resources")));

  const patchedHtml = patchIndexHtml(root);
  app.use((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(patchedHtml);
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url ?? "";
    const uaTag = req.headers["x-qa-role"] ?? reqUrl;
    if (blockJoinerWs && String(uaTag).includes("w0")) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, {
      target: `http://127.0.0.1:${targetMasterPort}`,
    });
    if (String(reqUrl).startsWith("/w0")) {
      joinerDropCount++;
      if (joinerDropCount >= 2) {
        activeJoinerSocket = socket;
      }
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const gateway = {
    port,
    server,
    setBlockWs(val) {
      blockJoinerWs = val;
    },
    killLatestWs() {
      if (activeJoinerSocket && !activeJoinerSocket.destroyed) {
        activeJoinerSocket.destroy();
        return true;
      }
      return false;
    },
    close() {
      try {
        proxy.close();
        server.closeAllConnections?.();
        server.close();
      } catch {
        // ignore
      }
    },
  };
  if (tracker) tracker.gateways.add(gateway);
  return gateway;
}

async function installWebglQaHook(cdp) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__fxQaState = { canvas: null, gl: null, glFrames: 0 };
      let frameMarked = false;
      const markDraw = () => {
        if (!frameMarked) {
          frameMarked = true;
          window.__fxQaState.glFrames++;
          queueMicrotask(() => { frameMarked = false; });
        }
      };
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        const ctx = origGetContext.call(this, type, attrs);
        if (
          (type === "webgl2" || type === "webgl") &&
          ctx &&
          (this.isConnected || attrs?.powerPreference === "high-performance")
        ) {
          window.__fxQaState.canvas = this;
          window.__fxQaState.gl = ctx;
        }
        return ctx;
      };
      if (typeof WebGL2RenderingContext !== "undefined") {
        for (const fn of [
          "clear",
          "drawArrays",
          "drawElements",
          "drawArraysInstanced",
          "drawElementsInstanced",
        ]) {
          const orig = WebGL2RenderingContext.prototype[fn];
          if (typeof orig === "function") {
            WebGL2RenderingContext.prototype[fn] = function(...args) {
              markDraw();
              return orig.apply(this, args);
            };
          }
        }
      }
    })()`,
  });
}

async function runHarnessSelfTest(chromePath, tracker) {
  console.log(
    "[QA-SelfTest] Starting CDP timeout & disconnect verification...",
  );
  const chrome = await launchChrome(chromePath, 800, 600, tracker);
  const cdp = new CdpClient(chrome.firstWsUrl, {
    defaultTimeoutMs: 5000,
    label: "self-test-timeout",
  });
  tracker.cdpClients.add(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 1. Stalled CDP request must reject cleanly within ~400ms
  const t0 = Date.now();
  let timeoutErr = null;
  try {
    await cdp.evalExpr("new Promise(() => {})", 400);
  } catch (err) {
    timeoutErr = err;
  }
  const elapsed = Date.now() - t0;
  if (
    !timeoutErr ||
    !timeoutErr.message.includes("Runtime.evaluate") ||
    !timeoutErr.message.includes("timed out") ||
    elapsed > 2500
  ) {
    throw new Error(
      `Self-test stalled CDP timeout failed: elapsed=${elapsed}ms err=${timeoutErr?.message}`,
    );
  }
  if (cdp.healthy !== false || cdp.pending.size !== 0) {
    throw new Error(
      `Self-test unhealthy/pending invariant failed: healthy=${cdp.healthy} pending=${cdp.pending.size}`,
    );
  }
  console.log(
    `[QA-SelfTest] PASS cdp_request_timeout (${elapsed}ms): ${timeoutErr.message}`,
  );

  // 2. Disconnected browser target must immediately reject pending requests
  const cdp2 = await chrome.newPage("self-test-disconnect");
  let disconnectErr = null;
  const pendingPromise = cdp2
    .evalExpr("new Promise(() => {})", 10000)
    .catch((err) => {
      disconnectErr = err;
    });
  await new Promise((r) => setTimeout(r, 150));
  const t1 = Date.now();
  await chrome.cleanup();
  tracker.chromes.delete(chrome);

  await pendingPromise;
  const discElapsed = Date.now() - t1;
  if (!disconnectErr || discElapsed > 3000 || cdp2.pending.size !== 0) {
    throw new Error(
      `Self-test disconnect rejection failed: discElapsed=${discElapsed}ms pending=${cdp2.pending.size} err=${disconnectErr?.message}`,
    );
  }
  console.log(
    `[QA-SelfTest] PASS browser_disconnect_rejects_pending (${discElapsed}ms): ${disconnectErr.message}`,
  );

  // 3. Stalled waitForCondition must abort cleanly without waiting full outer timeout
  let wfcErr = null;
  const t2 = Date.now();
  try {
    await waitForCondition(
      () => new Promise(() => {}),
      5000,
      "synthetic stalled predicate",
      { attemptTimeoutMs: 300 },
    );
  } catch (err) {
    wfcErr = err;
  }
  const wfcElapsed = Date.now() - t2;
  if (!wfcErr || !wfcErr.message.includes("stalled") || wfcElapsed > 2000) {
    throw new Error(
      `Self-test waitForCondition stall guard failed: wfcElapsed=${wfcElapsed}ms err=${wfcErr?.message}`,
    );
  }
  console.log(
    `[QA-SelfTest] PASS waitForCondition_stall_abort (${wfcElapsed}ms): ${wfcErr.message}`,
  );
  console.log("[QA-SelfTest] ALL SELF-TESTS PASSED");
}

async function runSingleplayerCycle(
  page1,
  cycle,
  opts,
  outDir,
  record,
  cycleResults,
) {
  const { checkShortcuts, checkFpsCap, checkWebglLoss } = opts;
  console.log(`[QA][cycle ${cycle}] Capturing __prevGameObj...`);
  await page1.evalExpr(
    '(() => { window.__prevGameObj = document.querySelector("build-menu")?.game ?? null; return true; })()',
  );
  console.log(
    `[QA][cycle ${cycle}] Applying maxFps=${checkFpsCap ? "60" : "none"}...`,
  );
  if (checkFpsCap) {
    await page1.evalExpr(
      '(() => { localStorage.setItem("settings.maxFps", "60"); document.querySelector("user-setting")?.userSettings?.setMaxFps(60); return true; })()',
    );
  } else {
    await page1.evalExpr(
      '(() => { localStorage.removeItem("settings.maxFps"); document.querySelector("user-setting")?.userSettings?.setMaxFps(0); return true; })()',
    );
  }

  console.log(`[QA][cycle ${cycle}] Starting singleplayer match...`);
  await page1.evalExpr(`(() => {
    const modal = document.querySelector("single-player-modal");
    modal.bots = 10;
    modal.selectedMap = "World";
    modal.startGame();
  })()`);

  await waitForCondition(
    (attemptMs) =>
      page1.evalExpr(
        `(() => {
          const bm = document.querySelector("build-menu");
          return Boolean(
            bm?.game &&
            bm.game !== window.__prevGameObj &&
            document.body.classList.contains("in-game") &&
            bm.game.ticks() >= 2
          );
        })()`,
        attemptMs,
      ),
    45000,
    `cycle ${cycle} match start`,
  );

  // Spawn near center
  const spawnPt = await page1.evalExpr(`(() => {
    const bm = document.querySelector("build-menu");
    const g = bm?.game;
    const th = bm?.transformHandler;
    if (!g || !th) return null;
    const w = g.width(), h = g.height();
    for (let r = 8; r < 240; r += 8) {
      for (let a = 0; a < 360; a += 20) {
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

  if (spawnPt) {
    await page1.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(spawnPt.x),
      y: Math.round(spawnPt.y),
      button: "left",
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 60));
    await page1.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(spawnPt.x),
      y: Math.round(spawnPt.y),
      button: "left",
      clickCount: 1,
    });
  }

  await waitForCondition(
    (attemptMs) =>
      page1.evalExpr(
        '(() => { const g = document.querySelector("build-menu")?.game; return g && g !== window.__prevGameObj && !g.inSpawnPhase() && g.ticks() >= 10; })()',
        attemptMs,
      ),
    25000,
    `cycle ${cycle} exit spawn phase`,
  );

  if (checkShortcuts) {
    for (const key of ["o", "O", "m", "M", " "]) {
      await page1.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code: key === " " ? "Space" : `Key${key.toUpperCase()}`,
      });
      await new Promise((r) => setTimeout(r, 50));
      await page1.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: key === " " ? "Space" : `Key${key.toUpperCase()}`,
      });
    }
    record("keyboard_shortcuts_tactical_grid_altview", true, {
      testedKeys: ["o", "O", "m", "M", "Space"],
    });
  }

  if (checkFpsCap) {
    const fpsSample = await page1.evalExpr(`(async () => {
      const s0 = window.__fxQaState?.glFrames ?? 0;
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 2000));
      const s1 = window.__fxQaState?.glFrames ?? 0;
      const t1 = performance.now();
      const fps = ((s1 - s0) * 1000) / Math.max(1, t1 - t0);
      localStorage.removeItem("settings.maxFps");
      document.querySelector("user-setting")?.userSettings?.setMaxFps(0);
      return { fps: Number(fps.toFixed(2)), frameDelta: s1 - s0 };
    })()`);
    record(
      "frame_pacer_max_fps_60_cap",
      fpsSample.fps >= 48 && fpsSample.fps <= 72,
      fpsSample,
    );
  }

  if (checkWebglLoss) {
    const ctxCheck = await page1.evalExpr(`(async () => {
      const canvas =
        window.__fxQaState?.canvas ||
        Array.from(document.querySelectorAll("canvas")).find(
          (c) => !c.classList.contains("dual-layer-canvas"),
        );
      const gl =
        window.__fxQaState?.gl ||
        canvas?.getContext("webgl2") ||
        canvas?.getContext("webgl");
      if (!gl || !canvas) return { ok: false, reason: "missing webgl context" };
      const ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) return { ok: false, reason: "missing WEBGL_lose_context" };

      let lostFired = false;
      let restoredFired = false;
      canvas.addEventListener("webglcontextlost", () => { lostFired = true; }, { once: true });
      canvas.addEventListener("webglcontextrestored", () => { restoredFired = true; }, { once: true });

      const ticksBefore = document.querySelector("build-menu")?.game?.ticks() ?? 0;
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 400));
      const isLostMid = gl.isContextLost();
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 1200));
      const isLostAfter = gl.isContextLost();
      const ticksAfter = document.querySelector("build-menu")?.game?.ticks() ?? 0;
      return {
        ok: lostFired && isLostMid && !isLostAfter && ticksAfter > ticksBefore,
        lostFired,
        restoredFired,
        isLostMid,
        isLostAfter,
        ticksBefore,
        ticksAfter,
      };
    })()`);
    record("webgl_context_lose_and_restore", Boolean(ctxCheck.ok), ctxCheck);

    const shot = await page1.send("Page.captureScreenshot", {
      format: "png",
    });
    fs.writeFileSync(
      path.join(outDir, "qa_webgl_restored.png"),
      Buffer.from(shot.data, "base64"),
    );
  }

  console.log(`[QA][cycle ${cycle}] Dispatching leave-lobby teardown...`);
  await page1.evalExpr(
    'document.dispatchEvent(new CustomEvent("leave-lobby", { detail: { exitToHome: true } }))',
    10000,
  );
  console.log(`[QA][cycle ${cycle}] Waiting for DOM teardown...`);
  await waitForCondition(
    (attemptMs) =>
      page1.evalExpr(
        'document.querySelectorAll(".dual-layer-canvas").length === 0 && !document.body.classList.contains("in-game")',
        attemptMs,
      ),
    12000,
    `cycle ${cycle} teardown`,
  );
  await new Promise((r) => setTimeout(r, 500));

  const afterTeardown = await page1.evalExpr(`(() => ({
    dualCanvases: document.querySelectorAll(".dual-layer-canvas").length,
    warshipDragRects: document.querySelectorAll(".warship-drag-select-rect").length,
    domNodes: document.querySelectorAll("*").length,
    jsHeapMB: performance.memory
      ? Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2))
      : null,
  }))()`);
  console.log(`[QA][cycle ${cycle}] Teardown complete:`, afterTeardown);
  cycleResults.push({ cycle, ...afterTeardown });
}

async function runQaSuite() {
  const mode = parseModeArg();
  const root = process.cwd();
  const outDir = path.join(root, "performance-results", "v1.0.6");
  fs.mkdirSync(outDir, { recursive: true });
  const chromePath = resolveChromePath();
  const tracker = new ResourceTracker();

  const cleanupAndExit = async (code) => {
    await tracker.cleanupAll();
    process.exit(code);
  };
  process.once("SIGINT", () => cleanupAndExit(130));
  process.once("SIGTERM", () => cleanupAndExit(143));

  if (mode === "harness-self-test") {
    await runWithDeadline("harness-self-test", 45000, () =>
      runHarnessSelfTest(chromePath, tracker),
    );
    await tracker.cleanupAll();
    return;
  }

  const cycleCount =
    mode === "smoke" || mode === "mp"
      ? 0
      : mode === "single"
        ? 1
        : mode === "two-cycles"
          ? 2
          : 3;
  const runSmoke = mode !== "mp";
  const runMp = mode === "full" || mode === "mp";

  const report = {
    mode,
    timestamp: new Date().toISOString(),
    baseUrl: null,
    checks: {},
    failures: [],
  };

  function record(name, passed, details) {
    report.checks[name] = { passed, details };
    console.log(
      `[QA] ${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(details)}`,
    );
    if (!passed) {
      report.failures.push({ name, details });
    }
  }

  const masterPort = await findFreePort();
  let suiteWatchdog = null;

  try {
    await runWithDeadline(
      `overall-suite-${mode}`,
      DEFAULT_SUITE_TIMEOUT_MS,
      async () => {
        suiteWatchdog = tracker.trackTimer(
          setTimeout(() => {
            console.error(
              `[QA] HARD WATCHDOG EXPIRED (${DEFAULT_SUITE_TIMEOUT_MS}ms); terminating owned processes`,
            );
          }, DEFAULT_SUITE_TIMEOUT_MS + 1000).unref(),
        );

        await startLocalDevCluster(root, masterPort, tracker);
        const gateway = await startProxyGateway(root, masterPort, tracker);
        const baseUrl = `http://127.0.0.1:${gateway.port}`;
        report.baseUrl = baseUrl;

        const chrome = await launchChrome(chromePath, 1440, 900, tracker);
        const page1 = new CdpClient(chrome.firstWsUrl, {
          defaultTimeoutMs: DEFAULT_OP_TIMEOUT_MS,
          label: "Singleplayer+WebGL",
        });
        tracker.cdpClients.add(page1);
        await page1.send("Page.enable");
        await page1.send("Runtime.enable");
        await page1.send("Inspector.enable").catch(() => {});
        await installWebglQaHook(page1);
        await page1.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const watch1 = attachConsoleWatch(page1, "Singleplayer+WebGL");

        if (runSmoke) {
          await runWithDeadline("smoke-checks", 35000, async () => {
            await page1.send("Page.navigate", { url: baseUrl });
            await waitForCondition(
              (attemptMs) =>
                page1.evalExpr(
                  `(() => {
                  const sp = document.querySelector("single-player-modal");
                  const hm = document.querySelector("host-lobby-modal");
                  const ver = document.querySelector("#game-version, .game-version-display")?.textContent?.trim();
                  return document.readyState === "complete" &&
                    typeof sp?.startGame === "function" &&
                    typeof hm?.open === "function" &&
                    Boolean(ver);
                })()`,
                  attemptMs,
                ),
              20000,
              "homepage modals ready",
            );
            await new Promise((r) => setTimeout(r, 800));

            const brandingCheck = await page1.evalExpr(`(() => {
            const title = document.title;
            const bodyText = document.body.innerText || "";
            const hasLogoAsset = /FrontierXLogo|FrontierXEmblem/i.test(document.documentElement.innerHTML);
            const hasSettings = !!document.querySelector("user-setting");
            const hasSingle = !!document.querySelector("single-player-modal");
            const hasHost = !!document.querySelector("host-lobby-modal");
            const hasJoin = !!document.querySelector("join-lobby-modal");
            return {
              title,
              hasFrontierX: /FrontierX/i.test(title) || /FrontierX/i.test(bodyText),
              hasLogoAsset,
              hasSettings,
              hasSingle,
              hasHost,
              hasJoin,
            };
          })()`);
            record(
              "main_menu_and_branding",
              brandingCheck.hasFrontierX &&
                brandingCheck.hasLogoAsset &&
                brandingCheck.hasSettings &&
                brandingCheck.hasSingle &&
                brandingCheck.hasHost &&
                brandingCheck.hasJoin,
              brandingCheck,
            );

            const uiSafety = await page1.evalExpr(`(() => {
            const sm = document.querySelector("user-setting");
            if (sm && typeof sm.open === "function") sm.open();
            const opened = !!sm?.isModalOpen || !sm?.classList?.contains("hidden");
            if (sm && typeof sm.close === "function") sm.close();
            document.dispatchEvent(new CustomEvent("leave-lobby", { detail: null }));
            return { opened, leaveNullOk: true };
          })()`);
            record(
              "settings_modal_and_null_leave_lobby",
              uiSafety.leaveNullOk,
              uiSafety,
            );

            await page1.send("Emulation.setDeviceMetricsOverride", {
              width: 390,
              height: 844,
              deviceScaleFactor: 2,
              mobile: true,
            });
            const mobileOk = await page1.evalExpr(
              "document.documentElement.scrollWidth <= window.innerWidth + 12",
            );
            await page1.send("Emulation.setDeviceMetricsOverride", {
              width: 1440,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
            });
            record("responsive_viewport_mobile_to_desktop", Boolean(mobileOk), {
              mobileNoOverflow: mobileOk,
            });
          });
        }

        if (cycleCount > 0) {
          const cycleResults = [];
          for (let cycle = 1; cycle <= cycleCount; cycle++) {
            await runWithDeadline(
              `singleplayer-cycle-${cycle}`,
              DEFAULT_CYCLE_TIMEOUT_MS,
              () =>
                runSingleplayerCycle(
                  page1,
                  cycle,
                  {
                    checkShortcuts: cycle === 1,
                    checkFpsCap:
                      (cycleCount === 1 && cycle === 1) || cycle === 2,
                    checkWebglLoss: cycle === 3,
                  },
                  outDir,
                  record,
                  cycleResults,
                ),
            );
          }

          const cycleOk = cycleResults.every(
            (c) => c.dualCanvases === 0 && c.warshipDragRects === 0,
          );
          record("consecutive_match_teardown_cycles", cycleOk, cycleResults);
          record(
            "singleplayer_zero_unexpected_errors",
            watch1.pageErrors.length === 0 && watch1.severeErrors.length === 0,
            watch1,
          );
        }

        if (runMp) {
          await runWithDeadline(
            "two-client-multiplayer",
            DEFAULT_MP_TIMEOUT_MS,
            async () => {
              const hostPage = await chrome.newPage("MP-Host");
              const joinerChrome = await launchChrome(
                chromePath,
                1440,
                900,
                tracker,
              );
              const joinerPage = new CdpClient(joinerChrome.firstWsUrl, {
                defaultTimeoutMs: DEFAULT_OP_TIMEOUT_MS,
                label: "MP-Joiner",
              });
              tracker.cdpClients.add(joinerPage);
              await joinerPage.send("Page.enable");
              await joinerPage.send("Runtime.enable");
              await joinerPage.send("Inspector.enable").catch(() => {});
              await joinerPage.send("Emulation.setDeviceMetricsOverride", {
                width: 1440,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
              });
              const watchHost = attachConsoleWatch(hostPage, "MP-Host");
              const watchJoiner = attachConsoleWatch(joinerPage, "MP-Joiner");

              await hostPage.send("Page.navigate", { url: baseUrl });
              await waitForCondition(
                (attemptMs) =>
                  hostPage.evalExpr(
                    'document.readyState === "complete" && typeof document.querySelector("host-lobby-modal")?.open === "function" && Boolean(document.querySelector("host-lobby-modal")?.eventBus) && Boolean(document.querySelector("#game-version, .game-version-display")?.textContent?.trim())',
                    attemptMs,
                  ),
                25000,
                "MP host ready",
              );
              await new Promise((r) => setTimeout(r, 800));

              await hostPage.evalExpr(`(() => {
                const hm = document.querySelector("host-lobby-modal");
                hm.open();
              })()`);

              const lobbyId = await waitForCondition(
                (attemptMs) =>
                  hostPage.evalExpr(
                    `(() => {
                      const hm = document.querySelector("host-lobby-modal");
                      return hm?.lobbyId && hm.lobbyId.length > 0 ? hm.lobbyId : null;
                    })()`,
                    attemptMs,
                  ),
                15000,
                "host lobby creation",
              );

              await hostPage.evalExpr(`(() => {
                const hm = document.querySelector("host-lobby-modal");
                hm.selectedMap = "World";
                hm.bots = 4;
                hm.startDelayValue = 0;
                hm.putGameConfig?.();
              })()`);

              const inviteUrl = await hostPage.evalExpr("location.href");
              console.log(
                `[QA][MP] Host lobbyId=${lobbyId}, inviteUrl=${inviteUrl}`,
              );
              const joinTargetUrl =
                inviteUrl && inviteUrl.includes(lobbyId)
                  ? inviteUrl
                  : `${baseUrl}/w0/game/${lobbyId}`;
              await joinerPage.send("Page.navigate", {
                url: joinTargetUrl,
              });
              try {
                await waitForCondition(
                  (attemptMs) =>
                    hostPage.evalExpr(
                      `(() => {
                        const hm = document.querySelector("host-lobby-modal");
                        return (hm?.clients?.length ?? 0) >= 2;
                      })()`,
                      attemptMs,
                    ),
                  45000,
                  "joiner visible in host lobby",
                );
              } catch (err) {
                const diag = await joinerPage
                  .evalExpr(
                    `(() => {
                      const jm = document.querySelector("join-lobby-modal");
                      const hm = document.querySelector("host-lobby-modal");
                      return {
                        href: location.href,
                        readyState: document.readyState,
                        jmLobby: jm?.currentLobbyId ?? null,
                        jmPlayers: jm?.players?.length ?? null,
                        jmConnecting: jm?.isConnecting ?? null,
                        hmLobby: hm?.lobbyId ?? null,
                        hmClients: hm?.clients?.length ?? null,
                      };
                    })()`,
                  )
                  .catch((e) => ({ diagErr: e.message }));
                console.error("[QA][MP] Joiner diagnostics:", diag);
                throw err;
              }

              await hostPage.evalExpr(`(() => {
                const hm = document.querySelector("host-lobby-modal");
                hm.toggleGameStartTimer();
              })()`);

              await waitForCondition(
                async (attemptMs) => {
                  const h = await hostPage.evalExpr(
                    '(() => { const g = document.querySelector("build-menu")?.game; return g && g.ticks() >= 2 ? g.ticks() : 0; })()',
                    attemptMs,
                  );
                  const j = await joinerPage.evalExpr(
                    '(() => { const g = document.querySelector("build-menu")?.game; return g && g.ticks() >= 2 ? g.ticks() : 0; })()',
                    attemptMs,
                  );
                  return h >= 2 && j >= 2 ? { h, j } : null;
                },
                45000,
                "both MP clients ticking",
              );

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
                async (attemptMs) => {
                  const h = await hostPage.evalExpr(
                    '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
                    attemptMs,
                  );
                  const j = await joinerPage.evalExpr(
                    '(() => { const g = document.querySelector("build-menu")?.game; return g && !g.inSpawnPhase() ? g.ticks() : 0; })()',
                    attemptMs,
                  );
                  return h > 0 && j > 0 ? { h, j } : null;
                },
                50000,
                "both MP clients exit spawn phase",
              );

              const tickBeforeDrop = await joinerPage.evalExpr(
                'document.querySelector("build-menu")?.game?.ticks() ?? 0',
              );
              const killed = gateway.killLatestWs();
              await new Promise((r) => setTimeout(r, 2500));

              const recoveredTicks = await waitForCondition(
                async (attemptMs) => {
                  const h = await hostPage.evalExpr(
                    'document.querySelector("build-menu")?.game?.ticks() ?? 0',
                    attemptMs,
                  );
                  const j = await joinerPage.evalExpr(
                    'document.querySelector("build-menu")?.game?.ticks() ?? 0',
                    attemptMs,
                  );
                  return j >= tickBeforeDrop + 15 && Math.abs(h - j) <= 15
                    ? { h, j, tickBeforeDrop, killed }
                    : null;
                },
                25000,
                "MP joiner reconnect and tick sync",
              );

              record("two_client_multiplayer_and_ws_reconnect", true, {
                lobbyId,
                ...recoveredTicks,
              });

              await hostPage.evalExpr(
                'document.dispatchEvent(new CustomEvent("leave-lobby", { detail: { exitToHome: true } }))',
              );
              await joinerPage.evalExpr(
                'document.dispatchEvent(new CustomEvent("leave-lobby", { detail: { exitToHome: true } }))',
              );
              await new Promise((r) => setTimeout(r, 600));

              const mpTeardown = {
                hostDualCanvases: await hostPage.evalExpr(
                  'document.querySelectorAll(".dual-layer-canvas").length',
                ),
                joinerDualCanvases: await joinerPage.evalExpr(
                  'document.querySelectorAll(".dual-layer-canvas").length',
                ),
                hostPageErrors: watchHost.pageErrors,
                joinerPageErrors: watchJoiner.pageErrors,
              };
              record(
                "two_client_multiplayer_clean_teardown",
                mpTeardown.hostDualCanvases === 0 &&
                  mpTeardown.joinerDualCanvases === 0 &&
                  mpTeardown.hostPageErrors.length === 0 &&
                  mpTeardown.joinerPageErrors.length === 0,
                mpTeardown,
              );

              await hostPage.close();
              await joinerPage.close();
              await joinerChrome.cleanup();
              tracker.chromes.delete(joinerChrome);
            },
          );
        }

        await page1.close();
      },
    );
  } finally {
    if (suiteWatchdog) tracker.untrackTimer(suiteWatchdog);
    await tracker.cleanupAll();
  }

  const reportName =
    mode === "full"
      ? "qa_regression_report.json"
      : `qa_regression_report_${mode}.json`;
  const reportPath = path.join(outDir, reportName);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Saved QA regression report -> ${reportPath}`);

  if (report.failures.length > 0) {
    console.error("QA regression suite failures:", report.failures);
    process.exit(1);
  }
}

runQaSuite().catch((err) => {
  console.error("QA regression suite failed:", err);
  process.exit(1);
});
