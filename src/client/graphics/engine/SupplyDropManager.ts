/**
 * OpenFront Dynamic Progressive Supply Drops System
 *
 * Implements timed supply drops scaling with match progression:
 * - Early Phase (0 - 120s): 8k - 12k troops, 80k - 120k gold, Electric Blue crate (#3b82f6)
 * - Mid Phase (120 - 300s): 45k - 55k troops, 900k - 1.1M gold, Vibrant Purple crate (#a855f7)
 * - Late Phase (300s+): 100k - 150k troops, 10M - 20M gold, Radiant Gold crate (#f59e0b)
 *
 * Features:
 * - Animated 4-phase delivery: Arrival flyby -> Parachute descent -> Dust puff landing -> Idle collection
 * - Smaller, properly scaled vector crates (~20px) that do not clutter territories
 * - Direct click/touch to claim with accurate hit testing & tile owner verification
 * - Hover indicators with real-time reward tooltip preview
 * - Pulsing beacon rings pulled from VisualFx ObjectPool
 * - Instant award to node troops and player gold upon capture, with floating text over 1.5s
 */

import { SupplyCrateType } from "./AssetCache";
import { DualLayerEngine, SupplyCrateItem, SupplyDropAnimState } from "./DualLayerEngine";
import { VisualFxPools } from "./ObjectPool";

export interface ActiveSupplyDrop extends SupplyCrateItem {
  tile: number;
  troops: number;
  gold: number;
  initialOwnerID: number | null;
  tier: "early" | "mid" | "late";
  phase: "early" | "mid" | "late";
  spawnTimeMs: number;
  beaconTimerMs: number;
  state: SupplyDropAnimState;
  stateTimerMs: number;
  descentDurationMs: number;
  altitude: number;
  swayAngle: number;
  visualX: number;
  visualY: number;
  planeProgress: number;
  isHovered: boolean;
}

export interface SupplyDropBanner {
  text: string;
  subtext?: string;
  alpha: number;
  durationMs: number;
  elapsedMs: number;
}

export class SupplyDropManager {
  public static readonly EVALUATION_INTERVAL_SEC = 45;
  public static readonly MAX_ACTIVE_CRATES = 2;
  public static readonly DESCENT_DURATION_MS = 3000;
  public static readonly CLAIM_RADIUS_TILES = 3.5;

  private readonly activeDrops = new Map<string | number, ActiveSupplyDrop>();
  private matchTimeMs = 0;
  private nextEvaluationMs = 45000;
  private evaluationIntervalSec = SupplyDropManager.EVALUATION_INTERVAL_SEC;
  private maxActiveCrates = SupplyDropManager.MAX_ACTIVE_CRATES;
  private currentBanner: SupplyDropBanner | null = null;
  private hoveredDropId: string | number | null = null;

  constructor(
    private readonly engine: DualLayerEngine,
    private readonly pools: VisualFxPools,
  ) {}

  public configure(options: { intervalSec?: number; maxActiveCrates?: number }): void {
    if (options.intervalSec !== undefined && options.intervalSec > 0) {
      this.evaluationIntervalSec = options.intervalSec;
      this.nextEvaluationMs = this.matchTimeMs + this.evaluationIntervalSec * 1000;
    }
    if (options.maxActiveCrates !== undefined && options.maxActiveCrates > 0) {
      this.maxActiveCrates = options.maxActiveCrates;
    }
  }

  public getEvaluationIntervalSec(): number {
    return this.evaluationIntervalSec;
  }

  public getMaxActiveCrates(): number {
    return this.maxActiveCrates;
  }

  public getActiveDrops(): readonly ActiveSupplyDrop[] {
    return Array.from(this.activeDrops.values());
  }

  public getActiveBanner(): SupplyDropBanner | null {
    return this.currentBanner;
  }

  /**
   * Clear active supply drops from the board.
   */
  public clear(): void {
    this.activeDrops.clear();
    this.hoveredDropId = null;
    this.syncCratesWithEngine();
  }

  /**
   * Reset match progression timer and clear all drops.
   */
  public reset(): void {
    this.clear();
    this.matchTimeMs = 0;
    this.nextEvaluationMs = this.evaluationIntervalSec * 1000;
    this.currentBanner = null;
  }

