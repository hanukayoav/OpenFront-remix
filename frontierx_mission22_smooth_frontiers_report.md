# FrontierX — Mission 22 Report: Operation Smooth Frontiers

**Branch:** `fix/frontierx-mission22-smooth-frontiers`  
**Base:** `origin/main`  
**Test Hardware (Desktop):** AMD Ryzen 7 9800X3D, NVIDIA RTX 5070 Ti, 32 GB RAM, Windows 11 Home _(no laptop connections or benchmarks were used; Chromium CDP `CPU_THROTTLE=4` runs are explicitly labeled as simulated weak-hardware controls)_

---

## Executive Summary

Mission 22 investigated and resolved five major gameplay, AI, visual, and performance issues in FrontierX while preserving existing IRONCLAD fixes, v1.0.6 optimizations, Aegis Vanguard branding, unit caps, supply-drop reward tiers, AI intelligence, visuals, and multiplayer determinism:

1. **Dynamic Territory Avatars (Fix 1):** Added territory-aware visual anchor finding (`findTerritoryAnchor`), Hill saturation scaling (`computeAvatarScale` clamped to `[0.9, 3.8]`), zoom-aware screen scaling (`applyCameraZoomToAvatarScale`), dirty-tile bounding-box tracking (`TerritoryAnchorManager`), smooth position/scale interpolation, and full human + AI avatar lifecycle support in `AvatarSystem` / `DualLayerSetup`.
2. **Tanks Follow Changing Borders (Fix 2):** Hardened `TankExecution` with frontier classification (`classifyTileFront`), obsolete interior detection, staggered cross-tick border-slotting with station-keeping hysteresis, reachable fallback pathfinding, valid rally-point preservation, and deterministic AI/human parity.
3. **Tanks Stranded in Conquered Territory (Fix 3):** Fixed stale `TankState.Spearheading` bypassing ownership checks, implemented step-by-step non-teleporting retreat (`findNearestOwnedLandPath`, up to `MAX_RETREAT_DISTANCE = 28`) toward reachable owned land with dynamic mid-retreat replanning, deterministic trapped-unit cleanup (`TRAPPED_DESTRUCTION_TICKS = 6`, `MAX_STRANDED_RETREAT_TICKS = 36`), and captured `TankFactoryExecution` state reset.
4. **Authoritative AI Supply Drop Collection (Fix 4):** Moved supply-drop spawning, timing, AI auto-collection, and human click-claim validation into deterministic simulation execution (`SupplyDropExecution` + `ClaimSupplyDropExecution` + `ClaimSupplyDropIntentSchema`) synchronized identically across multiplayer peers via `GameUpdateType.SupplyDropEvent`, eliminating `initialOwnerID` traps and ensuring once-only rewards.
5. **Late-Game Stutter Elimination (Fix 5):** Eliminated per-10-tick late-game A\* cliffs (`TankExecution` bounding `maxIterations`), eliminated redundant `% 30 === 0` `placeName` allocations via per-player `playerLastNameTileChange` caching (`GameRunner`) and zero-allocation flat typed buffers (`NameBoxCalculator`), replaced expensive `TileSet.has` lookups in `PlayerExecution.calculateClusters` with `map.ownerID(tile) === mySmallID && map.isBorder(tile)`, removed scalar `Set` churn in `surroundedBySamePlayer`, and paused hidden `AvatarCustomizer` preview RAF redraws.

---

## Fix Details & Root Causes

### Fix 1: Dynamic Territory Avatars

- **Root Causes:** Country avatars used static small scale (`~1`), raw centroid/seed placement without connected-component or interior clearance awareness, and limited AI coverage.
- **Changes:**
  - `src/client/graphics/engine/TerritoryAnchor.ts`: Implemented `computeAvatarScale` (Hill curve half-saturation `AVATAR_HALF_SAT_TILES = 2200`, `[AVATAR_MIN_SCALE=0.9, AVATAR_MAX_SCALE=3.8]`), `deriveCountryAvatarConfig`, `findTerritoryAnchor` (reusable typed-array 4-connected BFS picking the largest connected owned landmass + 2-pass Chamfer clearance + fine refinement + hysteresis to avoid water, enemy land, concave holes, and erratic jumps), and `TerritoryAnchorManager` (`recordTileChange`, `resolveAnchor`, `removePlayer`, `clear`).
  - `src/client/graphics/engine/AvatarSystem.ts`: Added smooth world anchor and scale interpolation (`setTerritoryState`, `removeAvatar`), zoom-responsive scaling (`applyCameraZoomToAvatarScale`), and preserved identity transforms (`scale = 1`) for standalone UI portraits.
  - `src/client/view/GameView.ts`: Added differential `recordTileChange` hooks inside `packedTileUpdates` handling so anchors only recompute when ownership geometry changes meaningfully.
  - `src/client/graphics/engine/DualLayerEngine.ts` & `src/client/graphics/engine/DualLayerSetup.ts`: Passed `this.cameraScale` with zoomed viewport padding (`160 * Math.max(1, Math.min(2.5, invScale * 0.6))`), registered/updated avatars dynamically for all living human and AI countries on a rotating 12-player non-urgent budget plus immediate snap on anchor loss, and removed avatars upon elimination.

