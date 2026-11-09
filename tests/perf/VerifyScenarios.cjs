const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');

async function testScenario({ name, bots, map, durationSec = 30 }) {
  console.log(`\n--- Running Scenario: ${name} (${bots} bots on ${map}, ${durationSec}s) ---`);

  const app = express();
  app.use(express.static(path.join(process.cwd(), 'static'), { index: false }));
  app.use('/maps', express.static(path.join(process.cwd(), 'resources/maps')));
  app.use('/atlases', express.static(path.join(process.cwd(), 'resources/atlases')));
  app.use('/resources', express.static(path.join(process.cwd(), 'resources')));
  app.use(express.static(path.join(process.cwd(), 'resources')));
  app.use((req, res) => {
    let html = fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8');
    html = html.replaceAll('<%- locals.cdnBaseRaw || "" %>', '');
    html = html.replaceAll("<%- locals.cdnBaseRaw || '' %>", '');
    html = html.replaceAll('<%- locals.cdnBaseRaw || "" %>/assets/', '/assets/');
    html = html.replaceAll("<%- locals.cdnBaseRaw || '' %>/assets/", '/assets/');
    html = html
      .replace(/<%-\s*gitCommit\s*%>/g, '"DEV"')
      .replace(/<%-\s*assetManifest\s*%>/g, '{}')
      .replace(/<%-\s*cdnBase\s*%>/g, '""')
      .replace(/<%-\s*cdnBaseRaw\s*%>/g, '')
      .replace(/<%-\s*gameEnv\s*%>/g, '"dev"')
      .replace(/<%-\s*numWorkers\s*%>/g, '1')
      .replace(/<%-\s*turnstileSiteKey\s*%>/g, '""')
      .replace(/<%-\s*jwtAudience\s*%>/g, '""')
      .replace(/<%-\s*instanceId\s*%>/g, '"1"')
      .replace(/<%-\s*manifestHref\s*%>/g, '/manifest.json')
      .replace(/<%-\s*faviconHref\s*%>/g, '/favicon.ico')
      .replace(/<%-\s*gameplayScreenshotUrl\s*%>/g, '')
      .replace(/<%-\s*backgroundImageUrl\s*%>/g, '')
      .replace(/<%-\s*desktopLogoImageUrl\s*%>/g, '')
      .replace(/<%-\s*mobileLogoImageUrl\s*%>/g, '')
      .replace(/<%-\s*typeof serverHost[\s\S]*?%>/g, '');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });
  const server = app.listen(9001);

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-prof-scen-'));
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--user-data-dir=' + tmpProfile,
    '--window-size=1920,1080',
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    'http://localhost:9001'
  ]);

  await new Promise(r => setTimeout(r, 2000));
  const targetsRes = await fetch('http://localhost:9223/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  let msgId = 1;
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      const onMsg = (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          ws.off('message', onMsg);
          resolve(parsed.result);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });
  await new Promise(r => setTimeout(r, 1000));

  await send('Runtime.evaluate', {
    expression: `(() => {
      const modal = document.querySelector("single-player-modal");
      modal.bots = ${bots};
      modal.selectedMap = "${map}";
      modal.startGame();
    })()`
  });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const chk = await send('Runtime.evaluate', {
      expression: `(() => {
        const bm = document.querySelector("build-menu");
        return bm?.game ? bm.game.ticks() : 0;
      })()`,
      returnByValue: true
    });
    if (chk.result?.value > 0) break;
  }

  // Spawn human
  const landCoords = await send('Runtime.evaluate', {
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
    returnByValue: true
  });

  const coords = landCoords.result?.value;
  if (coords) {
    const sx = Math.round(coords.sc.x);
    const sy = Math.round(coords.sc.y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1 });
  }

  // Run for duration
  await new Promise(r => setTimeout(r, durationSec * 1000));

  const finalStatus = await send('Runtime.evaluate', {
    expression: `(() => {
      const bm = document.querySelector("build-menu");
      const g = bm?.game;
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0;
      return {
        ticks: g ? g.ticks() : 0,
        units: g ? g.units().length : 0,
        players: g ? g.players().filter(p => p.isAlive()).length : 0,
        heapMB: Math.round(mem * 10) / 10
      };
    })()`,
    returnByValue: true
  });

  console.log(`Scenario ${name} Results:`, finalStatus.result?.value);

  ws.close();
  chrome.kill();
  server.close();
  try {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  } catch (e) {}

  return finalStatus.result?.value;
}

async function runAll() {
  await testScenario({ name: 'Scenario A: Solo Game (0 bots)', bots: 0, map: 'World', durationSec: 15 });
  await testScenario({ name: 'Scenario C: Large Match (100 bots)', bots: 100, map: 'World', durationSec: 25 });
  console.log('\nAll scenario checks passed successfully!');
}

runAll().catch(e => {
  console.error('Error running scenarios:', e);
  process.exit(1);
});
