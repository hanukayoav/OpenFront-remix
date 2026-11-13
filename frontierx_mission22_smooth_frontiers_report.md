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
- `npm run lint` (`oxlint` + `eslint`): Passed (0 warnings, 0 errors across 865 files)
- `npx prettier --write` (on all modified and added files): Clean
- `npm test`:
  - Core/Client Vitest suite: **284 test files, 3,169 passed**, 0 failed, 0 skipped (including new `tests/client/graphics/TerritoryAnchorAndAvatar.test.ts` [6 tests], `tests/SupplyDropExecution.test.ts` [5 tests], `tests/TankBorderAndStranded.test.ts` [10 tests], plus existing `tests/client/graphics/DualLayerEngine.test.ts` [29 tests] and `tests/client/graphics/SupplyDropClaimAndTimeout.test.ts` [4 tests])
  - Server Vitest suite (`tests/server`): **35 test files, 319 passed**, 0 failed, 0 skipped
- `npm run build-prod`: Passed cleanly (`tsc --noEmit` + `vite build` 1,206 modules)
- `node tests/perf/DesktopRegressionQa.cjs --mode=full`: Passed all regression checks, including:
  - `main_menu_and_branding`, `settings_modal_and_null_leave_lobby`, `responsive_viewport_mobile_to_desktop`
  - `keyboard_shortcuts_tactical_grid_altview`, `frame_pacer_max_fps_60_cap` (`fps: 60.03`), `webgl_context_lose_and_restore`
  - `consecutive_match_teardown_cycles` (3 cycles, 0 leaked canvases/rects), `singleplayer_zero_unexpected_errors`
  - `two_client_multiplayer_and_ws_reconnect` (`h: 360, j: 360`), `two_client_multiplayer_clean_teardown`

### 2. Performance Benchmarks (Headless Simulation & Live Chrome Late-Game Soak)

#### Headless Simulation (`npx tsx tests/perf/fullgame/FullGamePerf.ts`)

- **`World` (`bots=400`, 4,500 game ticks, post-final-edit run, Desktop Ryzen 7 9800X3D):**
  - End state: 4,802 total ticks (302 spawn), 42 alive players, 1,009 units, peak heap `99 MB`
  - Tick timing: **`mean 3.39ms | p50 3.10ms | p95 6.28ms | p99 8.57ms | max 53.6ms`**
  - Ticks over 100ms budget: **`0 / 4500`**
  - GC overhead: `122ms` (`0.8%` of game-phase wall time)
  - Slowest ticks are completely de-staggered (`#4407`, `#4380`, `#3259`, `#3836`, `#2966`) — tick-10 A\* spike eliminated; `SupplyDropExecution` total cost = `3.57ms` (`0.0%`).
- **`GiantWorldMap` (`100 bots`, 3,000 game ticks, Fix 2+3+4+5 pass on Desktop Ryzen 7 9800X3D):**
  - `mean 3.57ms | p50 3.14ms | p95 7.01ms | p99 10.2ms` (`TileSet.has` reduced from `16.1%` baseline to `6.6%`).

#### Live Chromium Late-Game Browser Soak (`World`, `100 bots`, fast-forwarded past tick 2,500 then 45s 1x live soak, 1920x1080 WebGL2)

| Environment                                                           | Ticks Measured | End Units / Tanks                      | Mean `dt`   | `p95` `dt`  | `p99` `dt`  | Frames `> 33.4ms`                  | Long Tasks (`>50ms`) |
| --------------------------------------------------------------------- | -------------- | -------------------------------------- | ----------- | ----------- | ----------- | ---------------------------------- | -------------------- |
| **Desktop Native (`CPU_THROTTLE=1`)** — Ryzen 7 9800X3D + RTX 5070 Ti | `3169 -> 3601` | `645` units / `131` tanks / `42` alive | **5.57 ms** | **5.70 ms** | **5.70 ms** | `1 / 8111` (initial boundary only) | **0**                |
| **Controlled Weak-HW Simulation (`CPU_THROTTLE=4` via CDP)**          | `2505 -> 2937` | `312` units / `32` tanks / `54` alive  | **5.70 ms** | **5.70 ms** | **5.70 ms** | `3 / 8033` (**99.96%** under 33ms) | **0**                |

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
- `tests/TankBorderAndStranded.test.ts`
- `tests/client/graphics/TerritoryAnchorAndAvatar.test.ts`
- `frontierx_mission22_smooth_frontiers_report.md`

---

## PR & CI Status

- _Pending PR creation and GitHub Actions verification (Step 5)._