### Fix 2: Tanks Must Follow Changing Borders

- **Root Causes:** Tanks with `targetWaypoint` inside friendly territory skipped re-evaluation even when borders shifted outward, `SLOTTING_INTERVAL` caused staggered/stale interior parking, and invalid/cut-off waypoints blocked advancement.
- **Changes:**
  - `src/core/execution/TankExecution.ts`: Added `classifyTileFront` (`"enemy" | "neutral" | "coastal" | "none"`), invalidated stale interior waypoints, de-staggered periodic scans `(ticks + id) % 10 === 0` with shared cross-tick `slottingCache`, added reachable fallback waypoint selection when direct borders are cut off by terrain/water, enforced `isFriendlyRallyTile` validation for rally points, and kept active combat engagement intact.
  - Added bounded `maxIterations = Math.min(4500, Math.max(700, startH * 12))` and `allowEnemy` guard (`false` default for friendly/neutral deployment) in `FastTankAStar`.

### Fix 3: Tanks Stranded in Conquered Territory

- **Root Causes:** Early return on `TankState.Spearheading` bypassed tile ownership checks, stranded defensive tanks could sit indefinitely in enemy territory, retreated paths weren't replanned on further border loss, and captured `TankFactoryExecution` instances retained old owner tank arrays/rally tiles.
- **Changes:**
  - `src/core/execution/TankExecution.ts`: Enforced ownership checks before spearhead holds (`SPEARHEAD_MAX_HOLD_TICKS = 6`, exit spearhead immediately if tile becomes hostile), implemented non-teleporting 1-tile/tick retreat via reusable zero-allocation BFS `findNearestOwnedLandPath` (up to `MAX_RETREAT_DISTANCE = 28`) inside `handleStrandedInHostileTerritory`, dynamically replanned retreat paths if borders fell mid-retreat, and deterministically destroyed completely surrounded/trapped tanks (`TRAPPED_DESTRUCTION_TICKS = 6`, `MAX_STRANDED_RETREAT_TICKS = 36`). Dropped stale `factory` references upon capture/destruction.
  - `src/core/execution/TankFactoryExecution.ts`: Added `lastOwner` tracking; on capture resets `tanks.length = 0`, `productionProgress = 0`, `isBuilding = false`, and clears `factory.setTankRallyTile(undefined)`.

### Fix 4: Authoritative Deterministic AI & Human Supply Drops

- **Root Causes:** Supply drop collection relied on client-side `SupplyDropManager` view callbacks filtering out non-local players and blocking claims via `initialOwnerID === currentOwner`, causing AI drops to go uncollected and risking multiplayer state divergence.
- **Changes:**
  - `src/core/execution/SupplyDropExecution.ts` & `src/core/GameRunner.ts`: Created deterministic simulation execution (`DEFAULT_EVALUATION_INTERVAL_TICKS = 450`, `DEFAULT_MAX_ACTIVE_CRATES = 2`, `DEFAULT_DESCENT_TICKS = 30`). Never collects while `"descending"`; auto-collects landed drops in living AI territories (`Bot` and `Nation`) including initially-owned or later-conquered tiles; enforces neutral non-collection and strict once-only resource grants (`collected = true`) + `GameUpdateType.SupplyDropEvent` emissions.
  - `src/core/Schemas.ts`, `src/core/execution/ExecutionManager.ts`, `src/client/Transport.ts`, `src/core/game/Game.ts`, `src/core/game/GameImpl.ts`, `src/core/game/GameUpdates.ts`: Added `ClaimSupplyDropIntentSchema` (`"claim_supply_drop"`), `ClaimSupplyDropExecution` for human manual click/tap validation, `SendClaimSupplyDropIntentEvent`, `setSupplyDropSystem`, and `claimSupplyDrop`.
  - `src/client/graphics/engine/SupplyDropManager.ts`, `src/client/graphics/engine/DualLayerSetup.ts`, `src/client/graphics/engine/InputManager.ts`, `src/client/ClientGameRunner.ts`: Synchronized client crate visuals cleanly via `authoritativeMode` (`applyAuthoritativeSpawn`, `applyAuthoritativeClaim`), wired desktop click & touch tap intents without bypassing server/sim validation, and preserved existing visual effects and analytics.

