/**
 * OpenFront Dual-Layer Graphics Engine - Setup and Integration Facade
 *
 * Configures the dual-layer canvas system, initializes offscreen asset caches,
 * sets up preallocated object pools, and wires viewport observers.
 *
 * Guarantees zero side-effects to core match logic, pathfinding algorithms,
 * or WebSocket multiplayer networking.
 */

import { EventBus } from "../../../core/EventBus";
import { BotAI } from "../../../core/execution/utils/BotAI";
import { Structures } from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import {
  getDropIntervalSec,
  getMaxActiveDrops,
  getPaceMultiplier,
  loadMutators,
  MatchMutators,
} from "../../components/LobbySettings";
import { TransformHandler } from "../../TransformHandler";
import { MoveWarshipIntentEvent, SendAttackIntentEvent } from "../../Transport";
import { GameView } from "../../view/GameView";
import { loadAvatarConfig } from "./AvatarSystem";
import {
  DualLayerEngine,
  DualLayerEngineConfig,
  StaticTerrainData,
} from "./DualLayerEngine";
import { InputManager } from "./InputManager";
import {
  computeAvatarScale,
  deriveCountryAvatarConfig,
  TerritoryAnchorManager,
  TerritoryMapView,
} from "./TerritoryAnchor";

export interface DualLayerSetupOptions extends Partial<DualLayerEngineConfig> {
  gameView?: GameView;
  transformHandler?: TransformHandler;
  eventBus?: EventBus;
  autoStart?: boolean;
  mutators?: MatchMutators;
}

export interface DualLayerEngineHandle {
  engine: DualLayerEngine;
  inputManager: InputManager;
  dispose: () => void;
  syncWithSimulation: () => void;
}

/**
 * Main Setup Script for OpenFront Dual-Layer Engine.
 *
 * Mounts the stacked Static and Dynamic canvas elements into container,
 * prerenders offscreen visual stamps and sprites, preallocates object pools,
 * and sets up high-performance RAF render loop.
 */
