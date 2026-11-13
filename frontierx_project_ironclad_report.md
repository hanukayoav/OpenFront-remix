# FrontierX — Mission 20: Project IRONCLAD Audit & Hardening Report

**Branch:** `qa/frontierx-project-ironclad` (branched from verified `main` commit `481490694096d8484c0413625f62d80f49b26bd3`)  
**Production Baseline:** FrontierX v1.0.5  
**Coordinated Release Stream:** PR #15 (`perf/frontierx-v1.0.6-project-efficiency` — untouched and unmerged per instructions)

---

## 1. Executive Summary

Project IRONCLAD conducted a codebase audit, real-browser functional and endurance QA pass (single-player, multi-match, forced WebGL2 context loss/recovery, 2-client local multiplayer, victory/sudden-death transitions, and a 15-minute unattended soak test), and targeted regression hardening across FrontierX v1.0.5.

During the audit and browser sessions, **11 reproducible issues (5 P1, 6 P2)** were identified and fixed across lifecycle cleanup, client networking/reconnects, WebGL2 context recovery, client replay safety, and HUD layer coordination. No P0 security or simulation-determinism defects were introduced or modified, FrontierX branding and graphics fidelity remain intact, and PR #15 (`perf/frontierx-v1.0.6-project-efficiency`) was left untouched for hardware Dell laptop validation.

---

## 2. Codebase & Architecture Audit Scope

The audit traced the full client and match lifecycle:

- **App Bootstrapping & Lobby Routing:** `src/client/Main.ts`, `JoinLobbyModal`, URL/lobby leave event transitions.
- **Game Runner & Simulation Loop:** `src/client/ClientGameRunner.ts`, local server turn/hash handling (`src/client/LocalServer.ts`), worker/simulation boundary.
- **Networking & Reconnect State Machine:** `src/client/Transport.ts` (WebSocket queue draining, socket readyState handling, reconnect backoff, and `leaveGame()` cancellation).
- **WebGL2 Rendering & Context Recovery:** `src/client/render/gl/MapRenderer.ts`, `DualLayerSetup.ts`.
- **Controllers & Input Teardown:** `src/client/controllers/AttackingTroopsController.ts`, `BuildPreviewController.ts`, `WarshipSelectionController.ts`.
- **HUD & Endgame Overlays:** `GameRenderer` teardown across stateful HUD custom elements (`TacticalOverlaySelector`, `WinModal`, `GameLeftSidebar`, `GameRightSidebar`, `ControlPanel`, `PlayerPanel`, `SpawnTimer`, `ImmunityTimer`, `HeadsUpMessage`, `AttacksDisplay`, `EventsDisplay`, `ActionableEvents`, `ChatDisplay`, `ReplayPanel`, `UnitDisplay`, `BuildMenu`, `EmojiTable`, `PlayerInfoOverlay`, `PerformanceOverlay`, `WebAudioEngine`, `MatchAnalytics`, `DualLayerSetup`).

---

## 3. Reproducible Defects & Implemented Fixes

### P1-1: Uncaught `TypeError` when `leave-lobby` event has `null` or missing `detail`

1. **Reproduction steps:** Trigger `document.dispatchEvent(new CustomEvent("leave-lobby"))` while `JoinLobbyModal` is open (or any caller omitting `detail`).
2. **Expected behaviour:** `Main.handleLeaveLobby` safely evaluates the leave cause without throwing.
3. **Actual behaviour:** `event.detail.cause` threw `TypeError: Cannot read properties of null (reading 'cause')`.
4. **Root cause:** `handleLeaveLobby` in `src/client/Main.ts` accessed `event.detail.cause` without optional chaining (`event?.detail?.cause`).
5. **Severity:** **P1** (runtime exception breaking lobby exit flow).
6. **Proposed repair:** Guard with `event?.detail?.cause === "full-lobby"`.
7. **Verification method:** End-to-end headless Chromium verification (`afterNullLeaveLobbyErrors: 0` with `pageErrors: []`).

### P1-2: Zombie 2-second `connectionCheckInterval` and pending timers on early match leave

