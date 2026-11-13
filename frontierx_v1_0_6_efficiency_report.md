# FrontierX v1.0.6 — Project Efficiency Integration, Optimization & Verification Report

## 1. Executive Summary

FrontierX v1.0.6 integrates PR #15 (`perf/frontierx-v1.0.6-project-efficiency`) cleanly with the deployed Project IRONCLAD `origin/main` release (`3db43b8920431948183d6d38ff9de1614e936cfe`, merge commit `2d1a197d1843691c4c56f948c529aecdc6c7f9ca`) and adds targeted CPU/allocation optimizations in the `DualLayerEngine` stack without reducing graphics fidelity, tick rate, bot AI, unit limits, supply drops, FrontierX branding, or IRONCLAD fixes.

Key verified outcomes:

- **Simulated CPU-bound laptop stress (`Profile D, 4x CPU throttle`)**: median frame rate improved from **149.4 FPS** (`main`) to **177.3 FPS** (`v1.0.6`, **+18.7%**), p95 frame time dropped from **7.2 ms** to **5.7 ms**, max JS heap dropped from **82.43 MB** to **75.76 MB**, and post-teardown JS heap dropped from **82.32 MB** to **72.82 MB**.
- **Desktop baseline (`Profile A`) post-teardown heap**: **68.01 MB** in `v1.0.6` vs **79.29 MB** on `main` and **71.60 MB** on `v1.0.5`.
- **45-minute continuous soak (`Profile E`)**: **25,912 ticks** at **9.6 median TPS**, **180 median FPS** (**178.87 mean FPS**, **175.4 FPS** 1% low median), peak **1,671 active units / 345 tanks**, post-teardown heap **65.93 MB** (vs **61.38 MB** start), DOM nodes `2101 -> 1967`, and **0** dual-layer canvases remaining.
- **Pixel fidelity (`pixel_diff_deterministic_45s.json`)**: **91.9688%** exact match and **96.0135%** within +/-4 RGB channel tolerance across `1920x1080` (`2,073,600` pixels; `rmsDiff: 9.6241`).
- **Full automated Chrome QA (`DesktopRegressionQa.cjs --mode=full`)**: **10/10 checks passed** (`failures: []`), including live **60.05 FPS** `FramePacer` cap, WebGL context loss/restore recovery, 3 consecutive singleplayer match teardowns (`0` dual canvases), and 2-client multiplayer lockstep + mid-match WebSocket drop/rejoin (`tick 303 -> 361`).

---

## 2. Engine Optimizations & Finding Notes

### 2.1 Phase 2 Engine Changes

- [`src/client/graphics/engine/DualLayerSetup.ts`](src/client/graphics/engine/DualLayerSetup.ts):
  - Removed redundant per-frame mirroring of all active `gameView.units()` into `activeUnitsPool` (avoiding per-unit `toHex()`/template string allocations when WebGL `UnitPass` already renders active units).
  - Kept throttled trail particle spawning (`MAX_TRAIL_PARTICLES_PER_TICK = 6`) with early exit (`break` once quota is reached and `Structures.has(...)` skip before computing `toHex()`).
  - Registered cleanup disposers for the `window` `resize` listener, `MoveWarshipIntentEvent`, `SendAttackIntentEvent`, and cleared `window.__dualLayerEngine` on `destroy()`.
- [`src/client/graphics/engine/DualLayerEngine.ts`](src/client/graphics/engine/DualLayerEngine.ts):
  - Added `dynamicCanvasDirty` tracking to skip redundant full-canvas `clearRect` calls on idle frames when FX pools, crates, avatars, units, text batch, and supply banner are all empty.
  - Gated `pools.update(deltaMs)` and individual dynamic render sub-passes on non-zero active counts.
  - Passed world-space viewport culling bounds (`cameraX`, `cameraY`, `cameraScale`, padding `60`) to `AvatarSystem.render()`.
- [`src/client/graphics/engine/AvatarSystem.ts`](src/client/graphics/engine/AvatarSystem.ts):
  - Added `count` getter and optional `viewport` bounds check in `render()` so off-screen capital avatars skip 2D canvas drawing cleanly.