  /**
   * Update match progression, evaluate spawn schedule, pulse beacons, and update descent animations.
   */
  public update(
    deltaMs: number,
    getOwnerAtTile?: (tile: number) => { id: number; addGold?: (g: number) => void; addTroops?: (t: number) => void } | null,
    pickEligibleTile?: () => { tile: number; x: number; y: number; ownerID: number | null } | null,
    onDropClaimed?: (drop: ActiveSupplyDrop, claimingPlayerId: number) => void,
  ): void {
    this.matchTimeMs += deltaMs;

    // 1. Check if evaluation trigger is reached
    if (this.matchTimeMs >= this.nextEvaluationMs) {
      this.nextEvaluationMs += this.evaluationIntervalSec * 1000;

      if (this.activeDrops.size < this.maxActiveCrates && pickEligibleTile) {
        const candidate = pickEligibleTile();
        if (candidate) {
          this.spawnSupplyDrop(candidate.tile, candidate.x, candidate.y, candidate.ownerID);
        }
      }
    }

    // 2. Update drop animation states and beacon rings
    let syncNeeded = false;
    for (const drop of this.activeDrops.values()) {
      if (drop.state === "descending") {
        drop.stateTimerMs += deltaMs;
        const progress = Math.min(1.0, drop.stateTimerMs / drop.descentDurationMs);
        drop.altitude = Math.max(0, 1.0 - Math.pow(progress, 1.35));
        drop.swayAngle = Math.sin(drop.stateTimerMs * 0.005) * 0.16;
        drop.visualX = drop.x + Math.sin(drop.stateTimerMs * 0.005) * (drop.altitude * 4);
        drop.visualY = drop.y - drop.altitude * 60;
        drop.planeProgress = Math.min(1.0, drop.stateTimerMs / 1200);

        if (progress >= 1.0) {
          drop.state = "landing";
          drop.stateTimerMs = 0;
          drop.altitude = 0;
          drop.visualX = drop.x;
          drop.visualY = drop.y;

          // Landing impact fx: dust shockwave and ripple ring
          this.pools.spawnBeaconRing(drop.x, drop.y, "#94a3b8", 2, 14, 450, 1.5);
          let ringColor = "#3b82f6";
          if (drop.tier === "mid") ringColor = "#a855f7";
          if (drop.tier === "late") ringColor = "#f59e0b";
          this.pools.spawnBeaconRing(drop.x, drop.y, ringColor, 4, 20, 600, 2);
          this.engine.audioEngine?.playDropClaim?.();
        }
        syncNeeded = true;
      } else if (drop.state === "landing") {
        drop.stateTimerMs += deltaMs;
        if (drop.stateTimerMs >= 300) {
          drop.state = "idle";
          drop.stateTimerMs = 0;
          syncNeeded = true;
        }
      } else if (drop.state === "idle") {
        drop.beaconTimerMs += deltaMs;
        if (drop.beaconTimerMs >= 1500) {
          drop.beaconTimerMs = 0;
          let ringColor = "#3b82f6";
          if (drop.tier === "mid") ringColor = "#a855f7";
          if (drop.tier === "late") ringColor = "#f59e0b";

          this.pools.spawnBeaconRing(drop.x, drop.y, ringColor, 6, 28, 1200, 1.8);
        }
      }

      // Auto-claim on territorial conquest (evaluated in any active state)
      if (getOwnerAtTile && drop.state !== "collected") {
        const currentOwner = getOwnerAtTile(drop.tile);
        if (currentOwner !== null && currentOwner.id !== drop.initialOwnerID) {
          this.claimDrop(drop, currentOwner, onDropClaimed);
        }
      }
    }

    if (syncNeeded) {
      this.syncCratesWithEngine();
    }

    // 4. Update banner animation
    if (this.currentBanner) {
      this.currentBanner.elapsedMs += deltaMs;
      if (this.currentBanner.elapsedMs >= this.currentBanner.durationMs) {
        this.currentBanner = null;
      } else {
        const progress = this.currentBanner.elapsedMs / this.currentBanner.durationMs;
        if (progress > 0.8) {
          this.currentBanner.alpha = Math.max(0, (1 - progress) / 0.2);
        } else {
          this.currentBanner.alpha = Math.min(1, this.currentBanner.elapsedMs / 300);
        }
      }
    }
  }