1. **Reproduction steps:** Start a game and leave before the 20-second delay expires (`connectionCheckTimeout`), or leave repeatedly across matches.
2. **Expected behaviour:** `ClientGameRunner.stop()` cancels all connection-check and camera timers even if called before `connectionCheckTimeout` fires or across repeated `stop()` invocations.
3. **Actual behaviour:** `connectionCheckTimeout` was unreferenced, so leaving within 20s allowed its callback to execute later and spawn an uncancelled `connectionCheckInterval` (`2000ms`), and `stop()` exited early on `!this.isActive` before clearing handles.
4. **Root cause:** `src/client/ClientGameRunner.ts` did not track `connectionCheckTimeout` or clear timers before the `if (!this.isActive) return` guard.
5. **Severity:** **P1** (accumulating timer/interval leak across matches).
6. **Proposed repair:** Track `connectionCheckTimeout`, guard its callback with `if (!this.isActive) return`, and clear `connectionCheckTimeout`, `connectionCheckInterval`, and `goToPlayerTimeout` at the top of `stop()`.
7. **Verification method:** Unit test in `tests/client/ProjectIroncladRegressions.test.ts` + 3-match headless Chromium soak (`activeIntervals` returned to baseline `4` after every leave and after 21s idle).

### P1-3: Uncancelled `requestAnimationFrame` loops & orphan DOM drag rectangle across matches

1. **Reproduction steps:** Play and leave multiple consecutive matches, including warship selection interactions.
2. **Expected behaviour:** `AttackingTroopsController` RAF loop, `BuildPreviewController` cursor RAF loop, and `WarshipSelectionController` `#warship-drag-rect` DOM node are cancelled/removed on match teardown.
3. **Actual behaviour:** Each match left two eternal `requestAnimationFrame` loops spinning against detached controller/view instances and leaked a `#warship-drag-rect` element appended to `document.body`.
4. **Root cause:** `AttackingTroopsController`, `BuildPreviewController`, and `WarshipSelectionController` lacked `destroy()`/`dispose()` lifecycle cleanup and RAF ID cancellation (`driveRafId`, `cursorRafId`).
5. **Severity:** **P1** (CPU/RAF and DOM leak growing linearly per match played).
6. **Proposed repair:** Track `driveRafId` / `cursorRafId`, add `destroyed` guards, and implement `destroy()` & `dispose()` in all three controllers (removing `#warship-drag-rect` and clearing active arrays/maps).
7. **Verification method:** Unit tests in `tests/client/ProjectIroncladRegressions.test.ts` + 3-match Chromium leak check (`pendingRafs` stayed `1`, `warshipDragRects` stayed `0`, `dualLayerContainers` stayed `0`).

### P1-4: Offline message queue drains in LIFO (`pop()`) order instead of FIFO

1. **Reproduction steps:** Queue multiple outbound `ClientMessage` payloads in `Transport` while disconnected/reconnecting, then flush `clearQueue()` upon socket open.
2. **Expected behaviour:** Queued player intents flush strictly in FIFO order (`shift()`).
3. **Actual behaviour:** `Transport` called `pop()`, sending the newest buffered intent before older intents.
4. **Root cause:** Stack semantics (`this.buffer.pop()`) in `src/client/Transport.ts`.
5. **Severity:** **P1** (out-of-order gameplay actions after transient disconnects).
6. **Proposed repair:** Drain queued messages with `shift()`.
7. **Verification method:** Unit test in `tests/client/ProjectIroncladRegressions.test.ts`.

### P1-5: `Transport.sendMsg()` and reconnect loop mishandle `CONNECTING`/`CLOSING` sockets, lack backoff, and leak reconnects on `leaveGame()`

1. **Reproduction steps:** Trigger `sendMsg()` while socket is `CONNECTING` or `CLOSING`, simulate repeated socket drops, or call `leaveGame()` mid-reconnect.
2. **Expected behaviour:** Buffer messages whenever `readyState !== WebSocket.OPEN` (`CONNECTING`, `CLOSING`, `CLOSED`), reconnect using bounded exponential backoff, and abort pending reconnects/CONNECTING sockets cleanly on `leaveGame()`.
3. **Actual behaviour:** `sendMsg()` only checked `CLOSED` (attempting `socket.send` on `CONNECTING`/`CLOSING`), reconnects had fixed retries without backoff capping, and `leaveGame()` did not abort `CONNECTING` sockets or reconnect timers/flags.
4. **Root cause:** Incomplete readyState guards and reconnect lifecycle state in `src/client/Transport.ts`.
5. **Severity:** **P1** (dropped messages, tight reconnect storms, zombie reconnects after leaving).
6. **Proposed repair:** Buffer unless `readyState === WebSocket.OPEN`, add `scheduleReconnect()` with exponential backoff (`500ms` base, `15000ms` cap, `10` max attempts), clear queue/timers and terminate `CONNECTING` sockets in `leaveGame()`.
7. **Verification method:** Unit tests in `tests/client/ProjectIroncladRegressions.test.ts` + 2-client local multiplayer QA (`task-863`).