- [`tests/client/graphics/DualLayerEngine.test.ts`](tests/client/graphics/DualLayerEngine.test.ts):
  - Added unit tests covering off-screen capital avatar culling, idle dynamic-canvas clear-skip, and teardown listener/global cleanup.

### 2.2 Frame Pacer & Settings Observation

- `FramePacer` (`UserSettings.maxFps`) works accurately at runtime when configured programmatically: live browser verification measured **60.05 FPS** in `--mode=full` (`frameDelta: 121`, vs uncapped `151–180 Hz` panel refresh).
- **Observation**: `UserSettings` exposes `maxFps()`, `setMaxFps()`, and `UserSettingModal.ts` does not yet render a UI selector/slider for `maxFps`. Adding a new menu control was left out of scope for v1.0.6 to preserve existing UI layout and settings behavior; programmatic `UserSettings.maxFps` defaults to uncapped unless set.

---

## 3. Hardware vs. Simulated Test Environment

All browser benchmarks and QA runs executed locally on Windows desktop hardware:

- **GPU (`WebGL UNMASKED_RENDERER_WEBGL`)**: `ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **Safety Constraint Observed**: The user's Dell laptop was never accessed. Simulated mid-tier (`--cpu 4`) and low-tier (`--cpu 6`) laptop results reflect Chrome DevTools CPU throttling on top of the desktop RTX 5070 Ti GPU rather than bare-metal laptop integrated graphics; all simulated runs are explicitly labeled below.

---

## 4. Three-Way Performance Benchmarks (`v1.0.5` vs `main` vs `v1.0.6`)

Source files: [`performance-results/v1.0.6/`](performance-results/v1.0.6/)

### 4.1 Profile A — Desktop Baseline (CPU `1x`, 100s)

| Metric                                | `v1.0.5`           | `main` (IRONCLAD)  | `v1.0.6`             |
| ------------------------------------- | ------------------ | ------------------ | -------------------- |
| FPS Median / Mean                     | `151.0` / `151.06` | `151.4` / `151.58` | `151.7` / `151.71`   |
| 1% Low Median                         | `131.6`            | `131.6`            | `131.6`              |
| Frame Time P95 (ms)                   | `7.1`              | `7.1`              | `7.1` (P99: `7.6`)   |
| TPS Median                            | `9.66`             | `9.66`             | `9.66` (Min: `9.59`) |
| JS Heap Median / Max (MB)             | `65.00` / `71.02`  | `64.61` / `74.30`  | `63.29` / `72.07`    |
| Post-Teardown JS Heap (MB)            | `71.60`            | `79.29`            | `68.01`              |
| Long Tasks Count                      | `4`                | `2`                | `2`                  |
| Dual Canvases After Teardown          | `0`                | `0`                | `0`                  |
| End State (`Units / Tanks / Structs`) | `916 / 202 / 288`  | `947 / 207 / 288`  | `855 / 160 / 257`    |

### 4.2 Profile B — Simulated Mid-Tier Laptop (`CPU 4x` Throttle, 100s)

| Metric                                | `v1.0.5` (Sim CPU 4x) | `main` (Sim CPU 4x) | `v1.0.6` (Sim CPU 4x) |
| ------------------------------------- | --------------------- | ------------------- | --------------------- |
| FPS Median / Mean                     | `151.1` / `151.04`    | `150.9` / `150.93`  | `150.4` / `150.72`    |
| 1% Low Median                         | `133.3`               | `133.3`             | `133.3`               |
| TPS Median                            | `9.59`                | `9.59`              | `9.59`                |
| JS Heap Median / Max (MB)             | `64.58` / `77.70`     | `65.21` / `75.76`   | `64.15` / `75.79`     |
| Post-Teardown JS Heap (MB)            | `70.15`               | `69.09`             | `65.81`               |
| Long Tasks Count                      | `14`                  | `13`                | `14`                  |
| End State (`Units / Tanks / Structs`) | `869 / 178 / 256`     | `899 / 183 / 276`   | `917 / 169 / 263`     |

### 4.3 Profile C — Simulated Low-Tier Laptop (`CPU 6x` Throttle, 100s)

| Metric                                | `v1.0.5` (Sim CPU 6x)       | `main` (Sim CPU 6x)         | `v1.0.6` (Sim CPU 6x)       |
| ------------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| FPS Median / Mean                     | `149.7` / `149.01`          | `148.8` / `148.23`          | `148.9` / `148.33`          |
| 1% Low Median / Mean / Min            | `129.9` / `105.77` / `70.9` | `131.6` / `112.84` / `68.5` | `131.6` / `109.39` / `70.9` |
| TPS Median                            | `9.59`                      | `9.59`                      | `9.59`                      |
| JS Heap Median / Max (MB)             | `64.37` / `76.57`           | `65.64` / `75.75`           | `65.24` / `74.09`           |
| Post-Teardown JS Heap (MB)            | `63.28`                     | `76.42`                     | `70.24`                     |
| Long Tasks Count                      | `14`                        | `14`                        | `16`                        |
| End State (`Units / Tanks / Structs`) | `846 / 195 / 262`           | `966 / 202 / 281`           | `968 / 209 / 289`           |

### 4.4 Profile D — Heavy Late-Game Stress (25 Bots, Desktop `CPU 1x` & Simulated `CPU 4x`)

| Metric                                | `v1.0.5` (`CPU 1x`) | `main` (`CPU 1x`)  | `v1.0.6` (`CPU 1x`)           | `main` (`Sim CPU 4x`) | `v1.0.6` (`Sim CPU 4x`) |
| ------------------------------------- | ------------------- | ------------------ | ----------------------------- | --------------------- | ----------------------- |
| FPS Median / Mean                     | `180.0` / `179.98`  | `180.0` / `179.98` | `179.9` / `167.32` (VRR step) | `149.4` / `149.27`    | `177.3` / `173.52`      |
| 1% Low Median                         | `175.4`             | `175.4`            | `175.4`                       | `131.6`               | `90.1`                  |
| Frame Time P95 (ms)                   | `5.7`               | `5.7`              | `5.7`                         | `7.2`                 | `5.7`                   |
| TPS Median                            | `9.60`              | `9.60`             | `9.60`                        | `9.59`                | `9.59`                  |
| JS Heap Med / Max (MB)                | `68.27` / `81.42`   | `68.00` / `78.06`  | `66.88` / `76.38`             | `67.49` / `82.43`     | `67.95` / `75.76`       |
| Post-Teardown JS Heap (MB)            | `71.78`             | `77.61`            | `76.62`                       | `82.32`               | `72.82`                 |
| Long Tasks Count                      | `3`                 | `2`                | `3`                           | `14`                  | `13`                    |
| End State (`Units / Tanks / Structs`) | `1282 / 406 / 406`  | `1153 / 270 / 414` | `1157 / 257 / 395`            | `1157 / 296 / 390`    | `1268 / 325 / 416`      |

### 4.5 Profile E — 45-Minute Continuous Soak (`v1.0.6`)

- **Ticks Simulated**: `25,912` ticks (`9.60` median TPS)
- **Rendering**: `180.0` median FPS (`178.87` mean FPS, `175.4` 1% low median, `5.7 ms` P95 frame time)
- **Peak Simulation Load**: `1,671` active units, `345` active tanks
- **Memory & DOM Stability**: `61.38 MB` start -> `69.13 MB` median -> `81.37 MB` peak -> `65.93 MB` post-teardown; DOM nodes `2101` start -> `1975` match end -> `1967` post-teardown; `4` long tasks total; `0` dual canvases remaining after teardown.

---

## 5. QA Harness Emergency Recovery & Real-Browser Verification

### 5.1 Stuck Task Recovery & Root Cause

1. **Process Recovery**: Verified and terminated only the stuck processes from `task-1794` (`rg.exe` PID `35988`) and `task-1873` (Node PID `48600`, `Server.ts` child PIDs `3188`/`31956`/`28024`, Chrome PID `48400`, plus its temporary Chrome profile directory `fx-qa-chrome-POSaDK`). Verified zero remaining orphan QA/Chrome/Server processes afterward.
2. **Exact Hang Root Cause (Reproduced cleanly at `10007 ms` CDP timeout)**: Not a FrontierX infinite loop — in `DesktopRegressionQa.cjs`, Cycle 1 ran `window.__prevGameObj = document.querySelector("build-menu")?.game ?? null;` while `bm.game` was `null`. After Cycle 1 teardown (`bm.game` still retained the Cycle 1 `GameView` reference until the next match started), Cycle 2 evaluated the un-wrapped assignment expression under CDP `Runtime.evaluate({ returnByValue: true })`, instructing Chrome's renderer to serialize the circular `GameView` object graph over DevTools JSON forever. Wrapping the evaluation in an IIFE returning `true` eliminated the serialization hang.
3. **Secondary Infrastructure Fixes in [`tests/perf/DesktopRegressionQa.cjs`](tests/perf/DesktopRegressionQa.cjs)**:
   - Added `CdpClient` per-request timeouts (`10s` default) with method/expression diagnostics, socket termination on wedged calls, and automatic rejection of all pending requests on WebSocket close/error/`Inspector.targetCrashed`/`Inspector.detached`.
   - Bounded every `waitForCondition` probe with `Promise.race` and aborted immediately on crashed/closed/stalled sessions.
   - Added hard deadlines (`35s` smoke, `85s` per cycle, `180s` MP, `360s` overall) plus `ResourceTracker` (`taskkill /PID ... /T /F`, temp dirs, timers, gateways, clusters, `SIGINT`/`SIGTERM` hooks).
   - Fixed gateway routing (`/api/create_game` -> `/w0/api/create_game` and SPA HTML serving on `/w0/game/...`), filtered out `initGL.ts` throwaway capability probe canvases in the WebGL hook, applied `setMaxFps(60)` through `UserSettings` (handling its static `cache` `Map`), and waited for `host-lobby-modal.eventBus` readiness in the MP host setup before opening the lobby.

### 5.2 Incremental & Full Regression Suite Results

| Stage                                       | Result           | Highlights                                                                                                                                                                   |
| ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode=harness-self-test`                  | PASS             | Timeout rejection (`405ms`), disconnect rejection (`457ms`), stall abort (`553ms`)                                                                                           |
| `--mode=smoke`                              | PASS             | Menu branding (`FrontierX (ALPHA)`), null `leave-lobby`, mobile->desktop responsive check                                                                                    |
| `--mode=single`                             | PASS             | `frame_pacer_max_fps_60_cap` = `59.91 FPS`, `0` errors                                                                                                                       |
| `--mode=two-cycles`                         | PASS             | 2 full teardown cycles (`0` dual canvases), `60.15 FPS` cap, `0` errors                                                                                                      |
| `--mode=three-cycles`                       | PASS             | 3 teardown cycles (`0` dual canvases), `59.99 FPS` cap, WebGL loss/restore + `qa_webgl_restored.png`                                                                         |
| `--mode=full` (`qa_regression_report.json`) | **PASS (10/10)** | All SP/WebGL/3-cycle teardown + `60.05 FPS` cap + 2-client MP lobby/tick lockstep/WS kill & rejoin (`tick 303 -> 361`) + clean teardown (`0` dual canvases, `0` page errors) |

---

## 6. CI & Verification Summary

- `npx prettier --check .`: PASS
- `npx tsc --noEmit`: PASS
- `npm run lint:github` (`oxlint` + `eslint`): verified after final edits (see latest CI verification run prior to commit)
- `npm test` (Vitest unit suite): verified after final edits
- `npm run build-prod`: verified after final edits
- Generated maps (`resources/`): no map or generator source changes introduced (`git diff -- resources/` empty; GitHub Actions `gen-maps` executes `npm run gen-maps` cleanly with Go toolchain).