  /**
   * Spawn a new progressive supply drop with falling parachute animation.
   */
  public spawnSupplyDrop(
    tile: number,
    x: number,
    y: number,
    initialOwnerID: number | null = null,
  ): ActiveSupplyDrop {
    const elapsedSec = this.matchTimeMs / 1000;
    let tier: "early" | "mid" | "late";
    let crateType: SupplyCrateType;
    let troops: number;
    let gold: number;
    let ringColor: string;

    if (elapsedSec < 120) {
      // Early Phase: 8k - 12k troops, 80k - 120k gold
      tier = "early";
      crateType = "early";
      troops = Math.floor(8000 + Math.random() * 4000);
      gold = Math.floor(80000 + Math.random() * 40000);
      ringColor = "#3b82f6";
    } else if (elapsedSec < 300) {
      // Mid Phase: 45k - 55k troops, 900k - 1.1M gold
      tier = "mid";
      crateType = "mid";
      troops = Math.floor(45000 + Math.random() * 10000);
      gold = Math.floor(900000 + Math.random() * 200000);
      ringColor = "#a855f7";
    } else {
      // Late Phase: 100k - 150k troops, 10M - 20M gold
      tier = "late";
      crateType = "late";
      troops = Math.floor(100000 + Math.random() * 50000);
      gold = Math.floor(10000000 + Math.random() * 10000000);
      ringColor = "#f59e0b";

      this.triggerOrbitalAlert();
      this.engine.onOrbitalSupplyDropAlert?.();
    }

    const dropId = `drop_${tile}_${Date.now()}`;
    const drop: ActiveSupplyDrop = {
      id: dropId,
      tile,
      x,
      y,
      troops,
      gold,
      tier,
      phase: tier,
      type: crateType,
      initialOwnerID,
      spawnTimeMs: this.matchTimeMs,
      beaconTimerMs: 0,
      collected: false,
      state: "descending",
      stateTimerMs: 0,
      descentDurationMs: SupplyDropManager.DESCENT_DURATION_MS,
      altitude: 1.0,
      swayAngle: 0,
      visualX: x,
      visualY: y - 60,
      planeProgress: 0,
      isHovered: false,
    };

    this.activeDrops.set(dropId, drop);
    this.syncCratesWithEngine();

    // Initial subtle arrival ripple
    this.pools.spawnBeaconRing(x, y, ringColor, 4, 24, 1000, 1.5);

    return drop;
  }

  /**
   * Updates hovering drop state for tooltips and reticles.
   */
  public setHoverCoord(worldX: number, worldY: number): boolean {
    let hovered: ActiveSupplyDrop | null = null;
    let minDist = SupplyDropManager.CLAIM_RADIUS_TILES;

    for (const drop of this.activeDrops.values()) {
      if (drop.collected) continue;
      const d = Math.hypot(drop.x - worldX, drop.y - worldY);
      if (d <= minDist) {
        minDist = d;
        hovered = drop;
      }
    }

    const nextHoveredId = hovered ? hovered.id : null;
    if (this.hoveredDropId !== nextHoveredId) {
      this.hoveredDropId = nextHoveredId;
      for (const drop of this.activeDrops.values()) {
        drop.isHovered = drop.id === this.hoveredDropId;
      }
      this.syncCratesWithEngine();
      return true;
    }
    return false;
  }

  /**
   * Attempts to claim an active supply drop under cursor/tap.
   */
  public tryClaimAt(
    worldX: number,
    worldY: number,
    claimingPlayer: { id: () => number | string; smallID: () => number; addGold?: (g: number) => void; addTroops?: (t: number) => void; isPlayer?: () => boolean } | null,
    getOwnerAtTile?: (tile: number) => number | null,
    onDropClaimed?: (drop: ActiveSupplyDrop, claimingPlayerId: number) => void,
  ): { handled: boolean; success: boolean; message?: string } {
    let targetDrop: ActiveSupplyDrop | null = null;
    let minDist = SupplyDropManager.CLAIM_RADIUS_TILES;

    for (const drop of this.activeDrops.values()) {
      if (drop.collected) continue;
      const d = Math.hypot(drop.x - worldX, drop.y - worldY);
      if (d <= minDist) {
        minDist = d;
        targetDrop = drop;
      }
    }

    if (!targetDrop) {
      return { handled: false, success: false };
    }

    // Drop was clicked! Handle click event:
    if (targetDrop.state === "descending") {
      return {
        handled: true,
        success: false,
        message: "Supply drop incoming... Wait for landing!",
      };
    }

    if (!claimingPlayer) {
      return { handled: true, success: false };
    }

    const mySmallId = claimingPlayer.smallID();
    const tileOwnerId = getOwnerAtTile ? getOwnerAtTile(targetDrop.tile) : null;

    // Check ownership eligibility: if tile is controlled by an enemy, cannot claim remotely
    if (tileOwnerId !== null && tileOwnerId !== mySmallId) {
      return {
        handled: true,
        success: false,
        message: "Cannot claim: in enemy territory! Conquer tile first.",
      };
    }

    // Eligible! Execute claim:
    this.claimDrop(
      targetDrop,
      {
        id: mySmallId,
        addGold: claimingPlayer.addGold ? (g) => claimingPlayer.addGold!(g) : undefined,
        addTroops: claimingPlayer.addTroops ? (t) => claimingPlayer.addTroops!(t) : undefined,
      },
      onDropClaimed,
    );

    const fTroops =
      targetDrop.troops >= 1000000
        ? `${(targetDrop.troops / 1000000).toFixed(1)}M`
        : `${Math.round(targetDrop.troops / 1000)}k`;
    const fGold =
      targetDrop.gold >= 1000000
        ? `${(targetDrop.gold / 1000000).toFixed(1)}M`
        : `${Math.round(targetDrop.gold / 1000)}k`;

    return {
      handled: true,
      success: true,
      message: `+${fTroops} Troops  +${fGold} Gold`,
    };
  }