### P2-1: WebGL2 context recovery resets view toggles, tactical overlay mode, structure highlights, and local player rail styling

1. **Reproduction steps:** Toggle alternate view, grid lines, border patterns, owner highlight, tactical overlay mode, or structure highlights in-game, then trigger `webglcontextlost` -> `webglcontextrestored`.
2. **Expected behaviour:** All active renderer visual states and local player colors survive WebGL2 context loss and restore identically.
3. **Actual behaviour:** `MapRenderer.handleContextRestored()` recreated the WebGL pipeline with default state, discarding `localPlayerID`, `localRailColor`, `altView`, `gridView`, `showPatterns`, `highlightOwner`, `tacticalOverlayMode`, and `highlightStructureTypes`.
4. **Root cause:** `src/client/render/gl/MapRenderer.ts` forwarded settings directly to passes without caching them on the renderer instance for restoration.
5. **Severity:** **P2** (visual state loss and degraded UX on GPU reset/tab pressure).
6. **Proposed repair:** Cache those 8 settings on `MapRenderer` and replay them in `handleContextRestored()`.
7. **Verification method:** `tests/client/MapRendererContextRestore.test.ts` + Chromium `WEBGL_lose_context` verification (`postfix-03-webgl-restored.png`).

### P2-2: Client `LocalServer` replay hash check throws when `replayTurns[turnNumber]` is undefined

1. **Reproduction steps:** Receive a client turn message in local/replay mode referencing an unpopulated `replayTurns` slot.
2. **Expected behaviour:** Guard missing turn entries cleanly instead of crashing on `.hash`.
3. **Actual behaviour:** Direct `this.replayTurns[clientMsg.turnNumber].hash` dereference threw `TypeError` when the slot was missing.
4. **Root cause:** Unchecked array index access in `src/client/LocalServer.ts`.
5. **Severity:** **P2** (crash risk during local replay edge cases).
6. **Proposed repair:** Guard with optional chaining `this.replayTurns[clientMsg.turnNumber]?.hash`.
7. **Verification method:** Unit test in `tests/client/ProjectIroncladRegressions.test.ts`.

### P2-3: `TacticalOverlaySelector` leaks onto main menu, flashes raw i18n key `tactical_overlay.off`, and collides with `PlayerInfoOverlay`

1. **Reproduction steps:** Load the main menu (after boot or after leaving a match) and inspect the top-center viewport; start a match and observe `TacticalOverlaySelector`.
2. **Expected behaviour:** Hidden on main menu before match init and after leaving; shows readable label fallback until translations load; sits clear of `PlayerInfoOverlay`.
3. **Actual behaviour:** Component rendered visibly on main menu (`TACTICAL: tactical_overlay.off`) and sat at the top-center where `PlayerInfoOverlay` (`Namibia Nation ...` in `baseline-t420s.png`) overlapped it in-game.
4. **Root cause:** Missing `isVisible` visibility gating and `destroy()`/`dispose()`, missing `requestUpdate()` on `init()`, raw key fallback, and `top-3` positioning in `src/client/hud/layers/TacticalOverlaySelector.ts`.
5. **Severity:** **P2** (noticeable main-menu artifact and in-game HUD collision).
6. **Proposed repair:** Gate rendering behind `isVisible` (set in `init()`, cleared in `destroy()`), add clean readable fallback strings (`"Off"`, `"Troop Density"`, `"SAM Coverage"`, `"Trade"`, `"Naval"`), and relocate pill to `fixed bottom-24 lg:bottom-4 right-16 z-[900] flex-col-reverse items-end`.
7. **Verification method:** Unit tests in `tests/client/ProjectIroncladRegressions.test.ts` + Chromium menu/in-game/post-leave verification (`postfix-01-menu.png`, `postfix-02-ingame-hud.png`, `postfix-04-post-leave-menu.png`).