### Fix 5: Late-Game Stutter Elimination

- **Root Causes:** Periodic tick-10 A\* cliff (`TankExecution`), un-cached `% 30 === 0` `placeName` 2D grid allocations on every player (`GameRunner` + `NameBoxCalculator`), heavy `TileSet.has` and `Set` allocations in `PlayerExecution` (`calculateClusters` & `surroundedBySamePlayer`), and hidden `AvatarCustomizer` preview RAF loops running in background UI panels.
- **Changes:**
  - `src/client/hud/NameBoxCalculator.ts`: Replaced per-call `boolean[][]` and row stack allocations in `placeName` with reusable flat typed buffers (`flatGridBuf`, `heightsBuf`, `stackBuf`, `findLargestInscribedRectFlat`).
  - `src/core/GameRunner.ts`: Added `playerLastNameTileChange` tracking so `% 30 === 0` skips unchanged territories while preserving `PackedPlayerUpdates.test.ts` cadence contracts.
  - `src/core/execution/PlayerExecution.ts`: Replaced `borderTiles.has(tile)` in `calculateClusters` with `map.ownerID(tile) === mySmallID && map.isBorder(tile)`, and replaced `new Set<number>()` in `surroundedBySamePlayer` with scalar `singleEnemyId`.
  - `src/core/execution/TankExecution.ts`: Added staggered tick evaluation (`(ticks + id) % 10 === 0`) and capped `maxIterations` on `FastTankAStar`.
  - `src/client/components/AvatarCustomizer.ts`: Paused hidden 60fps `requestAnimationFrame` preview redraws when not visible.

---

## Verification Results

### 1. Static Checks, Unit/Integration Suite & Production Build

- `npx tsc --noEmit`: Passed (0 errors)
- `npm run lint` (`oxlint` + `eslint`): Passed (0 warnings, 0 errors)
- `npx prettier --write` (on all modified and added files): Clean
- Targeted Mission 22 Vitest verification (post-final-edit): **6 test files, 56 passed**, 0 failed, 0 skipped (`tests/SupplyDropExecution.test.ts`, `tests/SupplyDropMultiplayerParity.test.ts`, `tests/TankBorderAndStranded.test.ts`, `tests/client/graphics/TerritoryAnchorAndAvatar.test.ts`, `tests/client/graphics/DualLayerEngine.test.ts`, `tests/client/graphics/SupplyDropClaimAndTimeout.test.ts`); full core/client & server suites verified on GitHub Actions CI.
- `npm run build-prod`: Passed cleanly (`tsc --noEmit` + `vite build` 1,206 modules)
- `node tests/perf/DesktopRegressionQa.cjs --mode=full`: Passed all regression checks, including:
  - `main_menu_and_branding`, `settings_modal_and_null_leave_lobby`, `responsive_viewport_mobile_to_desktop`
  - `keyboard_shortcuts_tactical_grid_altview`, `frame_pacer_max_fps_60_cap` (`fps: 60.03`), `webgl_context_lose_and_restore`
  - `consecutive_match_teardown_cycles` (3 cycles, 0 leaked canvases/rects), `singleplayer_zero_unexpected_errors`
  - `two_client_multiplayer_and_ws_reconnect` (`h: 360, j: 360`), `two_client_multiplayer_clean_teardown`

### 2. Performance Benchmarks (Headless Simulation & Live Chrome Late-Game Soak)

#### Headless Simulation (`npx tsx tests/perf/fullgame/FullGamePerf.ts`)