  /**
   * Triggers the top screen banner for Late Phase orbital supply drops.
   */
  public triggerOrbitalAlert(): void {
    this.currentBanner = {
      text: "ORBITAL SUPPLY DROP DETECTED",
      subtext: "High-value crate deployed to battlefield",
      alpha: 1,
      durationMs: 4000,
      elapsedMs: 0,
    };
  }

  /**
   * Handles claiming a drop when clicked or captured.
   */
  public claimDrop(
    drop: ActiveSupplyDrop,
    claimingOwner: { id: number; addGold?: (g: number) => void; addTroops?: (t: number) => void },
    onDropClaimed?: (drop: ActiveSupplyDrop, claimingPlayerId: number) => void,
  ): void {
    // 1. Award resources
    if (claimingOwner.addGold) {
      claimingOwner.addGold(drop.gold);
    }
    if (claimingOwner.addTroops) {
      claimingOwner.addTroops(drop.troops);
    }

    // 2. Animate troop and gold gains rising and fading over 1.5 seconds from ObjectPool
    const formattedTroops =
      drop.troops >= 1000000
        ? `${(drop.troops / 1000000).toFixed(1)}M`
        : `${Math.round(drop.troops / 1000)}k`;
    const formattedGold =
      drop.gold >= 1000000
        ? `${(drop.gold / 1000000).toFixed(1)}M`
        : `${Math.round(drop.gold / 1000)}k`;

    this.pools.spawnFloatingText(`+${formattedTroops} Troops`, drop.x, drop.y - 12, "combat", "#60a5fa", 1500, 24, 13);
    this.pools.spawnFloatingText(`+${formattedGold} Gold`, drop.x, drop.y, "loot", "#facc15", 1500, 24, 13);

    // 3. Shockwave & audio feedback
    this.pools.spawnBeaconRing(drop.x, drop.y, "#facc15", 3, 20, 500, 2);
    this.engine.audioEngine?.playDropClaim?.();

    // 4. Remove from active drops
    this.activeDrops.delete(drop.id);
    if (this.hoveredDropId === drop.id) {
      this.hoveredDropId = null;
    }
    this.syncCratesWithEngine();

    // 5. Trigger callback for screen shake and victory animation
    if (onDropClaimed) {
      onDropClaimed(drop, claimingOwner.id);
    } else {
      this.engine.avatarSystem.screenShake.trigger(4);
      const localAvatar = this.engine.avatarSystem.getLocalAvatar();
      if (localAvatar) {
        this.engine.avatarSystem.triggerVictory(localAvatar.id, 2000);
      }
    }
  }

  private syncCratesWithEngine(): void {
    const list: SupplyCrateItem[] = [];
    for (const drop of this.activeDrops.values()) {
      list.push({
        id: drop.id,
        x: drop.x,
        y: drop.y,
        type: drop.type,
        state: drop.state,
        altitude: drop.altitude,
        swayAngle: drop.swayAngle,
        visualX: drop.visualX,
        visualY: drop.visualY,
        planeProgress: drop.planeProgress,
        tier: drop.tier,
        troops: drop.troops,
        gold: drop.gold,
        isHovered: drop.isHovered,
      });
    }
    this.engine.setSupplyCrates(list);
  }
}