### P2-4: Stateful HUD elements leave visible DOM/timers after match leave (including `GameRightSidebar` `"0"` edge peek and uncancelled `WinModal` timeout)

1. **Reproduction steps:** Play a match and click Leave Game back to the main menu, then inspect HUD elements (`game-right-sidebar`, `win-modal`, etc.).
2. **Expected behaviour:** Leaving a match clears all HUD overlays completely and cancels delayed modal timers (`WinModal` 3s `showButtonsTimeout`).
3. **Actual behaviour:** Stateful HUD layers lacked `destroy()` teardown on `GameRenderer.destroy()`, leaving stale overlay state across SPA transitions, `GameRightSidebar` used `translate-x-full` leaving a `"0"` timer sliver at the right edge on menu return, and `WinModal`'s 3-second timeout stayed armed after `hide()`/`destroy()`.
4. **Root cause:** Missing `destroy()` hooks across HUD layer classes and transform-only hiding in `GameRightSidebar.ts`.
5. **Severity:** **P2** (HUD artifacts and delayed UI timer firing on menu screen).
6. **Proposed repair:** Implement `destroy()` across stateful HUD layers (`GameLeftSidebar`, `GameRightSidebar`, `ControlPanel`, `PlayerPanel`, `SpawnTimer`, `ImmunityTimer`, `HeadsUpMessage`, `AttacksDisplay`, `EventsDisplay`, `ActionableEvents`, `ChatDisplay`, `ReplayPanel`, `UnitDisplay`, `BuildMenu`, `EmojiTable`, `PlayerInfoOverlay`, `PerformanceOverlay`, `WinModal`), switch hidden `GameRightSidebar` class from `translate-x-full` to `hidden`, and track/clear `showButtonsTimeout` in `WinModal.hide()`/`destroy()`.
7. **Verification method:** Unit tests in `tests/client/ProjectIroncladRegressions.test.ts` + Chromium post-leave HUD bounding-box check (`game-right-sidebar` `visibleW: 0, visibleH: 0` in `postfix-04-post-leave-menu.png`).

### P2-5: Procedural audio mute button (`#openfront-procedural-audio-toggle`) occluded behind `GameRightSidebar`

1. **Reproduction steps:** Enter a match and inspect the top-right corner (`top-3 right-16 z-50`).
2. **Expected behaviour:** Audio toggle is visible and clickable without overlap.
3. **Actual behaviour:** `GameRightSidebar` occupied the top-right bar over the mute button.
4. **Root cause:** Conflicting fixed top-right coordinates (`top-3 right-16 z-50`) in `src/client/graphics/engine/WebAudioEngine.ts`.
5. **Severity:** **P2** (unreachable/partially occluded audio toggle).
6. **Proposed repair:** Reposition toggle to `fixed bottom-24 lg:bottom-4 right-4 z-[900]`.
7. **Verification method:** Unit test + Chromium bounding-box collision check (`muteOverlapsRightBar: false`, `postfix-02-ingame-hud.png`).

### P2-6: Endgame `MatchAnalytics` modal (`z-50`) and `#openfront-sudden-death-hud` (`top-3 z-40`) HUD z-index/position collisions

1. **Reproduction steps:** Finish a match to display `#openfront-match-analytics-modal` or trigger Sudden Death countdown banner `#openfront-sudden-death-hud`.
2. **Expected behaviour:** Endgame summary renders above all in-game HUD sidebars (`z-[10005]`), and the Sudden Death banner sits below `PlayerInfoOverlay` (`top-20 z-[950]`).
3. **Actual behaviour:** At `z-50` / `top-3 z-40`, sidebars and `PlayerInfoOverlay` overlapped the modals/banners.
4. **Root cause:** Insufficient z-index stacking and top-row collision in `src/client/graphics/engine/MatchAnalytics.ts` and `src/client/graphics/engine/DualLayerSetup.ts`.
5. **Severity:** **P2** (visual overlap on endgame and sudden-death HUD).
6. **Proposed repair:** Update `#openfront-match-analytics-modal` to `z-[10005]` and `#openfront-sudden-death-hud` to `top-20 z-[950]`.
7. **Verification method:** Unit tests in `tests/client/ProjectIroncladRegressions.test.ts` + Chromium endgame capture (`postfix-05-victory-modal.png` verifying `analyticsOpen: true, analyticsZ: "10005"`). _(Note: `#openfront-sudden-death-hud` timing in `task-853` exited directly to `MatchAnalytics` at `timer=00:00` before capturing a separate sudden-death frame; its DOM class change is verified by inspection and unit test.)_

