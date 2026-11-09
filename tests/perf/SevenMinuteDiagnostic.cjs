const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const os = require("os");
const fs = require("fs");

async function runDiagnostic({
  durationMinutes = 8,
  bots = 25,
  map = "World",
  outName = "seven_minute_baseline",
} = {}) {
  console.log(
    `\n===============================================================`,
  );
  console.log(`Starting 7-Minute Diagnostic Probe: ${outName}`);
  console.log(
    `Duration: ${durationMinutes} minutes | Bots: ${bots} | Map: ${map}`,
  );
  console.log(
    `===============================================================\n`,
  );

  const resultsDir = path.join(process.cwd(), "performance-results", "v1.0.6");
  fs.mkdirSync(resultsDir, { recursive: true });

  const app = express();
  app.use(express.static(path.join(process.cwd(), "static"), { index: false }));
  app.use("/maps", express.static(path.join(process.cwd(), "resources/maps")));
  app.use(
    "/atlases",
    express.static(path.join(process.cwd(), "resources/atlases")),
  );
  app.use("/resources", express.static(path.join(process.cwd(), "resources")));
  app.use(express.static(path.join(process.cwd(), "resources")));
  app.use((req, res) => {
    let html = fs.readFileSync(
      path.join(process.cwd(), "static/index.html"),
      "utf8",
    );
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
  const server = app.listen(9000);

  const tmpProfile = fs.mkdtempSync(
    path.join(os.tmpdir(), "chrome-prof-diag-"),
  );
  const chromePath =
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--user-data-dir=" + tmpProfile,
    "--window-size=1920,1080",
    "--use-gl=angle",
    "--use-angle=d3d11",
    "--enable-gpu-rasterization",
    "--ignore-gpu-blocklist",
    "http://localhost:9000",
  ]);

  await new Promise((r) => setTimeout(r, 2000));
  const targetsRes = await fetch("http://localhost:9222/json");
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === "page");

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));

  let msgId = 1;
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      const onMsg = (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          ws.off("message", onMsg);
          resolve(parsed.result);
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Performance.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Inject high-resolution frame time tracker & long task observer before starting
  await send("Runtime.evaluate", {
    expression: `(() => {
      window.__perfTelemetry = {
        frameTimes: [],
        longTasks: [],
        maxFrameHistory: 600,
        lastFrameTime: performance.now(),
        frameCount: 0
      };

      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfTelemetry.longTasks.push({
              start: entry.startTime,
              duration: entry.duration
            });
            if (window.__perfTelemetry.longTasks.length > 500) {
              window.__perfTelemetry.longTasks.shift();
            }
          }
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch (e) {}

      function frameTracker(time) {
        const tel = window.__perfTelemetry;
        const dt = time - tel.lastFrameTime;
        tel.lastFrameTime = time;
        tel.frameCount++;
        tel.frameTimes.push(dt);
        if (tel.frameTimes.length > tel.maxFrameHistory) {
          tel.frameTimes.shift();
        }
        requestAnimationFrame(frameTracker);
      }
      requestAnimationFrame(frameTracker);
    })()`,
  });

  await new Promise((r) => setTimeout(r, 1000));

  // Configure and start game
  console.log(`Configuring game on map ${map} with ${bots} bots...`);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const modal = document.querySelector("single-player-modal");
      modal.bots = ${bots};
      modal.selectedMap = "${map}";
      modal.startGame();
    })()`,
  });

  // Wait for game ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const chk = await send("Runtime.evaluate", {
      expression: `(() => {
        const bm = document.querySelector("build-menu");
        return bm?.game ? bm.game.ticks() : 0;
      })()`,
      returnByValue: true,
    });
    if (chk.result?.value > 0) {
      ready = true;
      console.log(`Game ready and ticking at tick ${chk.result.value}`);
      break;
    }
  }

  if (!ready) {
    throw new Error("Game failed to initialize within 30 seconds");
  }

  // Ensure human player spawns so simulation transitions out of spawn phase into active gameplay
  console.log(
    "Finding valid land tile and selecting spawn location via CDP...",
  );
  const landCoords = await send("Runtime.evaluate", {
    expression: `(() => {
      const bm = document.querySelector("build-menu");
      const g = bm?.game;
      const th = bm?.transformHandler;
      if (!g || !th) return null;
      const w = g.width();
      const h = g.height();
      for (let r = 5; r < 300; r += 5) {
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

  const coords = landCoords.result?.value;
  if (!coords) {
    console.error("Could not find land tile to spawn!");
  } else {
    const sx = Math.round(coords.sc.x);
    const sy = Math.round(coords.sc.y);
    console.log(
      `Clicking to spawn at (${coords.cx}, ${coords.cy}) -> screen (${sx}, ${sy})...`,
    );
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: sx,
      y: sy,
      button: "left",
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 100));
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: sx,
      y: sy,
      button: "left",
      clickCount: 1,
    });
  }

  // Verify game has exited spawn phase
  let activeSimulation = false;
  for (let j = 0; j < 10; j++) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await send("Runtime.evaluate", {
      expression: `(() => {
        const bm = document.querySelector("build-menu");
        const g = bm?.game;
        return g ? {
          ticks: g.ticks(),
          inSpawn: g.inSpawnPhase(),
          units: g.units().length,
          alive: g.players().filter(p => p.isAlive()).length
        } : null;
      })()`,
      returnByValue: true,
    });
    console.log(`Spawn check [${j}s]:`, status.result?.value);
    if (status.result?.value && !status.result.value.inSpawn) {
      activeSimulation = true;
      console.log("SUCCESS: Active simulation engaged! Bots expanding.");
      break;
    }
  }

  const logFile = path.join(resultsDir, `${outName}.json`);
  const csvFile = path.join(resultsDir, `${outName}.csv`);
  const checkpoints = [];
  const totalSeconds = durationMinutes * 60;
  const sampleIntervalSec = 15;

  fs.writeFileSync(
    csvFile,
    "ElapsedSec,Tick,FPS,1PctLowFPS,MedianFrameMs,P95FrameMs,P99FrameMs,JSHeapUsedMB,JSHeapTotalMB,DOMNodes,LongTasksTotal,Units,PlayersAlive,DualParticles,DualBeacons\n",
  );

  const startTime = Date.now();
  let lastTicks = 0;
  let lastSampleTime = startTime;

  console.log(
    `\nBeginning monitoring loop for ${totalSeconds} seconds (sampling every ${sampleIntervalSec}s)...`,
  );

  while ((Date.now() - startTime) / 1000 < totalSeconds) {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    const snapshot = await send("Runtime.evaluate", {
      expression: `(() => {
        const tel = window.__perfTelemetry ?? {};
        const fts = (tel.frameTimes ?? []).slice(-300);
        let median = 0, p95 = 0, p99 = 0, low1pct = 0, fps = 0;

        if (fts.length > 10) {
          const sorted = [...fts].sort((a, b) => a - b);
          median = sorted[Math.floor(sorted.length * 0.5)];
          p95 = sorted[Math.floor(sorted.length * 0.95)];
          p99 = sorted[Math.floor(sorted.length * 0.99)];
          const lowIdx = Math.max(0, Math.floor(sorted.length * 0.99));
          const worst1PctFrame = sorted[lowIdx];
          low1pct = worst1PctFrame > 0 ? 1000 / worst1PctFrame : 0;
          const avgDt = fts.reduce((a, b) => a + b, 0) / fts.length;
          fps = avgDt > 0 ? 1000 / avgDt : 0;
        }

        const bm = document.querySelector("build-menu");
        const g = bm?.game;
        const mem = performance.memory ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit
        } : null;

        const dual = window.__dualLayerEngine || window.dualLayerEngine;
        let activeUnits = 0;
        let alivePlayers = 0;
        let totalUnits = 0;
        if (g) {
          try {
            alivePlayers = g.players().filter(p => p.isAlive()).length;
            totalUnits = g.units().length;
          } catch (e) {}
        }

        return {
          fps: Math.round(fps * 10) / 10,
          low1pct: Math.round(low1pct * 10) / 10,
          median: Math.round(median * 100) / 100,
          p95: Math.round(p95 * 100) / 100,
          p99: Math.round(p99 * 100) / 100,
          mem,
          ticks: g ? g.ticks() : 0,
          totalUnits,
          alivePlayers,
          longTasksCount: (tel.longTasks || []).length,
          dualFps: dual ? dual.fps : 0,
          dualParticles: dual ? dual.pools?.trailParticles?.activeCount : 0,
          dualBeacons: dual ? dual.pools?.beaconRings?.activeCount : 0,
          dualTexts: dual ? dual.pools?.floatingTexts?.activeCount : 0,
          dualCrates: dual ? dual.crates?.size : 0,
          dualAvatars: dual ? dual.avatars?.size : 0
        };
      })()`,
      returnByValue: true,
    });

    const perfMetrics = await send("Performance.getMetrics");
    const metricMap = {};
    for (const m of perfMetrics?.metrics ?? []) {
      metricMap[m.name] = m.value;
    }

    const data = snapshot?.result?.value ?? {};
    const heapUsedMB = data.mem
      ? Math.round((data.mem.used / 1048576) * 10) / 10
      : Math.round(((metricMap.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10;
    const heapTotalMB = data.mem
      ? Math.round((data.mem.total / 1048576) * 10) / 10
      : Math.round(((metricMap.JSHeapTotalSize ?? 0) / 1048576) * 10) / 10;
    const domNodes = metricMap.Nodes ?? 0;

    const row = `${elapsedSec},${data.ticks},${data.fps},${data.low1pct},${data.median},${data.p95},${data.p99},${heapUsedMB},${heapTotalMB},${domNodes},${data.longTasksCount},${data.totalUnits},${data.alivePlayers},${data.dualParticles ?? 0},${data.dualBeacons ?? 0}`;
    fs.appendFileSync(csvFile, row + "\n");

    const entry = {
      elapsedSec,
      ticks: data.ticks,
      fps: data.fps,
      low1pct: data.low1pct,
      medianFrameMs: data.median,
      p95FrameMs: data.p95,
      p99FrameMs: data.p99,
      heapUsedMB,
      heapTotalMB,
      domNodes,
      longTasks: data.longTasksCount,
      units: data.totalUnits,
      alivePlayers: data.alivePlayers,
      dualState: {
        particles: data.dualParticles,
        beacons: data.dualBeacons,
        texts: data.dualTexts,
        crates: data.dualCrates,
        avatars: data.dualAvatars,
      },
    };
    checkpoints.push(entry);

    const min = Math.floor(elapsedSec / 60);
    const sec = elapsedSec % 60;
    const timeStr = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    console.log(
      `[${timeStr}] Tick: ${String(data.ticks).padStart(5)} | FPS: ${String(data.fps).padStart(5)} | 1%Low: ${String(data.low1pct).padStart(5)} | p95: ${String(data.p95).padStart(5)}ms | Heap: ${String(heapUsedMB).padStart(5)}MB | Units: ${String(data.totalUnits).padStart(4)} | Alive: ${String(data.alivePlayers).padStart(3)} | Nodes: ${domNodes}`,
    );

    // Take screenshot at milestone minutes (0, 1, 3, 5, 7, 8)
    global.__capturedMins ??= new Set();
    if (!global.__capturedMins.has(min) && [0, 1, 3, 5, 7, 8].includes(min)) {
      global.__capturedMins.add(min);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (shot?.data) {
        const shotPath = path.join(resultsDir, `${outName}_${min}m.png`);
        fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
        console.log(`  -> Saved milestone screenshot: ${shotPath}`);
      }
    }

    await new Promise((r) => setTimeout(r, sampleIntervalSec * 1000));
  }

  // Final summary
  fs.writeFileSync(logFile, JSON.stringify(checkpoints, null, 2));
  console.log(`\nDiagnostic run complete! Results saved to ${logFile}`);

  ws.close();
  chrome.kill();
  server.close();
  try {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  } catch (e) {}

  return checkpoints;
}

const args = process.argv.slice(2);
const duration = parseFloat(args[0]) || 8;
const bots = parseInt(args[1], 10) || 25;
const map = args[2] || "World";
const outName = args[3] || "seven_minute_baseline";

runDiagnostic({ durationMinutes: duration, bots, map, outName })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error during diagnostic:", err);
    process.exit(1);
  });