- **`World` (`bots=400`, 4,500 game ticks, Desktop Ryzen 7 9800X3D):**
  - End state: 4,802 total ticks (302 spawn), 42 alive players, 1,009 units, peak heap `99 MB`
  - Tick timing: **`mean 3.39ms | p50 3.10ms | p95 6.28ms | p99 8.57ms | max 53.6ms`**
  - Ticks over 100ms budget: **`0 / 4500`**
  - GC overhead: `122ms` (`0.8%` of game-phase wall time)
  - Slowest ticks are completely de-staggered (`#4407`, `#4380`, `#3259`, `#3836`, `#2966`) — tick-10 A\* spike eliminated; `SupplyDropExecution` total cost = `3.57ms` (`0.0%`).
- **`GiantWorldMap` (`400 bots`, 4,000 game ticks, 4,302 total ticks, Desktop Ryzen 7 9800X3D):**
  - End state: `133` alive players, `996` units, peak heap `104 MB`, `Final hash: 49162941063693230`
  - Tick timing: **`mean 6.06ms | p50 5.68ms | p95 10.1ms | p99 13.1ms | max 21.4ms`** (`#4276`), **`0 / 4000`** ticks over 100ms budget
  - GC overhead: `181ms` (`0.7%` of game-phase wall time, max major GC pause `4.75ms`); `SupplyDropExecution` = `4.40ms` (`0.0%`).

#### Review of Initial 45s `World` (`100 bots`) Chromium Soak vs Reported ~3s Smooth / ~1s Lag Pattern

A critical methodological audit during Mission 22.1 established that the initial 45-second `World` (`100 bots`) Chromium soak did **not** on its own reproduce or prove elimination of the reported ~3s smooth / ~1s lag late-game pattern, because:

1. No equivalent `origin/main` baseline Chromium trace was captured side-by-side to prove the pattern reproduced on baseline.
2. Only `World` with `100` bots was soaked for `45s`, without capturing Web Worker `tickExecutionDuration`, `% 30` (`3.0s`) `playerNameViewData` handler breakdowns, or 1-second time-bucketed timelines.
3. Chromium's `Emulation.setCPUThrottlingRate` throttles only the main renderer thread while Web Workers run on separate OS threads near native speed, meaning a 45s `World` (`100 bots`) main-thread `rAF` summary alone cannot isolate worker-side simulation spikes.

#### Side-by-Side 90s Late-Game Comparison (`origin/main` vs PR #17 — `Giant World Map`, `400 bots`, `1920x1080` WebGL2)

Equivalent games were fast-forwarded past tick `2,500` into heavy late-game combat (`~137–171` active tanks, `~856–988` total units, `~182–207` alive countries) and soaked for **90 seconds** at `1x` speed in headless Chromium, instrumenting Web Worker `tickExecutionDuration`, main-thread `WorkerClient` message handlers (split by `% 30` `hasNameData`), `requestAnimationFrame` frame times, `longtask` entries, and per-second buckets:

| Workload & Branch                            | End State (`tick` / `units` / `tanks` / `alive`) | Worker Tick (`mean` / `p50` / `p95` / `p99` / `max`)      | Worker `>50ms` | Main Handler (`p95` / `max`) | `rAF` `p99` / `>33.4ms` | Lag Secs (`maxDt>50 \|\| w>50 \|\| h>25`)                    |
| -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | -------------- | ---------------------------- | ----------------------- | ------------------------------------------------------------ |
| **`origin/main` (`CPU_THROTTLE=4` sim)**     | `3430` / `869` / `137` / `194`                   | `10.47` / `6.5` / **`44.6`** / **`77.9`** / **`89.8 ms`** | **`38 / 860`** | `5.3` / `23.0 ms`            | `11.0 ms` / `2`         | **`39 / 90 s`**                                              |
| **PR #17 (`CPU_THROTTLE=4` sim)**            | `3463` / `868` / `153` / `182`                   | `7.63` / `7.3` / **`12.0`** / **`14.3`** / **`16.0 ms`**  | **`0 / 860`**  | `8.1` / `10.7 ms`            | `11.1 ms` / `2`         | **`1 / 90 s`** (single frame bump `sec 14`, 0 worker spikes) |
| **`origin/main` (`CPU_THROTTLE=1` desktop)** | `3520` / `856` / `149` / `207`                   | `11.07` / `6.4` / **`53.8`** / **`77.5`** / **`83.2 ms`** | **`48 / 865`** | `1.2` / `16.9 ms`            | `5.7 ms` / `0`          | **`48 / 90 s`**                                              |
| **PR #17 (`CPU_THROTTLE=1` desktop)**        | `3597` / `988` / `171` / `189`                   | `8.47` / `7.9` / **`13.1`** / **`16.3`** / `161.7 ms`\*   | `1 / 864`\*    | `1.7` / `2.8 ms`             | `5.7 ms` / `1`          | **`2 / 90 s`** (1 frame bump `sec 37`, 1 outlier `sec 73`\*) |

