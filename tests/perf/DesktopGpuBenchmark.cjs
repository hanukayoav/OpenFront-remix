const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const os = require("os");
const fs = require("fs");

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    versionLabel: "v1.0.6",
    profile: "smoke",
    durationSec: 60,
    sampleSec: 15,
    width: 1920,
    height: 1080,
    dpr: 1,
    cpuThrottle: 1,
    maxOldSpaceMb: 0,
    bots: 25,
    map: "World",
    seed: 1337,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    stressBuild: false,
    screenshotAtSec: -1,
    screenshotPath: "",
    outDir: path.join(process.cwd(), "performance-results", "v1.0.6"),
  };

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = argv[i + 1];
    switch (k) {
      case "--root":
        opts.root = path.resolve(next);
        i++;
        break;
      case "--version-label":
        opts.versionLabel = next;
        i++;
        break;
      case "--profile":
        opts.profile = next;
        i++;
        break;
      case "--duration-sec":
        opts.durationSec = parseFloat(next);
        i++;
        break;
      case "--sample-sec":
        opts.sampleSec = parseFloat(next);
        i++;
        break;
      case "--width":
        opts.width = parseInt(next, 10);
        i++;
        break;
      case "--height":
        opts.height = parseInt(next, 10);
        i++;
        break;
      case "--dpr":
        opts.dpr = parseFloat(next);
        i++;
        break;
      case "--cpu":
        opts.cpuThrottle = parseFloat(next);
        i++;
        break;
      case "--max-old-space-mb":
        opts.maxOldSpaceMb = parseInt(next, 10);
        i++;
        break;
      case "--bots":
        opts.bots = parseInt(next, 10);
        i++;
        break;
      case "--map":
        opts.map = next;
        i++;
        break;
      case "--seed":
        opts.seed = parseInt(next, 10);
        i++;
        break;
      case "--infinite-gold":
        opts.infiniteGold = true;
        break;
      case "--infinite-troops":
        opts.infiniteTroops = true;
        break;
      case "--instant-build":
        opts.instantBuild = true;
        break;
      case "--stress-build":
        opts.stressBuild = true;
        break;
      case "--screenshot-at":
        opts.screenshotAtSec = parseFloat(next);
        i++;
        break;
      case "--screenshot-path":
        opts.screenshotPath = path.resolve(next);
        i++;
        break;
      case "--out-dir":
        opts.outDir = path.resolve(next);
        i++;
        break;
      default:
        break;
    }
  }
  return opts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * p)),
  );
  return sorted[idx];
}