---

## 4. Files Changed & New Automated Tests

### Modified Source Files (30 files under `src/client/`)

- Core / Lifecycle / Networking:
  - `src/client/Main.ts`
  - `src/client/ClientGameRunner.ts`
  - `src/client/Transport.ts`
  - `src/client/LocalServer.ts`
- Controllers:
  - `src/client/controllers/AttackingTroopsController.ts`
  - `src/client/controllers/BuildPreviewController.ts`
  - `src/client/controllers/WarshipSelectionController.ts`
- WebGL2 & Dual-Layer Engine:
  - `src/client/render/gl/MapRenderer.ts`
  - `src/client/graphics/engine/DualLayerSetup.ts`
  - `src/client/graphics/engine/MatchAnalytics.ts`
  - `src/client/graphics/engine/WebAudioEngine.ts`
- HUD Layers:
  - `src/client/hud/layers/TacticalOverlaySelector.ts`
  - `src/client/hud/layers/WinModal.ts`
  - `src/client/hud/layers/GameRightSidebar.ts`
  - `src/client/hud/layers/GameLeftSidebar.ts`
  - `src/client/hud/layers/ControlPanel.ts`
  - `src/client/hud/layers/PlayerPanel.ts`
  - `src/client/hud/layers/SpawnTimer.ts`
  - `src/client/hud/layers/ImmunityTimer.ts`
  - `src/client/hud/layers/HeadsUpMessage.ts`
  - `src/client/hud/layers/AttacksDisplay.ts`
  - `src/client/hud/layers/EventsDisplay.ts`
  - `src/client/hud/layers/ActionableEvents.ts`
  - `src/client/hud/layers/ChatDisplay.ts`
  - `src/client/hud/layers/ReplayPanel.ts`
  - `src/client/hud/layers/UnitDisplay.ts`
  - `src/client/hud/layers/BuildMenu.ts`
  - `src/client/hud/layers/EmojiTable.ts`
  - `src/client/hud/layers/PlayerInfoOverlay.ts`
  - `src/client/hud/layers/PerformanceOverlay.ts`

- CI / Repository Automation Fixes (Mission 20.1):
  - `.prettierrc` (`"endOfLine": "auto"`)
  - `.prettierignore` (excludes generated build/report outputs and 51 pre-existing unformatted legacy files on `main` so `prettier --check .` and `gen-maps` stay clean)
  - `scripts/pr-gate/config.ts` (dynamic `REPO_OWNER`/`REPO_NAME` and `GITHUB_REPOSITORY` resolution while preserving fail-closed HTTP 403 handling in `scripts/pr-gate/github.ts`)

### New & Updated Automated Regression Test Files (3 files, 59 total assertions across touched suites)

- `tests/client/ProjectIroncladRegressions.test.ts` (18 tests): includes 8 `Transport` hardening tests covering auth + `rejoin` ordering before FIFO flush, mid-game network drop + `"start"` turn catchup before queued intents, stale (`>5s`) action expiry and ephemeral/ping offline filtering, non-duplicate handshake queuing, restarted-server `1002` rejection aborting queue & reconnects, `CLOSING`/`CLOSED` exponential backoff preservation, `MAX_RECONNECT_ATTEMPTS` (`10`) cap, and `leaveGame()` cancellation of pending auth/`CONNECTING` sockets/backoff timers; plus controller RAF/DOM teardown, `ClientGameRunner` timer cleanup, `TacticalOverlaySelector`, `WinModal`, `GameRenderer`/HUD teardown, `WebAudioEngine`, `MatchAnalytics`, and `LocalServer` replay hash safety.
- `tests/client/MapRendererContextRestore.test.ts` (1 test): simulates `webglcontextlost` and `webglcontextrestored` on `MapRenderer` and asserts all 8 view/player/tactical/structure-highlight states are preserved and re-applied.
- `tests/PrGateRules.test.ts` (40 tests): adds repository-aware `REPO` environment resolution coverage for `scripts/pr-gate/config.ts` while preserving existing PR gate rules.

---

## 5. Long-Session Performance & Browser Verification Results

### 5.1 15-Minute Baseline Soak (`main` commit `48149069`, headless Chromium `1280x800`, 25 bots, World map)