_\*On `origin/main`, per-second Web Worker max tick duration climbed steadily into `50–89.8ms` across nearly every 1-second window from second 39 onward (`48/865` ticks >50ms at `1x`, `38/860` at `4x`), approaching the `100ms` 10Hz tick budget as tank counts rose. On PR #17, worker ticks remained flat at `~7–16ms` across all 90s (`-73%` to `-76%` `p95`, `-82%` `p99`), with 1 isolated external `161.7ms` outlier at `sec 73` during the `1x` browser run; the headless `FullGamePerf.ts` 4,000-tick `GiantWorldMap` (`400 bots`) trace showed `0 / 4,000` ticks above `21.4ms`, confirming the outlier is not a recurring deterministic sim spike. In static Spectate camera mode, `% 30` (`3.0s`) `playerNameViewData` main-thread handlers stayed `<= 6.2ms` (`1.3–1.8ms` at `1x`), so an exact `3s smooth / 1s lag` main-thread sawtooth was not reproduced against `origin/main` under static Spectate, while the severe late-game worker-tick sawtooth/climb (`up to 89.8ms`) was directly reproduced on `origin/main` and eliminated on PR #17._

---

## Mission 22.1 — Final Release Candidate Verification

### 1. Multiplayer Parity & Human Click-to-Claim Verification

- **Automated Two-Client Lockstep Parity Test ([tests/SupplyDropMultiplayerParity.test.ts](tests/SupplyDropMultiplayerParity.test.ts)):** Verified two independent synced client simulation instances (`Host` & `Joiner`) plus authoritative client `SupplyDropManager` mirrors:
  - AI auto-claim grants identical `gold`/`troops`, emits identical `SupplyDropEvent` claims & `fxClaims`, clears active crates across both peers, rejects premature descending claims, and preserves bit-identical `game.hash()`.
  - Manual human click-to-claim (`ClaimSupplyDropIntentSchema`) rejects alien territory clicks, enforces strictly once-only awards even when duplicate claim intents arrive in the same or subsequent ticks, and preserves identical `game.hash()`.
- **Live Two-Browser Multiplayer E2E (`Iceland`, 80 Easy bots, local `Server.ts` + 2 headless Chromium instances):**
  - Both Host and Joiner browsers observed bit-identical `SupplyDropEvent` spawn (`tick 752`, `dropId 1`, `tile 1402837`, `troops 9390`, `gold 88026`, initially neutral `playerSmallId 0` -> no premature claim), followed after `Galician Dominion` (`smallID: 31`, `BOT`) conquered `tile 1402837` by bit-identical `claim` event (`tick 1109`) and identical synced player totals at `tick 1111` (`gold: "128476"`, `troops: 25225`).
- **Live Chromium Human Click-to-Claim UI Check (`Iceland`, `Easy`, 0 bots):**
  - Expanded human territory onto dropped crate `dropId 6` (`tick 3154`, `tile 2151043`, `late`, `troops: 106099`, `gold: 13504599`), waited for client parachute landing (`DESCENT_DURATION_MS`), and dispatched **two rapid UI mouse clicks (`50ms` apart)** at screen coordinates `(970, 629)`.
  - Verified strictly `1` claim event (`tick 3257`, `playerSmallId: 1`) and single award: `goldBefore: 325100 -> goldAfter: 13830599` (`goldDelta: +13505499` = crate `+13504599` + `+900` passive tick income over 9 ticks `3255 -> 3264`), `troopsBefore: 3123400 -> troopsAfter: 3193381` (`troopsDelta: +69981` net of natural cap/drain).

### 2. Tank Movement, Avatar Positioning & Memory Regression Checks