export function setupDualLayerEngine(
  container: HTMLElement,
  options: DualLayerSetupOptions = {},
): DualLayerEngineHandle {
  const engine = new DualLayerEngine({
    container,
    width: options.width ?? container.clientWidth ?? window.innerWidth,
    height: options.height ?? container.clientHeight ?? window.innerHeight,
    maxDpr: options.maxDpr ?? 2.0,
  });

  if (typeof window !== "undefined") {
    (window as any).__dualLayerEngine = engine;
  }

  // 1. Observe container resize to update backing resolution and trigger static redraw
  const eventDisposers: Array<() => void> = [];
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const { width, height } = entries[i].contentRect;
        if (width > 0 && height > 0) {
          engine.resize(width, height);
        }
      }
    });
    resizeObserver.observe(container);
  } else if (typeof window !== "undefined") {
    const onWindowResize = () => {
      engine.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onWindowResize);
    eventDisposers.push(() =>
      window.removeEventListener("resize", onWindowResize),
    );
  }

  // 2. Optional integration with OpenFront GameView, TransformHandler, and EventBus
  const eventBus = options.eventBus;
  const gameView = options.gameView;
  const transformHandler = options.transformHandler;

  if (eventBus) {
    // Spawn beacon rings on movement orders without allocating objects
    const onMoveWarship = (e: { tile: number; unitIds: number[] }) => {
      if (!gameView) return;
      const x = gameView.x(e.tile);
      const y = gameView.y(e.tile);
      engine.spawnBeaconRing(x, y, "#38bdf8", 4, 30, 800, 2);
    };

    eventBus.on(MoveWarshipIntentEvent, onMoveWarship);
    eventDisposers.push(() =>
      eventBus.off(MoveWarshipIntentEvent, onMoveWarship),
    );

    // Attacking State: When launching troops, calculate angle to enemy node and point arm
    const onSendAttack = (e: SendAttackIntentEvent) => {
      if (!gameView) return;
      const myPlayer = gameView.myPlayer();
      if (!myPlayer) return;
      const capTile = myPlayer.state?.spawnTile;
      if (capTile === undefined || capTile === null) return;
      const cx = gameView.x(capTile);
      const cy = gameView.y(capTile);

      let targetX = cx + 10;
      let targetY = cy;
      if (e.targetTile !== null && e.targetTile !== undefined) {
        targetX = gameView.x(e.targetTile);
        targetY = gameView.y(e.targetTile);
      } else if (e.targetID !== null && e.targetID !== undefined) {
        const targetPlayer = gameView.player(e.targetID);
        if (
          targetPlayer?.state?.spawnTile !== undefined &&
          targetPlayer.state.spawnTile !== null
        ) {
          targetX = gameView.x(targetPlayer.state.spawnTile);
          targetY = gameView.y(targetPlayer.state.spawnTile);
        }
      }

      engine.avatarSystem.triggerAttack(myPlayer.id(), targetX, targetY, 1500);
      engine.audioEngine.playTroopLaunch();
    };

    eventBus.on(SendAttackIntentEvent, onSendAttack);
    eventDisposers.push(() =>
      eventBus.off(SendAttackIntentEvent, onSendAttack),
    );
  }

  // Late-phase orbital alert audio synthesizer trigger
  engine.onOrbitalSupplyDropAlert = () => {
    engine.audioEngine.playOrbitalAlert();
  };

  // Mount global procedural audio mute toggle button pinned to top UI
  if (typeof document !== "undefined") {
    engine.audioEngine.attachMuteButton(container);
  }

  // Mutator configurations from LobbySettings or options
  const mutators = options.mutators ?? loadMutators();
  const paceMultiplier = getPaceMultiplier(mutators.matchPace);
  engine.supplyDropManager.configure({
    intervalSec: getDropIntervalSec(mutators.dropFrequency),
    maxActiveCrates: getMaxActiveDrops(mutators.dropFrequency),
  });
  engine.supplyDropManager.authoritativeMode = Boolean(gameView);

  // Sudden Death HUD indicator if timer mutator is active (> 0)
  let suddenDeathHudEl: HTMLElement | null = null;
  if (mutators.suddenDeathTimer > 0 && typeof document !== "undefined") {
    suddenDeathHudEl = document.createElement("div");
    suddenDeathHudEl.id = "openfront-sudden-death-hud";
    suddenDeathHudEl.className =
      "fixed top-20 left-1/2 -translate-x-1/2 z-[950] px-3.5 py-1 bg-slate-900/85 backdrop-blur-md border border-amber-500/40 rounded-full text-amber-300 font-mono text-xs flex items-center gap-2 shadow-xl select-none pointer-events-none transition-all duration-300";
    const minutes = Math.floor(mutators.suddenDeathTimer / 60);
    const seconds = mutators.suddenDeathTimer % 60;
    const initialFormatted =
      String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    suddenDeathHudEl.innerHTML =
      '<span>⏱</span> <span class="font-bold tracking-wide uppercase text-[10px] text-white/70">Sudden Death:</span> <span id="openfront-sudden-death-timer-val" class="font-bold font-mono">' +
      initialFormatted +
      "</span>";
    document.body.appendChild(suddenDeathHudEl);
  }

  // Responsive touch and mobile control layer
  const inputManager = new InputManager({
    canvas: container,
    engine,
    transformHandler,
    gameView,
    eventBus,
    audioEngine: engine.audioEngine,
  });

  let matchElapsedMs = 0;
  let suddenDeathTriggered = false;
  const assignedBotPersonalities = new Set<string | number>();
  const fallbackAnchorManager = new TerritoryAnchorManager();
  let anchorScanCursor = 0;

  // Throttled trail particle counter to prevent CPU/GC spikes
  const MAX_TRAIL_PARTICLES_PER_TICK = 6;
  let trailParticlesSpawnedThisTick = 0;

  // 3. Simulation Synchronization routine (called on tick / game updates)
  let lastSyncTimeMs = performance.now();

  const syncWithSimulation = (): void => {
    if (!gameView) return;
    const now = performance.now();
    const rawDeltaMs = Math.min(now - lastSyncTimeMs, 100);
    const deltaMs = rawDeltaMs * paceMultiplier;
    lastSyncTimeMs = now;

    const myPlayer = gameView.myPlayer();
    const allPlayers = gameView.players();
    const simTick =
      typeof (gameView as any).ticks === "function"
        ? (gameView as any).ticks()
        : 0;
    const anchorMgr: TerritoryAnchorManager =
      typeof (gameView as any).territoryAnchorManager === "function"
        ? (gameView as any).territoryAnchorManager()
        : fallbackAnchorManager;
    const hasMapGeom =
      typeof (gameView as any).width === "function" &&
      typeof (gameView as any).height === "function" &&
      typeof (gameView as any).ref === "function" &&
      typeof (gameView as any).isLand === "function" &&
      typeof (gameView as any).ownerID === "function";

    // Sync territory-aware scaled avatars for both human and AI countries
    if (allPlayers && allPlayers.length > 0) {
      const playerCount = allPlayers.length;
      const budgetSlots = Math.min(playerCount, 12);
      const windowStart = anchorScanCursor % playerCount;
      anchorScanCursor =
        (anchorScanCursor + budgetSlots) % Math.max(1, playerCount);

      for (let i = 0; i < playerCount; i++) {
        const p = allPlayers[i];
        if (!p) continue;
        const pid = p.id();
        const isLocal = Boolean(myPlayer && pid === myPlayer.id());
        if (!isLocal && p.isAlive() && !assignedBotPersonalities.has(pid)) {
          assignedBotPersonalities.add(pid);
          BotAI.assignPersonality(pid);
        }

        const tilesOwned =
          typeof (p as any).numTilesOwned === "function"
            ? (p as any).numTilesOwned()
            : 0;
        const spawnTile = p.state?.spawnTile;
        if (
          !p.isAlive() ||
          (tilesOwned <= 0 && (spawnTile === undefined || spawnTile === null))
        ) {
          engine.avatarSystem.removeAvatar(pid);
          if (typeof (p as any).smallID === "function") {
            anchorMgr.removePlayer((p as any).smallID());
          }
          continue;
        }
        if (spawnTile === undefined || spawnTile === null) continue;

        let avatar = engine.avatarSystem.getAvatar(pid);
        if (!avatar) {
          const sx = gameView.x(spawnTile);
          const sy = gameView.y(spawnTile);
          const hex =
            typeof (p as any).territoryColor === "function"
              ? (p as any).territoryColor().toHex()
              : "#3b82f6";
          const config = isLocal
            ? loadAvatarConfig()
            : deriveCountryAvatarConfig(String(pid), hex);
          avatar = engine.avatarSystem.registerAvatar(
            pid,
            p.smallID(),
            sx,
            sy,
            config,
            isLocal,
          );
        }

        const targetScale = computeAvatarScale(tilesOwned);
        if (hasMapGeom) {
          const offset = (i - windowStart + playerCount) % playerCount;
          const allowNonUrgent = offset < budgetSlots || isLocal;
          const resolved = anchorMgr.resolveAnchor(
            gameView as unknown as TerritoryMapView,
            p.smallID(),
            tilesOwned,
            spawnTile,
            simTick,
            allowNonUrgent,
          );
          if (resolved) {
            engine.avatarSystem.setTerritoryState(
              pid,
              resolved.x,
              resolved.y,
              targetScale,
              resolved.urgentSnap,
            );
          }
        } else {
          engine.avatarSystem.setTerritoryState(
            pid,
            avatar.capitalX,
            avatar.capitalY,
            targetScale,
            false,
          );
        }
      }
    } else if (
      myPlayer &&
      myPlayer.state?.spawnTile !== undefined &&
      myPlayer.state?.spawnTile !== null
    ) {
      const capTile = myPlayer.state.spawnTile;
      const cx = gameView.x(capTile);
      const cy = gameView.y(capTile);
      if (!engine.avatarSystem.getAvatar(myPlayer.id())) {
        engine.avatarSystem.registerAvatar(
          myPlayer.id(),
          myPlayer.smallID(),
          cx,
          cy,
          loadAvatarConfig(),
          true,
        );
      }
      const tilesOwned =
        typeof (myPlayer as any).numTilesOwned === "function"
          ? (myPlayer as any).numTilesOwned()
          : 0;
      engine.avatarSystem.setTerritoryState(
        myPlayer.id(),
        cx,
        cy,
        computeAvatarScale(tilesOwned),
        false,
      );
    }

    // Sudden Death Limit evaluation - only during active gameplay, never during spawn phase
    if (
      mutators.suddenDeathTimer > 0 &&
      !suddenDeathTriggered &&
      !gameView.inSpawnPhase()
    ) {
      matchElapsedMs += rawDeltaMs * (mutators.matchPace || 1.0);
      const totalSec = mutators.suddenDeathTimer;
      const remainingSec = Math.max(
        0,
        Math.ceil(totalSec - matchElapsedMs / 1000),
      );

      if (suddenDeathHudEl) {
        const timerValEl = suddenDeathHudEl.querySelector(
          "#openfront-sudden-death-timer-val",
        );
        if (timerValEl) {
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          timerValEl.textContent =
            String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
        }
        if (remainingSec <= 30) {
          suddenDeathHudEl.className =
            "fixed top-20 left-1/2 -translate-x-1/2 z-[950] px-3.5 py-1 bg-rose-950/90 backdrop-blur-md border border-rose-500/80 rounded-full text-rose-300 font-mono text-xs flex items-center gap-2 shadow-[0_0_15px_rgba(244,63,94,0.4)] select-none pointer-events-none animate-pulse transition-all duration-300";
        }
      }

      if (remainingSec === 0) {
        suddenDeathTriggered = true;
        let winner = null as ReturnType<GameView["players"]>[0] | null;
        let maxTiles = 0;
        if (allPlayers && allPlayers.length > 0) {
          for (let i = 0; i < allPlayers.length; i++) {
            const p = allPlayers[i];
            if (p && p.isAlive() && p.numTilesOwned() > maxTiles) {
              maxTiles = p.numTilesOwned();
              winner = p;
            }
          }
        }
        // Only declare victory if a legitimate player owns territory
        if (winner && maxTiles > 0) {
          engine.analytics.showVictoryModal({
            winnerName: winner.displayName(),
            winnerColor: winner.territoryColor()?.toHex() ?? "#3b82f6",
            winnerId: winner.id(),
            victoryType: "Timeout",
            avatarConfig: engine.avatarSystem.getConfig(),
          });
          engine.avatarSystem.triggerVictory(winner.id(), 10000);
          engine.audioEngine.playDropClaim();
        }
      }
    }

    // Camera synchronization from TransformHandler (when running standalone without an external frame loop)
    if (transformHandler && options.autoStart !== false) {
      const centerX = transformHandler.offsetX + gameView.width() / 2;
      const centerY = transformHandler.offsetY + gameView.height() / 2;
      engine.setCamera(centerX, centerY, transformHandler.scale);
    }

    // Check if territory boundaries permanently shifted
    const updates = gameView.updatesSinceLastTick();
    if (updates) {
      // Territory shift detection: any captured tiles or conquest events
      const hasConquest =
        (updates[GameUpdateType.ConquestEvent]?.length ?? 0) > 0 ||
        (updates[GameUpdateType.Tile]?.length ?? 0) > 0;

      if (hasConquest) {
        engine.markStaticDirty();
      }

      // Check capital capture for victory celebration & screen shake
      const conquests = updates[GameUpdateType.ConquestEvent];
      if (conquests && conquests.length > 0) {
        for (let i = 0; i < conquests.length; i++) {
          const c = conquests[i];
          if (myPlayer && c.conquerorId === myPlayer.id()) {
            engine.avatarSystem.triggerVictory(myPlayer.id(), 2500);
            engine.audioEngine.playExplosionShake();
          }
        }
      }

      // Check match victory/expiration condition to launch post-match analytics modal
      const winUpdates = updates[GameUpdateType.Win];
      if (winUpdates && winUpdates.length > 0) {
        const wu = winUpdates[0];
        let winnerName = "Victor";
        let winnerColor = "#3b82f6";
        let winnerId: number | string = 1;
        const victoryType: "Domination" | "Timeout" = "Domination";

        if (wu.winner) {
          if (wu.winner[0] === "team") {
            winnerName = `Team ${wu.winner[1]}`;
          } else {
            const wp = gameView.playerByClientID(wu.winner[1]);
            if (wp?.isPlayer()) {
              winnerName = wp.displayName();
              winnerColor = wp.territoryColor()?.toHex() ?? "#3b82f6";
              winnerId = wp.id();
            }
          }
        }

        engine.analytics.showVictoryModal({
          winnerName,
          winnerColor,
          winnerId,
          victoryType,
          avatarConfig: engine.avatarSystem.getConfig(),
        });
        engine.avatarSystem.triggerVictory(winnerId, 10000);
        engine.audioEngine.playDropClaim();
      }

      // Bonus / Loot text spawning
      const bonuses = updates[GameUpdateType.BonusEvent];
      if (bonuses && bonuses.length > 0) {
        for (let i = 0; i < bonuses.length; i++) {
          const b = bonuses[i];
          const x = gameView.x(b.tile);
          const y = gameView.y(b.tile);
          if (b.gold !== 0) {
            const prefix = b.gold > 0 ? "+" : "";
            engine.spawnFloatingText(
              `${prefix}${b.gold} Gold`,
              x,
              y,
              "loot",
              "#facc15",
              1000,
            );
          }
          if (b.troops !== 0) {
            const prefix = b.troops > 0 ? "+" : "";
            engine.spawnFloatingText(
              `${prefix}${b.troops} Troops`,
              x,
              y - 6,
              "combat",
              "#60a5fa",
              1000,
            );
          }
        }
      }
      // Authoritative Simulation Supply Drop Spawns & Claims
      const supplyDropEvents = updates[GameUpdateType.SupplyDropEvent];
      if (supplyDropEvents && supplyDropEvents.length > 0) {
        const onAuthoritativeClaimFX = (
          _drop: unknown,
          claimingPlayerId: number,
        ) => {
          engine.avatarSystem.screenShake.trigger(4);
          engine.audioEngine.playExplosionShake();
          engine.audioEngine.playDropClaim();

          const claimer = gameView.playerBySmallID
            ? gameView.playerBySmallID(claimingPlayerId)
            : null;
          let claimerName = `Player ${claimingPlayerId}`;
          let claimerColor = "#3b82f6";
          if (claimer && "isPlayer" in claimer && claimer.isPlayer()) {
            claimerName = claimer.displayName();
            claimerColor = claimer.territoryColor()?.toHex() ?? "#3b82f6";
          }
          engine.analytics.recordCrateSecured(
            claimingPlayerId,
            claimerName,
            claimerColor,
          );

          if (myPlayer && claimingPlayerId === myPlayer.smallID()) {
            engine.avatarSystem.triggerVictory(myPlayer.id(), 2500);
          }
        };

        for (let i = 0; i < supplyDropEvents.length; i++) {
          const ev = supplyDropEvents[i];
          const sx = gameView.x(ev.tile);
          const sy = gameView.y(ev.tile);
          if (ev.action === "spawn") {
            engine.supplyDropManager.applyAuthoritativeSpawn(
              ev.dropId,
              ev.tile,
              sx,
              sy,
              ev.troops,
              ev.gold,
              ev.tier,
              ev.playerSmallId ?? null,
            );
          } else if (ev.action === "claim") {
            engine.supplyDropManager.applyAuthoritativeClaim(
              ev.dropId,
              ev.tile,
              sx,
              sy,
              ev.troops,
              ev.gold,
              ev.tier,
              ev.playerSmallId ?? 0,
              onAuthoritativeClaimFX,
            );
          }
        }
      }
    }

    // Dynamic Progressive Supply Drops Animation & Beacon/Banner Tick
    // Note: in live matches authoritativeMode=true ensures spawning and reward
    // grants run deterministically in simulation across all peers.
    engine.supplyDropManager.update(deltaMs);

    // Particle trails for active moving units (throttled and early-exit to avoid per-unit toHex/GC churn)
    trailParticlesSpawnedThisTick = 0;
    const unitsMap = gameView.units();
    if (unitsMap && Array.isArray(unitsMap)) {
      for (let i = 0; i < unitsMap.length; i++) {
        if (trailParticlesSpawnedThisTick >= MAX_TRAIL_PARTICLES_PER_TICK) {
          break;
        }
        const u = unitsMap[i];
        if (!u.isActive() || Structures.has(u.type())) continue;
        if (Math.random() >= 0.2) continue;

        trailParticlesSpawnedThisTick++;
        const ux = gameView.x(u.tile());
        const uy = gameView.y(u.tile());
        engine.spawnTrailParticle(
          ux,
          uy,
          (Math.random() - 0.5) * 3,
          (Math.random() - 0.5) * 3,
          u.owner()?.territoryColor()?.toHex() ?? "#94a3b8",
          2,
          500,
        );
      }
    }

    // Sample territory percentages and troop totals every 5 seconds into ring buffer
    engine.analytics.update(deltaMs, () => {
      const players = gameView.players();
      if (!players || players.length === 0) return null;

      const totalTiles = gameView.width() * gameView.height();
      const snapshots = [];

      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || !p.isPlayer() || !p.isAlive()) continue;

        const tileCount = p.numTilesOwned();
        const territoryPercent =
          totalTiles > 0 ? (tileCount / totalTiles) * 100 : 0;
        const troops = p.troops();

        snapshots.push({
          playerId: p.id(),
          name: p.displayName(),
          color: p.territoryColor()?.toHex() ?? "#3b82f6",
          territoryPercent,
          troops,
        });
      }

      return {
        timeSec: Math.floor(now / 1000),
        players: snapshots,
      };
    });
  };

  // 4. Populate default static terrain if GameView is available
  if (gameView) {
    const terrain: StaticTerrainData = {
      width: gameView.width(),
      height: gameView.height(),
      backgroundColor: "transparent",
      landColor: "#1b4d3e",
      waterColor: "transparent",
      neutralStrokeColor: "#334155",
      landPolygons: [],
      neutralBoundaries: [],
    };
    engine.setStaticTerrain(terrain);
  }

  // Auto-start loop unless explicitly requested otherwise
  if (options.autoStart !== false) {
    engine.start();
  }

  const dispose = (): void => {
    inputManager.dispose();
    BotAI.clear();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (suddenDeathHudEl) {
      suddenDeathHudEl.remove();
      suddenDeathHudEl = null;
    }
    for (let i = 0; i < eventDisposers.length; i++) {
      eventDisposers[i]();
    }
    engine.destroy();
    if (
      typeof window !== "undefined" &&
      (window as { __dualLayerEngine?: DualLayerEngine }).__dualLayerEngine ===
        engine
    ) {
      delete (window as { __dualLayerEngine?: DualLayerEngine })
        .__dualLayerEngine;
    }
  };

  return {
    engine,
    inputManager,
    dispose,
    syncWithSimulation,
  };
}