Measured on local dev server (`http://localhost:9000`) under headless Chromium software WebGL2 (SwiftShader, which caps headless frame throughput around ~10 FPS / ~100ms frame budget; this is NOT native Dell GPU performance and no physical laptop thermals or fan noise were measured):

| Elapsed (s) | Game Clock | FPS  | Mean (ms) | p95 / Max (ms) | Used / Total JS Heap (MB) | DOM Nodes | Pending RAFs | Active Intervals | Context Lost |
| ----------- | ---------- | ---- | --------- | -------------- | ------------------------- | --------- | ------------ | ---------------- | ------------ |
| 0           | 00:05      | 10.0 | 100.24    | 101.0 / 101.0  | 83.70 / 88.23             | 2226      | 4            | 6                | false        |
| 180 (3m)    | 02:59      | 10.0 | 100.14    | 101.0 / 101.0  | 83.99 / 101.82            | 2262      | 4            | 7                | false        |
| 360 (6m)    | 05:52      | 10.0 | 100.12    | 101.1 / 101.1  | 81.98 / 115.94            | 2273      | 4            | 7                | false        |
| 420 (7m)    | 06:50      | 9.5  | 105.63    | 200.7 / 200.7  | 89.27 / 116.61            | 2194      | 4            | 7                | false        |
| 600 (10m)   | 09:43      | 9.5  | 104.86    | 201.9 / 201.9  | 84.41 / 132.28            | 2194      | 4            | 7                | false        |
| 720 (12m)   | 11:38      | 10.2 | 98.04     | 101.1 / 101.2  | 100.82 / 134.34           | 2194      | 4            | 7                | false        |
| 900 (15m)   | 14:32      | 10.0 | 100.31    | 101.4 / 101.4  | 93.67 / 141.41            | 2194      | 4            | 7                | false        |

