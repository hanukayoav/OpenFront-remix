import { Execution, Game, Player, PlayerType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { GameUpdateType } from "../game/GameUpdates";
import { PseudoRandom } from "../PseudoRandom";
import { GameID } from "../Schemas";
import { simpleHash } from "../Util";

export type SupplyDropTier = "early" | "mid" | "late";

export interface SimSupplyDrop {
  id: number;
  tile: TileRef;
  troops: number;
  gold: number;
  tier: SupplyDropTier;
  spawnTick: number;
  state: "descending" | "landed";
  collected: boolean;
}

/**
 * Authoritative deterministic supply drop simulation execution.
 *
 * Runs identically on every client:
 * - Spawns drops on valid land tiles every evaluationIntervalTicks (default 45s) up to maxActiveCrates (2).
 * - Transitions drops from descending -> landed after descentTicks (30 ticks = 3s).
 * - Never collects while descending.
 * - Automatically collects landed drops inside living AI territories (regardless of initial owner).
 * - Preserves human manual click-to-claim via ClaimSupplyDropExecution, preventing duplicates.
 */
export class SupplyDropExecution implements Execution {
  public static readonly DEFAULT_EVALUATION_INTERVAL_TICKS = 450; // 45s @ 10 ticks/sec
  public static readonly DEFAULT_MAX_ACTIVE_CRATES = 2;
  public static readonly DEFAULT_DESCENT_TICKS = 30; // 3.0s @ 10 ticks/sec

  private active = true;
  private mg!: Game;
  private rng: PseudoRandom;
  private activeMatchTicks = 0;
  private evaluationIntervalTicks: number;
  private maxActiveCrates: number;
  private readonly hasExplicitInterval: boolean;
  private readonly hasExplicitMaxCrates: boolean;
  private readonly descentTicks: number;
  private nextEvaluationTick: number;
  private nextDropId = 1;
  private readonly drops = new Map<number, SimSupplyDrop>();

  constructor(
    gameID: GameID,
    evaluationIntervalTicks?: number,
    maxActiveCrates?: number,
    descentTicks = SupplyDropExecution.DEFAULT_DESCENT_TICKS,
  ) {
    this.rng = new PseudoRandom((simpleHash(gameID) + 0x9e3779b9) >>> 0);
    this.hasExplicitInterval = evaluationIntervalTicks !== undefined;
    this.hasExplicitMaxCrates = maxActiveCrates !== undefined;
    this.evaluationIntervalTicks =
      evaluationIntervalTicks ??
      SupplyDropExecution.DEFAULT_EVALUATION_INTERVAL_TICKS;
    this.maxActiveCrates =
      maxActiveCrates ?? SupplyDropExecution.DEFAULT_MAX_ACTIVE_CRATES;
    this.descentTicks = descentTicks;
    this.nextEvaluationTick = this.evaluationIntervalTicks;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const cfg = mg.config?.()?.supplyDropConfig?.();
    if (cfg) {
      if (!this.hasExplicitInterval) {
        this.evaluationIntervalTicks = cfg.intervalTicks;
        this.nextEvaluationTick = this.evaluationIntervalTicks;
      }
      if (!this.hasExplicitMaxCrates) {
        this.maxActiveCrates = cfg.maxActiveCrates;
      }
    }
    this.mg.setSupplyDropSystem?.(this);
  }

  public getEvaluationIntervalTicks(): number {
    return this.evaluationIntervalTicks;
  }

  public getMaxActiveCrates(): number {
    return this.maxActiveCrates;
  }

  tick(ticks: number): void {
    this.activeMatchTicks++;

    if (this.activeMatchTicks >= this.nextEvaluationTick) {
      this.nextEvaluationTick += this.evaluationIntervalTicks;
      if (this.drops.size < this.maxActiveCrates) {
        const tile = this.pickEligibleLandTile();
        if (tile !== null) {
          this.spawnDropAt(tile, ticks);
        }
      }
    }

    // Iterate snapshot IDs safely since claims remove entries from this.drops
    const dropIds = Array.from(this.drops.keys());
    for (let i = 0; i < dropIds.length; i++) {
      const drop = this.drops.get(dropIds[i]);
      if (!drop || drop.collected) continue;

      if (drop.state === "descending") {
        if (ticks - drop.spawnTick < this.descentTicks) {
          // Strict rule: never collect while descending
          continue;
        }
        drop.state = "landed";
      }

      const owner = this.mg.owner(drop.tile);
      if (
        owner.isPlayer() &&
        owner.isAlive() &&
        owner.type() !== PlayerType.Human
      ) {
        this.executeClaim(drop, owner);
      }
    }
  }

  /**
   * Spawns a supply drop deterministically on `tile` using phase reward tables.
   */
  public spawnDropAt(
    tile: TileRef,
    currentTick = this.mg.ticks(),
  ): SimSupplyDrop {
    const elapsedSec = this.activeMatchTicks / 10;
    let tier: SupplyDropTier;
    let troops: number;
    let gold: number;

    if (elapsedSec < 120) {
      tier = "early";
      troops = this.rng.nextInt(8000, 12000);
      gold = this.rng.nextInt(80000, 120000);
    } else if (elapsedSec < 300) {
      tier = "mid";
      troops = this.rng.nextInt(45000, 55000);
      gold = this.rng.nextInt(900000, 1100000);
    } else {
      tier = "late";
      troops = this.rng.nextInt(100000, 150000);
      gold = this.rng.nextInt(10000000, 20000000);
    }

    const drop: SimSupplyDrop = {
      id: this.nextDropId++,
      tile,
      troops,
      gold,
      tier,
      spawnTick: currentTick,
      state: "descending",
      collected: false,
    };
    this.drops.set(drop.id, drop);

    const tileOwner = this.mg.owner(tile);
    this.mg.addUpdate({
      type: GameUpdateType.SupplyDropEvent,
      action: "spawn",
      dropId: drop.id,
      tile: drop.tile,
      troops: drop.troops,
      gold: drop.gold,
      tier: drop.tier,
      playerSmallId: tileOwner.isPlayer() ? tileOwner.smallID() : 0,
    });

    return drop;
  }

  /**
   * Authoritative handler for human click-to-claim intents.
   * Enforces: landed state, alive claiming player, friendly/owned drop tile, exactly-once award.
   */
  public claimByHuman(
    player: Player,
    dropId: number,
    _tile?: TileRef,
  ): boolean {
    if (!player.isAlive()) return false;
    const drop = this.drops.get(dropId);
    if (!drop || drop.collected) return false;
    if (drop.state !== "landed") return false;

    const tileOwner = this.mg.owner(drop.tile);
    if (!tileOwner.isPlayer() || tileOwner !== player) {
      return false;
    }

    return this.executeClaim(drop, player);
  }

  public getActiveDrops(): ReadonlyArray<SimSupplyDrop> {
    return Array.from(this.drops.values());
  }

  private executeClaim(drop: SimSupplyDrop, claimingPlayer: Player): boolean {
    if (drop.collected || !this.drops.has(drop.id)) {
      return false;
    }
    drop.collected = true;
    this.drops.delete(drop.id);

    claimingPlayer.addGold(BigInt(drop.gold));
    claimingPlayer.addTroops(drop.troops);

    this.mg.addUpdate({
      type: GameUpdateType.SupplyDropEvent,
      action: "claim",
      dropId: drop.id,
      tile: drop.tile,
      troops: drop.troops,
      gold: drop.gold,
      tier: drop.tier,
      playerId: claimingPlayer.id(),
      playerSmallId: claimingPlayer.smallID(),
    });
    return true;
  }

  private pickEligibleLandTile(): TileRef | null {
    const map = this.mg.map();
    const mapW = map.width();
    const mapH = map.height();
    const marginX = mapW > 24 ? 10 : 1;
    const marginY = mapH > 24 ? 10 : 1;
    const maxX = Math.max(marginX + 1, mapW - marginX);
    const maxY = Math.max(marginY + 1, mapH - marginY);

    for (let attempt = 0; attempt < 25; attempt++) {
      const rx = this.rng.nextInt(marginX, maxX);
      const ry = this.rng.nextInt(marginY, maxY);
      if (!map.isValidCoord(rx, ry)) continue;
      const tile = map.ref(rx, ry);
      if (map.isLand(tile) && !map.isImpassable(tile)) {
        return tile;
      }
    }
    return null;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

export class ClaimSupplyDropExecution implements Execution {
  private active = true;

  constructor(
    private readonly player: Player,
    private readonly dropId: number,
    private readonly tile?: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    mg.claimSupplyDrop?.(this.player, this.dropId, this.tile);
    this.active = false;
  }

  tick(ticks: number): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