- **Memory Stability (Forced-GC Checkpoints on `Giant World Map`, `400 bots`):** Using `HeapProfiler.collectGarbage` + `--expose-gc` in Chromium:
  - `tick 545`: **`23.05 MB`** JS heap post-GC, `15,350` DOM nodes (`64` units, `0` tanks)
  - `tick 1529`: **`24.68 MB`** JS heap post-GC, `15,058` DOM nodes (`290` units, `0` tanks)
  - `tick 2527`: **`25.48 MB`** JS heap post-GC, `15,078` DOM nodes (`429` units, `18` tanks, `3` in hostile transition)
  - `tick 3053`: **`25.19 MB`** JS heap post-GC, `15,078` DOM nodes (`690` units, `65` tanks, `7` actively fighting/transitioning)
  - 90s late-game Chromium `memTimeline` remained flat (`25.24 -> 27.95 MB` at `CPU=4x`; `26.83 -> 30.29 MB` at `CPU=1x`), confirming zero memory leak.
- **Tank Movement & Stranded-Unit Regression Check:** Across `tick 2527 -> 3053` on `Giant World Map` (`400 bots`), `18` tanks were sampled at `2527`, `16` survived to `3053`, and **`16 / 16` (`100%`) actively relocated tiles** as borders shifted. All `tests/TankBorderAndStranded.test.ts` (`10` tests) and `tests/client/graphics/TerritoryAnchorAndAvatar.test.ts` (`6` tests) suites pass.

### 3. Visual Verification (Chrome Screenshots)

Inspected live screenshots captured across early zoomed-in gameplay (`m22_avatar_early_zoomin.png`), late-game Spectate mid-zoom (`m22_avatar_late_midzoom.png`), and late-game Spectate overview (`m22_avatar_late_zoomout.png`):

- Human and AI territory avatars both render cleanly with smooth nonlinear size differences between small nations (e.g., Venezuela, Italy) and large empires (e.g., Bolivia, Benin, DR Congo, Sri Lanka), centered inside owning borders without water/enemy leaks.
- Active tank units/factories align on coastlines and frontlines with zero phantom tanks left inside conquered interiors.
- AI supply-drop auto-collection triggers floating gold notifications (`+101580 Gold`, `+108198 Gold`, `+110199 Gold`, etc.) cleanly on landed crates.

---

## Modified & Added Files

### Modified

- `src/client/ClientGameRunner.ts`
- `src/client/Transport.ts`
- `src/client/components/AvatarCustomizer.ts`
- `src/client/graphics/engine/AvatarSystem.ts`
- `src/client/graphics/engine/DualLayerEngine.ts`
- `src/client/graphics/engine/DualLayerSetup.ts`
- `src/client/graphics/engine/InputManager.ts`
- `src/client/graphics/engine/SupplyDropManager.ts`
- `src/client/hud/NameBoxCalculator.ts`
- `src/client/view/GameView.ts`
- `src/core/GameRunner.ts`
- `src/core/Schemas.ts`
- `src/core/execution/ExecutionManager.ts`
- `src/core/execution/PlayerExecution.ts`
- `src/core/execution/TankExecution.ts`
- `src/core/execution/TankFactoryExecution.ts`
- `src/core/game/Game.ts`
- `src/core/game/GameImpl.ts`
- `src/core/game/GameUpdates.ts`
- `tests/client/graphics/DualLayerEngine.test.ts`

### Added

- `src/client/graphics/engine/TerritoryAnchor.ts`
- `src/core/execution/SupplyDropExecution.ts`
- `tests/SupplyDropExecution.test.ts`
- `tests/SupplyDropMultiplayerParity.test.ts`
- `tests/TankBorderAndStranded.test.ts`
- `tests/client/graphics/TerritoryAnchorAndAvatar.test.ts`
- `frontierx_mission22_smooth_frontiers_report.md`

---

## PR & CI Status

- **Pull Request:** https://github.com/hanukayoav/OpenFront-remix/pull/17 (open against `main`, not merged, not deployed)
- **Milestone:** `#7` (`v1.0.7 - Mission 22: Operation Smooth Frontiers`)
- **GitHub Actions Checks (PR #17):**
  - `🎨 Prettier`: **pass**
  - `🏗️ Build`: **pass**
  - `🔍 Lint`: **pass**
  - `🔬 Test`: **pass**
  - `🗺️ Generated maps up to date`: **pass**
  - `Evaluate gate`: **pass**
  - `Auto-assign author`: **pass**
  - `Has Milestone`: **pass**
  - `Deploy`: skipped (PR branch not merged/deployed)
