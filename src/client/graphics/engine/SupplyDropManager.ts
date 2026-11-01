/**
 * OpenFront Dynamic Progressive Supply Drops System
 *
 * Implements timed supply drops scaling with match progression:
 * - Early Phase (0 - 120s): 8k - 12k troops, 80k - 120k gold, Electric Blue crate (#3b82f6)
 * - Mid Phase (120 - 300s): 45k - 55k troops, 900k - 1.1M gold, Vibrant Purple crate (#a855f7)
 * - Late Phase (300s+): 100k - 150k troops, 10M - 20M gold, Radiant Gold crate (#f59e0b)
 *
 * Features:
 * - 45s evaluation cycle, capped at 2 active crates.
 * - Pulsing beacon rings pulled from ObjectPool.
 * - Top-screen warning banner for Late Phase orbital drops.
 * - Instant award to node troops and player gold upon capture, with floating text over 1.5s.
 */

import { SupplyCrateType } from "./AssetCache";
import { DualLayerEngine, SupplyCrateItem } from "./DualLayerEngine";
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

  private readonly activeDrops = new Map<string | number, ActiveSupplyDrop>();
  private matchTimeMs = 0;
  private nextEvaluationMs = 45000;
  private evaluationIntervalSec = SupplyDropManager.EVALUATION_INTERVAL_SEC;
  private maxActiveCrates = SupplyDropManager.MAX_ACTIVE_CRATES;
  private currentBanner: SupplyDropBanner | null = null;

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
   * Update match progression, evaluate spawn schedule, pulse beacons, and update banners.
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

    // 2. Pulse beacon rings at active crate locations
    for (const drop of this.activeDrops.values()) {
      drop.beaconTimerMs += deltaMs;
      if (drop.beaconTimerMs >= 1000) {
        drop.beaconTimerMs = 0;
        let ringColor = "#3b82f6";
        if (drop.tier === "mid") ringColor = "#a855f7";
        if (drop.tier === "late") ringColor = "#f59e0b";

        this.pools.spawnBeaconRing(drop.x, drop.y, ringColor, 6, 36, 1200, 2);
      }

      // 3. Claim evaluation: Check if tile was captured by an active player
      if (getOwnerAtTile) {
        const currentOwner = getOwnerAtTile(drop.tile);
        if (currentOwner !== null && currentOwner.id !== drop.initialOwnerID) {
          this.claimDrop(drop, currentOwner, onDropClaimed);
        }
      }
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
   * Spawn a new progressive supply drop based on elapsed match time.
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
      // Early Phase (0 to 120 seconds): 8k - 12k troops, 80k - 120k gold, Electric Blue crate (#3b82f6)
      tier = "early";
      crateType = "early";
      troops = Math.floor(8000 + Math.random() * 4000);
      gold = Math.floor(80000 + Math.random() * 40000);
      ringColor = "#3b82f6";
    } else if (elapsedSec < 300) {
      // Mid Phase (120 to 300 seconds): 45k - 55k troops, 900k - 1.1M gold, Vibrant Purple crate (#a855f7)
      tier = "mid";
      crateType = "mid";
      troops = Math.floor(45000 + Math.random() * 10000);
      gold = Math.floor(900000 + Math.random() * 200000);
      ringColor = "#a855f7";
    } else {
      // Late Phase (300 seconds onward): 100k - 150k troops, 10M - 20M gold, Radiant Gold crate (#f59e0b)
      tier = "late";
      crateType = "late";
      troops = Math.floor(100000 + Math.random() * 50000);
      gold = Math.floor(10000000 + Math.random() * 10000000);
      ringColor = "#f59e0b";

      // Trigger top screen banner
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
    };

    this.activeDrops.set(dropId, drop);
    this.syncCratesWithEngine();

    // Initial pulsing beacon ring
    this.pools.spawnBeaconRing(x, y, ringColor, 8, 48, 1400, 2.5);

    return drop;
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
   * Handles claiming a drop when a node is captured.
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
    const formattedTroops = drop.troops >= 1000000 ? `${(drop.troops / 1000000).toFixed(1)}M` : `${Math.round(drop.troops / 1000)}k`;
    const formattedGold = drop.gold >= 1000000 ? `${(drop.gold / 1000000).toFixed(1)}M` : `${Math.round(drop.gold / 1000)}k`;

    this.pools.spawnFloatingText(`+${formattedTroops} Troops`, drop.x, drop.y - 12, "combat", "#60a5fa", 1500, 24, 13);
    this.pools.spawnFloatingText(`+${formattedGold} Gold`, drop.x, drop.y, "loot", "#facc15", 1500, 24, 13);

    // 3. Remove from active drops
    this.activeDrops.delete(drop.id);
    this.syncCratesWithEngine();

    // 4. Trigger callback for screen shake and victory animation
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
      });
    }
    this.engine.setSupplyCrates(list);
  }
}