function computeStats(samples, key) {
  const vals = samples
    .map((s) => s[key])
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (vals.length === 0) return { min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const sum = vals.reduce((acc, v) => acc + v, 0);
  return {
    min: Number(vals[0].toFixed(2)),
    median: Number(percentile(vals, 0.5).toFixed(2)),
    p95: Number(percentile(vals, 0.95).toFixed(2)),
    max: Number(vals[vals.length - 1].toFixed(2)),
    mean: Number((sum / vals.length).toFixed(2)),
  };
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

async function runBenchmark(opts) {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const staticDir = path.join(opts.root, "static");
  const indexHtmlPath = path.join(staticDir, "index.html");
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Missing built static/index.html at ${indexHtmlPath}`);
  }

  const app = express();
  app.use(express.static(staticDir, { index: false }));
  app.use("/maps", express.static(path.join(opts.root, "resources/maps")));
  app.use(
    "/atlases",
    express.static(path.join(opts.root, "resources/atlases")),
  );
  app.use("/resources", express.static(path.join(opts.root, "resources")));
  app.use(express.static(path.join(opts.root, "resources")));
  app.use((req, res) => {
    let html = fs.readFileSync(indexHtmlPath, "utf8");
    html = html.replaceAll('<%- locals.cdnBaseRaw || "" %>', "");
    html = html.replaceAll("<%- locals.cdnBaseRaw || '' %>", "");
    html = html.replaceAll(
      '<%- locals.cdnBaseRaw || "" %>/assets/',
      "/assets/",
    );
    html = html.replaceAll(
      "<%- locals.cdnBaseRaw || '' %>/assets/",
      "/assets/",
    );
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
      .replace(/<%-\s*typeof serverHost[\s\S]*?%>/g, "");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const httpPort = server.address().port;
  const cdpPort = await findFreePort();

  const tmpProfile = fs.mkdtempSync(
    path.join(os.tmpdir(), "chrome-frontierx-bench-"),
  );
  const chromePath =
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const chromeArgs = [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpProfile}`,
    `--window-size=${opts.width},${opts.height}`,
    "--use-gl=angle",
    "--use-angle=d3d11",
    "--enable-gpu-rasterization",
    "--ignore-gpu-blocklist",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.maxOldSpaceMb > 0) {
    chromeArgs.push(`--js-flags=--max-old-space-size=${opts.maxOldSpaceMb}`);
  }
  chromeArgs.push(`http://127.0.0.1:${httpPort}`);

  const chrome = spawn(chromePath, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ws;
  const consoleErrors = [];

  try {
    let pageTarget = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const targets = await res.json();
        pageTarget = targets.find(
          (t) => t.type === "page" && t.webSocketDebuggerUrl,
        );
        if (pageTarget) break;
      } catch {
        // Chrome CDP still starting up
      }
    }
    if (!pageTarget) {
      throw new Error("Chrome CDP target failed to start");
    }

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    let msgId = 1;
    const pending = new Map();
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.id && pending.has(parsed.id)) {
        const { resolve, reject } = pending.get(parsed.id);
        pending.delete(parsed.id);
        if (parsed.error) {
          reject(new Error(parsed.error.message));
        } else {
          resolve(parsed.result);
        }
        return;
      }
      if (
        parsed.method === "Runtime.consoleAPICalled" &&
        parsed.params?.type === "error"
      ) {
        const txt = (parsed.params.args ?? [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        consoleErrors.push(txt);
      } else if (parsed.method === "Runtime.exceptionThrown") {
        const ex = parsed.params?.exceptionDetails;
        consoleErrors.push(ex?.text ?? "Runtime.exceptionThrown");
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.dpr,
      mobile: false,
    });
    if (opts.cpuThrottle > 1) {
      await send("Emulation.setCPUThrottlingRate", {
        rate: opts.cpuThrottle,
      });
    }

    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        if (${opts.seed} > 0) {
          let state = ${opts.seed} >>> 0;
          const nextRand = () => {
            state = (state + 0x6D2B79F5) >>> 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
          Math.random = nextRand;
          if (window.crypto && typeof window.crypto.getRandomValues === "function") {
            const origGetRandomValues = window.crypto.getRandomValues.bind(window.crypto);
            window.crypto.getRandomValues = (arr) => {
              if (!arr || typeof arr.length !== "number") return origGetRandomValues(arr);
              const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
              for (let i = 0; i < bytes.length; i++) {
                bytes[i] = Math.floor(nextRand() * 256);
              }
              return arr;
            };
          }
        }

        const tel = {
          rafFrames: 0,
          glClearFrames: 0,
          glDrawCalls: 0,
          lastFrameTime: performance.now(),
          frameTimes: [],
          maxFrameHistory: 600,
          longTasksTotal: 0,
          longTaskMaxMs: 0,
          pageErrors: [],
          gpuInfo: { vendor: "unknown", renderer: "unknown", isSoftware: false },
          webglContextsCreated: 0,
        };
        window.__perfTelemetry = tel;

        window.addEventListener("error", (ev) => {
          tel.pageErrors.push(String(ev.message ?? ev.error ?? "error"));
        });
        window.addEventListener("unhandledrejection", (ev) => {
          tel.pageErrors.push(String(ev.reason ?? "unhandledrejection"));
        });

        try {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration > 50) {
                tel.longTasksTotal++;
                if (entry.duration > tel.longTaskMaxMs) {
                  tel.longTaskMaxMs = entry.duration;
                }
              }
            }
          });
          obs.observe({ entryTypes: ["longtask"] });
        } catch {
          // longtask PerformanceObserver not supported
        }

        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, attrs) {
          const ctx = origGetContext.call(this, type, attrs);
          if ((type === "webgl2" || type === "webgl") && ctx && !ctx.__fxTracked) {
            ctx.__fxTracked = true;
            tel.webglContextsCreated++;
            try {
              const ext = ctx.getExtension("WEBGL_debug_renderer_info");
              const vendor = ext
                ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL)
                : ctx.getParameter(ctx.VENDOR);
              const renderer = ext
                ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)
                : ctx.getParameter(ctx.RENDERER);
              tel.gpuInfo = {
                vendor: String(vendor ?? "unknown"),
                renderer: String(renderer ?? "unknown"),
                isSoftware: /swiftshader|llvmpipe|softpipe|microsoft basic/i.test(
                  String(renderer ?? ""),
                ),
              };
            } catch {
              // ignore WebGL query error
            }
          }
          return ctx;
        };

        if (typeof WebGL2RenderingContext !== "undefined") {
          const proto = WebGL2RenderingContext.prototype;
          const origClear = proto.clear;
          proto.clear = function(mask) {
            if ((mask & this.COLOR_BUFFER_BIT) !== 0 && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
              tel.glClearFrames++;
            }
            return origClear.apply(this, arguments);
          };
          for (const fn of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
            const orig = proto[fn];
            if (typeof orig === "function") {
              proto[fn] = function() {
                tel.glDrawCalls++;
                return orig.apply(this, arguments);
              };
            }
          }
        }

        function trackRaf(t) {
          const dt = t - tel.lastFrameTime;
          tel.lastFrameTime = t;
          tel.rafFrames++;
          if (dt > 0 && dt < 2000) {
            tel.frameTimes.push(dt);
            if (tel.frameTimes.length > tel.maxFrameHistory) {
              tel.frameTimes.shift();
            }
          }
          requestAnimationFrame(trackRaf);
        }
        requestAnimationFrame(trackRaf);
      })()`,
    });

    await send("Page.navigate", { url: `http://127.0.0.1:${httpPort}` });
    await new Promise((r) => setTimeout(r, 2500));

    // Configure & launch match cleanly
    const startOk = await send("Runtime.evaluate", {
      expression: `(() => {
        const modal = document.querySelector("single-player-modal");
        if (!modal) return { ok: false, reason: "missing single-player-modal" };
        modal.bots = ${opts.bots};
        modal.selectedMap = ${JSON.stringify(opts.map)};
        if (${opts.infiniteGold}) modal.infiniteGold = true;
        if (${opts.infiniteTroops}) modal.infiniteTroops = true;
        if (${opts.instantBuild}) modal.instantBuild = true;
        modal.startGame();
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    if (!startOk.result?.value?.ok) {
      throw new Error(
        `Failed to start match: ${JSON.stringify(startOk.result?.value)}`,
      );
    }

    // Wait for game initialization & WebGL GPU verification
    let readyTicks = 0;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const chk = await send("Runtime.evaluate", {
        expression: `(() => {
          const bm = document.querySelector("build-menu");
          const g = bm?.game;
          return {
            ticks: g ? g.ticks() : 0,
            gpu: window.__perfTelemetry?.gpuInfo ?? null,
          };
        })()`,
        returnByValue: true,
      });
      if ((chk.result?.value?.ticks ?? 0) > 0) {
        readyTicks = chk.result.value.ticks;
        const gpu = chk.result.value.gpu;
        if (gpu?.isSoftware) {
          throw new Error(
            `GPU assertion failed: software renderer active (${gpu.renderer})`,
          );
        }
        console.log(
          `[${opts.versionLabel} | ${opts.profile}] Ready at tick ${readyTicks}, GPU: ${gpu?.renderer ?? "unknown"}`,
        );
        break;
      }
    }
    if (readyTicks <= 0) {
      throw new Error("Game failed to start ticking within 45s");
    }

    // Spawn player at deterministic land tile near center
    const landCoords = await send("Runtime.evaluate", {
      expression: `(() => {
        const bm = document.querySelector("build-menu");
        const g = bm?.game;
        const th = bm?.transformHandler;
        if (!g || !th) return null;
        const w = g.width();
        const h = g.height();
        for (let r = 8; r < 300; r += 6) {
          for (let angle = 0; angle < 360; angle += 15) {
            const rad = (angle * Math.PI) / 180;
            const cx = Math.floor(w / 2 + r * Math.cos(rad));
            const cy = Math.floor(h / 2 + r * Math.sin(rad));
            if (g.isValidCoord(cx, cy)) {
              const tile = g.ref(cx, cy);
              if (g.isLand(tile) && !g.hasOwner(tile)) {
                const sc = th.worldToScreenCoordinates({ x: cx, y: cy });
                return { cx, cy, sc };
              }
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const spawnCoords = landCoords.result?.value;
    if (spawnCoords) {
      const sx = Math.round(spawnCoords.sc.x);
      const sy = Math.round(spawnCoords.sc.y);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: sx,
        y: sy,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 80));
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: sx,
        y: sy,
        button: "left",
        clickCount: 1,
      });
    }

    // Wait for spawn phase exit (active simulation)
    let exitedSpawn = false;
    for (let j = 0; j < 20; j++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await send("Runtime.evaluate", {
        expression: `(() => {
          const g = document.querySelector("build-menu")?.game;
          return g ? { inSpawn: g.inSpawnPhase(), ticks: g.ticks() } : null;
        })()`,
        returnByValue: true,
      });
      if (st.result?.value && !st.result.value.inSpawn) {
        exitedSpawn = true;
        break;
      }
    }
    if (!exitedSpawn) {
      console.warn(
        `[${opts.versionLabel} | ${opts.profile}] Spawn phase still active after 20s wait`,
      );
    }

    // In stressBuild mode (Profile D), expand outward and construct Tank Factories, Cities, Ports via real build/attack intents
    let stressStep = 0;
    const maybeBuildStressStructures = async () => {
      if (!opts.stressBuild) return;
      const action = await send("Runtime.evaluate", {
        expression: `(() => {
          const bm = document.querySelector("build-menu");
          const g = bm?.game;
          const th = bm?.transformHandler;
          const me = g?.myPlayer();
          if (!bm || !g || !th || !me || !me.isAlive()) return { built: 0, attackPoint: null };

          const w = g.width();
          const h = g.height();
          const capTile = me.state?.spawnTile ?? null;
          const cx0 = capTile !== null ? g.x(capTile) : Math.floor(w / 2);
          const cy0 = capTile !== null ? g.y(capTile) : Math.floor(h / 2);

          window.__stressBuiltTiles ??= new Set();
          const builtSet = window.__stressBuiltTiles;

          // Find an unowned/enemy land tile across the map to expand via click
          let attackPoint = null;
          const maxSpan = Math.max(w, h);
          for (let r = 4; r < maxSpan && !attackPoint; r += 8) {
            for (let a = 0; a < 360; a += 24) {
              const rad = ((a + ${stressStep} * 17) * Math.PI) / 180;
              const ax = Math.floor(cx0 + r * Math.cos(rad));
              const ay = Math.floor(cy0 + r * Math.sin(rad));
              if (!g.isValidCoord(ax, ay)) continue;
              const t = g.ref(ax, ay);
              if (g.isLand(t) && g.ownerID(t) !== me.smallID()) {
                attackPoint = th.worldToScreenCoordinates({ x: ax, y: ay });
                break;
              }
            }
          }

          let count = 0;
          if (typeof bm.sendBuildOrUpgrade === "function") {
            const existingFactories = me.totalUnitLevels ? me.totalUnitLevels("Tank Factory") : 0;
            if (existingFactories < 100) {
              // Respect landBasedStructureSpawn searchRadius (~16 tiles min spacing) and scan wide
              for (let r = 0; r <= maxSpan && count < 16; r += 20) {
                const steps = r === 0 ? 1 : 24;
                for (let s = 0; s < steps && count < 16; s++) {
                  const rad = ((s * (360 / steps) + ${stressStep} * 11) * Math.PI) / 180;
                  const x = Math.floor(cx0 + r * Math.cos(rad));
                  const y = Math.floor(cy0 + r * Math.sin(rad));
                  if (!g.isValidCoord(x, y)) continue;
                  const t = g.ref(x, y);
                  if (builtSet.has(t)) continue;
                  if (g.isLand(t) && g.ownerID(t) === me.smallID()) {
                    builtSet.add(t);
                    const unitType = count % 6 === 5 ? "City" : "Tank Factory";
                    bm.sendBuildOrUpgrade(
                      {
                        type: unitType,
                        canBuild: true,
                        canUpgrade: false,
                        upgradeTargetTile: null,
                        cost: 0n,
                        customFlag: false,
                      },
                      t,
                    );
                    count++;
                  }
                }
              }
            }
          }
          return { built: count, attackPoint, ownedTiles: me.numTilesOwned ? me.numTilesOwned() : 0 };
        })()`,
        returnByValue: true,
      });
      stressStep++;
      const pt = action.result?.value?.attackPoint;
      if (
        pt &&
        pt.x > 0 &&
        pt.x < opts.width &&
        pt.y > 0 &&
        pt.y < opts.height
      ) {
        const sx = Math.round(pt.x);
        const sy = Math.round(pt.y);
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: sx,
          y: sy,
          button: "left",
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 40));
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: sx,
          y: sy,
          button: "left",
          clickCount: 1,
        });
      }
    };

    const jsonFile = path.join(
      opts.outDir,
      `${opts.versionLabel}_${opts.profile}.json`,
    );
    const csvFile = path.join(
      opts.outDir,
      `${opts.versionLabel}_${opts.profile}.csv`,
    );
    const csvHeader = [
      "ElapsedSec",
      "Tick",
      "TPS",
      "RafFPS",
      "WebGLFPS",
      "EngineWebGLFPS",
      "FPS1PctLow",
      "MedianFrameMs",
      "P95FrameMs",
      "P99FrameMs",
      "GLDrawCallsPerFrame",
      "LongTasksTotal",
      "LongTaskMaxMs",
      "JSHeapUsedMB",
      "JSHeapTotalMB",
      "DOMNodes",
      "UnitsTotal",
      "ActiveTanks",
      "StructuresTotal",
      "PlayersAlive",
      "DualCanvases",
      "PageErrors",
    ].join(",");
    fs.writeFileSync(csvFile, `${csvHeader}\n`);

    const checkpoints = [];
    const startMs = Date.now();
    let prevSampleMs = startMs;
    let prevTicks = readyTicks;
    let prevRaf = 0;
    let prevGlFrames = 0;
    let prevEngineGlFrames = 0;
    let prevDrawCalls = 0;
    let screenshotTaken = false;

    const initSnap = await send("Runtime.evaluate", {
      expression: `(() => {
        const tel = window.__perfTelemetry ?? {};
        return {
          raf: tel.rafFrames ?? 0,
          glf: tel.glClearFrames ?? 0,
          engf: window.__frontierxRenderStats?.webglFrames ?? 0,
          dc: tel.glDrawCalls ?? 0,
        };
      })()`,
      returnByValue: true,
    });
    prevRaf = initSnap.result?.value?.raf ?? 0;
    prevGlFrames = initSnap.result?.value?.glf ?? 0;
    prevEngineGlFrames = initSnap.result?.value?.engf ?? 0;
    prevDrawCalls = initSnap.result?.value?.dc ?? 0;

    while ((Date.now() - startMs) / 1000 < opts.durationSec) {
      const sampleEndMs = Date.now() + opts.sampleSec * 1000;
      while (Date.now() < sampleEndMs) {
        if (opts.stressBuild) {
          await maybeBuildStressStructures();
        }
        const remaining = sampleEndMs - Date.now();
        if (remaining > 0) {
          await new Promise((r) =>
            setTimeout(
              r,
              opts.stressBuild ? Math.min(2500, remaining) : remaining,
            ),
          );
        }
      }
      const nowMs = Date.now();
      const elapsedSec = Math.round((nowMs - startMs) / 1000);
      const dtSec = Math.max(0.1, (nowMs - prevSampleMs) / 1000);

      if (
        opts.screenshotAtSec >= 0 &&
        opts.screenshotPath &&
        !screenshotTaken &&
        elapsedSec >= opts.screenshotAtSec
      ) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        if (shot?.data) {
          fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true });
          fs.writeFileSync(
            opts.screenshotPath,
            Buffer.from(shot.data, "base64"),
          );
          screenshotTaken = true;
          console.log(
            `[${opts.versionLabel} | ${opts.profile}] Captured screenshot at ${elapsedSec}s -> ${opts.screenshotPath}`,
          );
        }
      }

      const snap = await send("Runtime.evaluate", {
        expression: `(() => {
          const tel = window.__perfTelemetry ?? {};
          const fts = (tel.frameTimes ?? []).slice().sort((a, b) => a - b);
          const pick = (q) => fts.length ? fts[Math.min(fts.length - 1, Math.floor(fts.length * q))] : 0;
          const median = pick(0.5);
          const p95 = pick(0.95);
          const p99 = pick(0.99);
          const low1 = p99 > 0 ? 1000 / p99 : 0;

          const bm = document.querySelector("build-menu");
          const g = bm?.game;
          const allUnits = g ? g.units() : [];
          let activeTanks = 0;
          let structuresTotal = 0;
          for (let i = 0; i < allUnits.length; i++) {
            const u = allUnits[i];
            if (!u.isActive()) continue;
            const ut = String(u.type());
            if (ut === "Tank") activeTanks++;
            else if (
              ut === "City" ||
              ut === "Factory" ||
              ut === "Port" ||
              ut === "Defense Post" ||
              ut === "SAM Launcher" ||
              ut === "Missile Silo" ||
              ut === "Tank Factory"
            ) {
              structuresTotal++;
            }
          }

          const mem = performance.memory;
          return {
            tick: g ? g.ticks() : 0,
            rafFrames: tel.rafFrames ?? 0,
            glClearFrames: tel.glClearFrames ?? 0,
            engineWebglFrames: window.__frontierxRenderStats?.webglFrames ?? 0,
            glDrawCalls: tel.glDrawCalls ?? 0,
            longTasksTotal: tel.longTasksTotal ?? 0,
            longTaskMaxMs: Math.round((tel.longTaskMaxMs ?? 0) * 10) / 10,
            medianFrameMs: Math.round(median * 100) / 100,
            p95FrameMs: Math.round(p95 * 100) / 100,
            p99FrameMs: Math.round(p99 * 100) / 100,
            fps1PctLow: Math.round(low1 * 10) / 10,
            jsHeapUsedMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 100) / 100 : 0,
            jsHeapTotalMB: mem ? Math.round((mem.totalJSHeapSize / 1048576) * 100) / 100 : 0,
            domNodes: document.getElementsByTagName("*").length,
            unitsTotal: allUnits.length,
            activeTanks,
            structuresTotal,
            playersAlive: g ? g.players().filter((p) => p.isAlive()).length : 0,
            dualCanvases: document.querySelectorAll(".openfront-static-canvas, .openfront-dynamic-canvas").length,
            pageErrors: (tel.pageErrors ?? []).length,
            gpuInfo: tel.gpuInfo ?? null,
          };
        })()`,
        returnByValue: true,
      });

      const d = snap.result?.value;
      if (!d) continue;

      const tps = Number(((d.tick - prevTicks) / dtSec).toFixed(2));
      const rafFps = Number(((d.rafFrames - prevRaf) / dtSec).toFixed(1));
      const webglFps = Number(
        ((d.glClearFrames - prevGlFrames) / dtSec).toFixed(1),
      );
      const engineWebglFps =
        d.engineWebglFrames > 0
          ? Number(
              ((d.engineWebglFrames - prevEngineGlFrames) / dtSec).toFixed(1),
            )
          : webglFps;
      const glFramesDelta = Math.max(1, d.glClearFrames - prevGlFrames);
      const glDrawCallsPerFrame = Number(
        ((d.glDrawCalls - prevDrawCalls) / glFramesDelta).toFixed(1),
      );

      prevSampleMs = nowMs;
      prevTicks = d.tick;
      prevRaf = d.rafFrames;
      prevGlFrames = d.glClearFrames;
      prevEngineGlFrames = d.engineWebglFrames;
      prevDrawCalls = d.glDrawCalls;

      const row = {
        elapsedSec,
        tick: d.tick,
        tps,
        rafFps,
        webglFps,
        engineWebglFps,
        fps1PctLow: d.fps1PctLow,
        medianFrameMs: d.medianFrameMs,
        p95FrameMs: d.p95FrameMs,
        p99FrameMs: d.p99FrameMs,
        glDrawCallsPerFrame,
        longTasksTotal: d.longTasksTotal,
        longTaskMaxMs: d.longTaskMaxMs,
        jsHeapUsedMB: d.jsHeapUsedMB,
        jsHeapTotalMB: d.jsHeapTotalMB,
        domNodes: d.domNodes,
        unitsTotal: d.unitsTotal,
        activeTanks: d.activeTanks,
        structuresTotal: d.structuresTotal,
        playersAlive: d.playersAlive,
        dualCanvases: d.dualCanvases,
        pageErrors: d.pageErrors + consoleErrors.length,
        gpuRenderer: d.gpuInfo?.renderer ?? "unknown",
      };
      checkpoints.push(row);

      fs.appendFileSync(
        csvFile,
        [
          row.elapsedSec,
          row.tick,
          row.tps,
          row.rafFps,
          row.webglFps,
          row.engineWebglFps,
          row.fps1PctLow,
          row.medianFrameMs,
          row.p95FrameMs,
          row.p99FrameMs,
          row.glDrawCallsPerFrame,
          row.longTasksTotal,
          row.longTaskMaxMs,
          row.jsHeapUsedMB,
          row.jsHeapTotalMB,
          row.domNodes,
          row.unitsTotal,
          row.activeTanks,
          row.structuresTotal,
          row.playersAlive,
          row.dualCanvases,
          row.pageErrors,
        ].join(",") + "\n",
      );

      console.log(
        `[${opts.versionLabel} | ${opts.profile} | t=${row.elapsedSec}s] tick=${row.tick} tps=${row.tps} glFPS=${row.webglFps} rafFPS=${row.rafFps} 1%low=${row.fps1PctLow} p95=${row.p95FrameMs}ms draws=${row.glDrawCallsPerFrame} heap=${row.jsHeapUsedMB}MB units=${row.unitsTotal} tanks=${row.activeTanks} lt=${row.longTasksTotal}`,
      );
    }

    // Post-match cleanup telemetry: trigger stop/leave on page and measure memory/DOM release
    const preStop = checkpoints[checkpoints.length - 1] ?? null;
    await send("Runtime.evaluate", {
      expression: `(() => {
        window.__dualLayerEngine?.destroy?.();
      })()`,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const postCleanup = await send("Runtime.evaluate", {
      expression: `(() => {
        const mem = performance.memory;
        return {
          jsHeapUsedMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 100) / 100 : 0,
          domNodes: document.getElementsByTagName("*").length,
          dualCanvases: document.querySelectorAll(".openfront-static-canvas, .openfront-dynamic-canvas").length,
        };
      })()`,
      returnByValue: true,
    });

    const summary = {
      versionLabel: opts.versionLabel,
      profile: opts.profile,
      config: {
        width: opts.width,
        height: opts.height,
        dpr: opts.dpr,
        cpuThrottle: opts.cpuThrottle,
        maxOldSpaceMb: opts.maxOldSpaceMb,
        bots: opts.bots,
        map: opts.map,
        seed: opts.seed,
        durationSec: opts.durationSec,
      },
      gpu: checkpoints[0]?.gpuRenderer ?? "unknown",
      stats: {
        webglFps: computeStats(checkpoints, "webglFps"),
        rafFps: computeStats(checkpoints, "rafFps"),
        fps1PctLow: computeStats(checkpoints, "fps1PctLow"),
        medianFrameMs: computeStats(checkpoints, "medianFrameMs"),
        p95FrameMs: computeStats(checkpoints, "p95FrameMs"),
        p99FrameMs: computeStats(checkpoints, "p99FrameMs"),
        tps: computeStats(checkpoints, "tps"),
        jsHeapUsedMB: computeStats(checkpoints, "jsHeapUsedMB"),
        domNodes: computeStats(checkpoints, "domNodes"),
      },
      lastCheckpoint: preStop,
      postCleanup: postCleanup.result?.value ?? null,
      consoleErrors,
      checkpoints,
    };

    fs.writeFileSync(jsonFile, JSON.stringify(summary, null, 2));
    console.log(`Saved benchmark JSON -> ${jsonFile}`);
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore ws close error
    }
    try {
      chrome.kill();
    } catch {
      // ignore chrome kill error
    }
    try {
      server.close();
    } catch {
      // ignore server close error
    }
    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    } catch {
      // ignore temp profile cleanup error
    }
  }
}

const opts = parseArgs(process.argv.slice(2));
runBenchmark(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
