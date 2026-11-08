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
  DynamicUnitItem,
  StaticTerrainData,
} from "./DualLayerEngine";
import { InputManager } from "./InputManager";

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

  // 1. Observe container resize to update backing resolution and trigger static redraw
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
  }

  // 2. Optional integration with OpenFront GameView, TransformHandler, and EventBus
  const eventBus = options.eventBus;
  const gameView = options.gameView;
  const transformHandler = options.transformHandler;

  const eventDisposers: Array<() => void> = [];

  if (eventBus) {
    // Spawn beacon rings on movement orders without allocating objects
    const onMoveWarship = (e: { tile: number; unitIds: number[] }) => {
      if (!gameView) return;
      const x = gameView.x(e.tile);
      const y = gameView.y(e.tile);
      engine.spawnBeaconRing(x, y, "#38bdf8", 4, 30, 800, 2);
    };

    eventBus.on(MoveWarshipIntentEvent, onMoveWarship);

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

  // 3. Simulation Synchronization routine (called on tick / game updates)
  let lastSyncTimeMs = performance.now();

  const syncWithSimulation = (): void => {
    if (!gameView) return;
    const now = performance.now();
    const rawDeltaMs = Math.min(now - lastSyncTimeMs, 100);
    const deltaMs = rawDeltaMs * paceMultiplier;
    lastSyncTimeMs = now;

    // Register local player's capital avatar once spawned
    const myPlayer = gameView.myPlayer();
    if (
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
    }

    // Ensure bot personalities are initialized deterministically without flooding AvatarSystem
    const allPlayers = gameView.players();
    if (allPlayers && allPlayers.length > 0) {
      for (let i = 0; i < allPlayers.length; i++) {
        const p = allPlayers[i];
        if (!p || !p.isAlive()) continue;
        if (myPlayer && p.id() === myPlayer.id()) continue;
        BotAI.assignPersonality(p.id());
      }
    }

    // Sudden Death Limit evaluation
    if (mutators.suddenDeathTimer > 0 && !suddenDeathTriggered) {
      matchElapsedMs += deltaMs;
      if (matchElapsedMs >= mutators.suddenDeathTimer * 1000) {
        suddenDeathTriggered = true;
        let winner = myPlayer;
        let maxTiles = 0;
        if (allPlayers) {
          for (let i = 0; i < allPlayers.length; i++) {
            const p = allPlayers[i];
            if (p && p.isAlive() && p.numTilesOwned() > maxTiles) {
              maxTiles = p.numTilesOwned();
              winner = p;
            }
          }
        }
        if (winner) {
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
    }

    // Dynamic Progressive Supply Drops Evaluation
    engine.supplyDropManager.update(
      deltaMs,
      (tile) => {
        const owner = gameView.owner(tile);
        if (!owner || !owner.isPlayer()) return null;
        return {
          id: owner.smallID(),
          addGold: (g: number) => {
            if (owner.state) {
              owner.state.gold = (owner.state.gold ?? 0) + g;
            }
          },
          addTroops: (t: number) => {
            if (owner.state) {
              owner.state.troops = (owner.state.troops ?? 0) + t;
            }
          },
        };
      },
      () => {
        const mapW = gameView.width();
        const mapH = gameView.height();
        for (let attempt = 0; attempt < 25; attempt++) {
          const rx = Math.floor(Math.random() * (mapW - 20)) + 10;
          const ry = Math.floor(Math.random() * (mapH - 20)) + 10;
          if (gameView.isValidCoord(rx, ry)) {
            const tile = gameView.ref(rx, ry);
            if (!gameView.isWater(tile)) {
              return {
                tile,
                x: rx,
                y: ry,
                ownerID: gameView.ownerID(tile),
              };
            }
          }
        }
        return null;
      },
      (drop, claimingPlayerId) => {
        // Drop claimed: trigger 4-frame screen shake & player victory animation
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
      },
    );

    // Dynamic units sync and particle trails (capped at 120 particles across screen)
    const activeUnits: DynamicUnitItem[] = [];
    const unitsMap = gameView.units();
    if (unitsMap && Array.isArray(unitsMap)) {
      for (let i = 0; i < unitsMap.length; i++) {
        const u = unitsMap[i];
        if (!u.isActive()) continue;

        const ux = gameView.x(u.tile());
        const uy = gameView.y(u.tile());

        activeUnits.push({
          id: u.id(),
          x: ux,
          y: uy,
          troops: 0,
          color: u.owner()?.territoryColor()?.toHex() ?? "#ffffff",
          type: `${u.type()}`,
          isActive: true,
        });

        const isStructure = Structures.has(u.type());

        // Spawn trail particle behind moving units (capped at 120 particles by spawnTrailParticle)
        // Stationary structures (cities, factories, ports, defense posts, etc.) do not spawn motion trails
        if (!isStructure && Math.random() < 0.35) {
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
    }
    engine.setUnits(activeUnits);

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
    for (let i = 0; i < eventDisposers.length; i++) {
      eventDisposers[i]();
    }
    engine.destroy();
  };

  return {
    engine,
    inputManager,
    dispose,
    syncWithSimulation,
  };
}