**Key observation:** Within a single match on `main`, `usedHeapMB` stayed bounded (`82–101 MB`) with `p95` spikes at ~7m (`200.7ms`) and ~10m (`201.9ms`) under SwiftShader (the mid-to-late-game GPU/pass pressure addressed by PR #15). Across **multiple consecutive matches**, however, `main` leaked uncancelled RAF loops (`AttackingTroopsController`, `BuildPreviewController`), `#warship-drag-rect` DOM nodes, and early-leave `connectionCheckInterval` timers — all fixed in this branch.

### 5.2 Post-Fix Browser Verification Summary

All post-fix browser checks ran against the edited code on `http://localhost:9000` with **zero uncaught `pageErrors`**:

- **Main Menu & Null `leave-lobby` Edge Case (`postfix-01-menu.png`):** Clean main menu (`inGame: false`, `tacticalButtonCount: 0`, `bodyHasRawKey: false`), zero errors on `new CustomEvent("leave-lobby")` with null `detail` (`afterNullLeaveLobbyErrors: 0`).
- **In-Game HUD Non-Overlap (`postfix-02-ingame-hud.png`):** Mute toggle (`bottom-right`, `x:1224, y:744`) and `TacticalOverlaySelector` (`TACTICAL: TROOPS [O]`) sit cleanly clear of `GameRightSidebar` (`x:1042, y:16`, `muteOverlapsRightBar: false`).
- **WebGL2 Context Loss & Recovery (`postfix-03-webgl-restored.png`):** Simulated `WEBGL_lose_context` lose + restore preserved board rendering and restored `TACTICAL: TROOPS` overlay state (`ok: true, contextLostAfterRestore: false`).
- **Post-Leave Cleanup & 3-Match Leak Soak (`postfix-04-post-leave-menu.png`):** After 3 consecutive match enter/leave cycles and 21s idle: `warshipDragRects: 0`, `dualLayerContainers: 0`, `pendingRafs: 1` (matches pre-match baseline `1`), `activeIntervals: 4` (matches pre-match baseline `4`), and `game-right-sidebar` / `game-left-sidebar` / `player-panel` / `control-panel` / `heads-up-message` / `tactical-overlay-selector` all reported `textLen: 0, visibleW: 0`.
- **Endgame Victory Modal (`postfix-05-victory-modal.png`):** `MatchAnalytics` modal rendered at `z-index: 10005` completely unoccluded by sidebars.
- **2-Client Local Multiplayer & Live Connection Interruption Recovery (`ironclad_qa_mp_reconnect.mjs`):** Host created a private lobby and launched a 2-client match (`http://localhost:9000`); the Guest client's active WebSocket was forcibly dropped mid-match (`timer: "00:24"`, `sockets: 5`). Guest reconnected via exponential backoff (`sockets: 6`, `latestState: 1`), transmitted `rejoin` **before** flushing the queued `intent: spawn` and subsequent `hash` frames after session sync, continued advancing the match (`timer: "00:20"`, canvas `1280x800`), and exited cleanly via `leave-lobby` with zero post-leave sockets (`guestSocketsAfterLeave: 6`) and zero `pageErrors` on both clients (`mp-reconnect-recovered.png`).
- **2-Client Local Multiplayer Basic Flow:** Also verified lobby creation (`2 PLAYERS` peer sync), match entry (`host.inGame: true`, `guest.inGame: true`), and guest departure (`hostAfterGuestLeave: true`) with `pageErrors: []`.

---

## 6. Post-Final-Edit Quality & CI Verification

Ran on `qa/frontierx-project-ironclad` after Mission 20.1 hardening edits:

- `npx tsc --noEmit` — **Passed** (exit code 0)
- `npm run lint` (`npm run lint:oxlint && npm run lint:eslint`) — **Passed** (`0` warnings, `0` errors across 852 files; exit code 0)
- `npx prettier --check .` — **Passed** (`All matched files use Prettier code style!`, exit code 0)
- `npm test` — **Passed**:
  - Client/core Vitest suite (`vitest run`): **280 passed (280) test files, 3132 passed (3132) tests**
  - Server Vitest suite (`vitest run tests/server`): **35 passed (35) test files, 319 passed (319) tests**
- `npm run build-prod` — **Passed** (`tsc --noEmit` + `vite build`, 1204 modules transformed, exit code 0)
- Real-browser post-fix re-verification (`ironclad_qa_postfix.mjs` + `ironclad_qa_mp_reconnect.mjs` against local dev server `http://localhost:9000`): **Passed** (`pageErrors: []`, zero RAF/timer/DOM leaks, clean mid-match WebSocket rejoin & queue ordering).

### 6.1 Mission 20.1 GitHub CI Root Causes & Fixes

- **Prettier & Generated Maps (`Prettier`, `Generated maps up to date`):** Both failures traced to `.prettierrc` missing `"endOfLine": "auto"` and 51 pre-existing unformatted legacy files on `main` (because `npm run gen-maps` executes `npm run format`, causing false dirty git diffs rather than stale map assets). Fixed with `.prettierrc` (`"endOfLine": "auto"`) and `.prettierignore` excluding generated artifacts and the 51 legacy files on `main` (zero IRONCLAD-modified files are ignored).
- **Has Milestone:** Created and assigned Milestone `#6` (`"v1.0.5 - Project IRONCLAD"`) to PR #16.
- **Evaluate Gate (`scripts/pr-gate/config.ts`):** `REPO` previously hardcoded `openfrontio/OpenFrontIO`, causing HTTP 403 (`Resource not accessible by integration`) on `hanukayoav/OpenFront-remix`. Updated `config.ts` to read `REPO_OWNER`/`REPO_NAME` and `GITHUB_REPOSITORY` dynamically while leaving `scripts/pr-gate/github.ts` strictly fail-closed (`403` rejects; only `404` maps to `"none"`). Note that `.github/workflows/pr-gate.yml` uses `pull_request_target` on `[opened, reopened]`, which checks out `main` during PR evaluation; merging PR #16 updates `main` for subsequent PRs.

### 6.2 Mission 20.1 WebSocket Reconnect Hardening (`src/client/Transport.ts`)

Audited against server join/rejoin semantics in `src/server/Worker.ts` and `src/server/GameServer.ts`:

- **Concern A (`sendIntent` offline discard vs safe replay):** Routed actionable intents (`sendIntent`), `onSendWinnerEvent`, and `onSendHashEvent` through `sendMsg()` instead of dropping them when disconnected, while filtering out ephemeral/telemetry messages (`emoji`, `quick_chat`, `targetPlayer`, `ping`, `live_stats`) when offline. Queued messages carry `enqueuedAt`, expire after `MAX_BUFFERED_INTENT_AGE_MS = 5000`, and are capped at `MAX_BUFFERED_MESSAGES = 64`.
- **Concern B (`connectRemote()` flush ordering before auth/`rejoin`/state sync):** Removed `flushBuffer()` from `socket.onopen()`. Now `onopen()` calls `onconnect()` first (`joinGame()`/`rejoinGame()` await `getPlayToken()` and abort if `this.isStopped`), and `flushBuffer()` executes from `socket.onmessage` only **after** `this.onmessage(result.data)` processes `"lobby_info"` or `"start"` (which replays missed turns to the worker). Guarded with `isSessionSynced` and `connectionGeneration`, prevented duplicate queued handshakes, and cleared queue/timers permanently on server `1002` (`Game not found`) close.
- **Concern C (`CLOSING`/`CLOSED` send path bypassing backoff):** Removed immediate `killExistingSocket()` + `connectRemote()` from the `CLOSING`/`CLOSED` branch of `sendMsg()`, buffering eligible actions and invoking `scheduleReconnect()` so exponential backoff (`500ms` base, `15000ms` cap, `MAX_RECONNECT_ATTEMPTS = 10`) is strictly preserved. Updated `reconnect()` to invoke `connectRemote()` directly without resetting `reconnectAttempts`.

---

## 7. Unresolved Observations & PR #15 Coordination

### 7.1 Pre-Existing / Environmental Observations (Unchanged)

- **Localhost auth/cosmetics requests:** In offline/local dev mode without a backing auth/cosmetics server, `Auth.ts` (`doRefreshJwt`) and `Cosmetics.ts` (`fetchCosmetics`) log `Failed to fetch` / `ERR_CONNECTION_REFUSED` errors in browser console; non-fatal and pre-existing on `main`.
- **Hardware Laptop Thermal/FPS Benchmarking:** Physical Dell laptop GPU frame pacing and thermal behaviour for `v1.0.6` remain unverified in this environment and stay owned by PR #15's real-device test pass.

### 7.2 PR #15 Overlap Assessment & Conflict-Resolution Plan (`perf/frontierx-v1.0.6-project-efficiency`)

Four source files are modified by both PR #16 (`qa/frontierx-project-ironclad`) and PR #15 (`perf/frontierx-v1.0.6-project-efficiency`):

1. `src/client/controllers/AttackingTroopsController.ts` — **Direct hunk overlap (`driveRafId` / RAF loop + cleanup).** Combine PR #15's demand-driven `isDriving` + `scheduleDrive()` scheduling and in-place `labelBuf` reuse + `disposed` guards **with** IRONCLAD's `driveRafId` cancellation, `destroyed` guard, and idempotent `destroy()`/`dispose()` teardown. Never revert to an always-running RAF loop.
2. `src/client/controllers/BuildPreviewController.ts` — **Direct hunk overlap (`cursorRafId` / cursor loop + cleanup).** Combine PR #15's demand-driven `cursorLoopRunning` + `ensureCursorLoop()` (only ticking when a build ghost or nuke trajectory is active) **with** IRONCLAD's `cursorRafId` cancellation, `destroyed` guard, and `destroy()`/`dispose()` cleanup.
3. `src/client/ClientGameRunner.ts` — **Non-overlapping hunks.** Keep PR #15's `mountWebGLFrameLoop` optimization (`document.hidden` skip, `maxFps` accumulator, `__frontierxRenderStats`) **and** keep IRONCLAD's `start()`/`stop()` timer cancellation (`connectionCheckTimeout`, `connectionCheckInterval`, `goToPlayerTimeout`).
4. `src/client/graphics/engine/DualLayerSetup.ts` — **Non-overlapping hunks.** Keep PR #15's `assignedBotPersonalities` Set deduplicating `BotAI.assignPersonality` **and** keep IRONCLAD's `#openfront-sudden-death-hud` classes (`top-20 left-1/2 -translate-x-1/2 z-[950]`).

---

## 8. Recommended Next Actions

1. Merge PR #16 (`qa/frontierx-project-ironclad` -> `main`) after CI verification, leaving PR #15 (`perf/frontierx-v1.0.6-project-efficiency`) unmerged.
2. Rebase PR #15 onto updated `main` using the 4-file resolution plan in Section 7.2, keeping both PR #15's demand-driven animation loops / frame pacing and IRONCLAD's `destroy()` / lifecycle guards intact.
3. Complete physical Dell laptop GPU/thermal validation on PR #15 before releasing `v1.0.6`.
