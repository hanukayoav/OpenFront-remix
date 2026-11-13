import {
  Execution,
  Game,
  Player,
  TankState,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap";

/**
 * Reusable zero-allocation A* pathfinding context for tanks.
 * Uses generational stamping and flat typed arrays to eliminate heap churn.
 */
class FastTankAStar {
  private stamp = 1;
  private visitedStamp: Uint32Array = new Uint32Array(0);
  private closedStamp: Uint32Array = new Uint32Array(0);
  private gScore: Float32Array = new Float32Array(0);
  private cameFrom: Int32Array = new Int32Array(0);
  private bfsQueue: Int32Array = new Int32Array(0);
  private bfsDist: Int32Array = new Int32Array(0);
  private open = new FlatBinaryHeap(512);
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private capacity = 0;

  private ensureCapacity(numTiles: number): void {
    if (this.capacity >= numTiles) return;
    this.capacity = numTiles;
    this.visitedStamp = new Uint32Array(numTiles);
    this.closedStamp = new Uint32Array(numTiles);
    this.gScore = new Float32Array(numTiles);
    this.cameFrom = new Int32Array(numTiles);
    this.bfsQueue = new Int32Array(numTiles);
    this.bfsDist = new Int32Array(numTiles);
  }

  findPath(
    mg: Game,
    start: TileRef,
    goal: TileRef,
    owner: Player,
    allowEnemy = false,
  ): TileRef[] | null {
    if (start === goal) return [start];
    const map = mg.map();
    const numTiles = map.width() * map.height();
    this.ensureCapacity(numTiles);

    const goalX = map.x(goal);
    const goalY = map.y(goal);

    this.stamp++;
    if (this.stamp >= 0xffffffff) {
      this.visitedStamp.fill(0);
      this.closedStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;

    this.open.clear();
    this.gScore[start] = 0;
    this.visitedStamp[start] = stamp;
    this.cameFrom[start] = -1;

    const h = (tile: TileRef) =>
      Math.abs(map.x(tile) - goalX) + Math.abs(map.y(tile) - goalY);

    const startH = h(start);
    this.open.enqueue(start, startH);

    let iterations = 0;
    const maxIterations = Math.min(4500, Math.max(700, startH * 12));

    while (this.open.size() > 0 && iterations < maxIterations) {
      const current = this.open.dequeue();
      if (this.closedStamp[current] === stamp) continue;
      iterations++;

      if (current === goal) {
        const path: TileRef[] = [goal];
        let curr = goal;
        while (this.cameFrom[curr] !== -1) {
          curr = this.cameFrom[curr];
          path.push(curr);
        }
        path.reverse();
        return path;
      }

      this.closedStamp[current] = stamp;
      const currentG = this.gScore[current];

      const count = map.neighbors4(current, this.nbuf);
      for (let i = 0; i < count; i++) {
        const neighbor = this.nbuf[i];
        if (this.closedStamp[neighbor] === stamp) continue;
        if (map.isWater(neighbor) || map.isImpassable(neighbor)) {
          continue;
        }

        let stepCost = 1;
        const neighborOwner = mg.owner(neighbor);
        if (neighborOwner.isPlayer()) {
          if (!owner.isFriendly(neighborOwner)) {
            if (!allowEnemy) {
              continue;
            }
            stepCost = 10;
          }
        } else {
          stepCost = 2;
        }

        const tentativeG = currentG + stepCost;
        if (
          this.visitedStamp[neighbor] !== stamp ||
          tentativeG < this.gScore[neighbor]
        ) {
          this.cameFrom[neighbor] = current;
          this.gScore[neighbor] = tentativeG;
          this.visitedStamp[neighbor] = stamp;
          this.open.enqueue(neighbor, tentativeG + h(neighbor));
        }
      }
    }

    return null;
  }

  /**
   * Shortest passable land BFS from a stranded position back to nearest owned land tile.
   * Rejects routes requiring crossing > maxEnemySteps tiles outside friendly territory.
   */
  findNearestOwnedLandPath(
    mg: Game,
    start: TileRef,
    owner: Player,
    maxEnemySteps = 28,
    maxVisited = 4096,
  ): TileRef[] | null {
    const map = mg.map();
    const numTiles = map.width() * map.height();
    this.ensureCapacity(numTiles);

    this.stamp++;
    if (this.stamp >= 0xffffffff) {
      this.visitedStamp.fill(0);
      this.closedStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;

    let head = 0;
    let tail = 0;
    this.bfsQueue[tail] = start;
    this.bfsDist[tail] = 0;
    tail++;
    this.visitedStamp[start] = stamp;
    this.cameFrom[start] = -1;

    while (head < tail && tail < maxVisited) {
      const current = this.bfsQueue[head];
      const dist = this.bfsDist[head];
      head++;

      const curOwner = mg.owner(current);
      if (current !== start && curOwner.isPlayer() && curOwner === owner) {
        const path: TileRef[] = [current];
        let curr = current;
        while (this.cameFrom[curr] !== -1) {
          curr = this.cameFrom[curr];
          path.push(curr);
        }
        path.reverse();
        return path;
      }

      if (dist >= maxEnemySteps) {
        continue;
      }

      const count = map.neighbors4(current, this.nbuf);
      // Sort neighbors deterministically by TileRef ascending
      if (count > 1) {
        for (let a = 1; a < count; a++) {
          const key = this.nbuf[a];
          let b = a - 1;
          while (b >= 0 && this.nbuf[b] > key) {
            this.nbuf[b + 1] = this.nbuf[b];
            b--;
          }
          this.nbuf[b + 1] = key;
        }
      }
      for (let i = 0; i < count; i++) {
        const neighbor = this.nbuf[i];
        if (this.visitedStamp[neighbor] === stamp) continue;
        if (map.isWater(neighbor) || map.isImpassable(neighbor)) continue;
        this.visitedStamp[neighbor] = stamp;
        this.cameFrom[neighbor] = current;
        this.bfsQueue[tail] = neighbor;
        this.bfsDist[tail] = dist + 1;
        tail++;
        if (tail >= maxVisited) break;
      }
    }

    return null;
  }
}

const fastTankAStar = new FastTankAStar();

/**
 * A* over passable land. Uses generational stamped typed arrays and a reusable
 * binary heap, eliminating per-call Map/Set/Heap heap allocations.
 */
export function findTankPath(
  mg: Game,
  start: TileRef,
  goal: TileRef,
  owner: Player,
  allowEnemy = false,
): TileRef[] | null {
  return fastTankAStar.findPath(mg, start, goal, owner, allowEnemy);
}

class BorderWaypointContext {
  private stamp = 1;
  private unvisitedStamp: Uint32Array = new Uint32Array(0);
  private degrees: Int16Array = new Int16Array(0);
  private capacity = 0;

  public enemyBorders: TileRef[] = [];
  public neutralBorders: TileRef[] = [];
  public coastalBorders: TileRef[] = [];
  public endpoints: TileRef[] = [];
  public ordered: TileRef[] = [];

  ensureCapacity(numTiles: number): void {
    if (this.capacity >= numTiles) return;
    this.capacity = numTiles;
    this.unvisitedStamp = new Uint32Array(numTiles);
    this.degrees = new Int16Array(numTiles);
  }

  nextStamp(): number {
    this.stamp++;
    if (this.stamp >= 0xffffffff) {
      this.unvisitedStamp.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  getUnvisitedStamp(): Uint32Array {
    return this.unvisitedStamp;
  }

  getDegrees(): Int16Array {
    return this.degrees;
  }
}

const borderWaypointCtx = new BorderWaypointContext();

export function computeHostileBorderWaypoints(
  mg: Game,
  player: Player,
  numTanks: number,
  rallyTile?: TileRef,
): TileRef[] {
  if (numTanks <= 0) return [];
  const map = mg.map();
  const numTiles = map.width() * map.height();
  borderWaypointCtx.ensureCapacity(numTiles);
  const stamp = borderWaypointCtx.nextStamp();
  const unvisitedStamp = borderWaypointCtx.getUnvisitedStamp();
  const degrees = borderWaypointCtx.getDegrees();

  const enemyBorders = borderWaypointCtx.enemyBorders;
  const neutralBorders = borderWaypointCtx.neutralBorders;
  const coastalBorders = borderWaypointCtx.coastalBorders;
  enemyBorders.length = 0;
  neutralBorders.length = 0;
  coastalBorders.length = 0;

  const nbuf: TileRef[] = [0, 0, 0, 0];

  for (const b of player.borderTiles()) {
    let isEnemy = false;
    let isNeutral = false;
    let isCoast = false;
    const count = map.neighbors4(b, nbuf);
    for (let j = 0; j < count; j++) {
      const n = nbuf[j];
      if (map.isLand(n) && !map.isImpassable(n)) {
        const owner = mg.owner(n);
        if (owner.isPlayer()) {
          if (!player.isFriendly(owner)) {
            isEnemy = true;
          }
        } else {
          isNeutral = true; // Terra Nullius
        }
      } else if (map.isWater(n)) {
        isCoast = true;
      }
    }
    if (isEnemy) {
      enemyBorders.push(b);
    } else if (isNeutral) {
      neutralBorders.push(b);
    } else if (isCoast) {
      coastalBorders.push(b);
    }
  }

  const candidateTiles =
    enemyBorders.length > 0
      ? enemyBorders
      : neutralBorders.length > 0
        ? neutralBorders
        : coastalBorders;
  if (candidateTiles.length === 0) {
    return [];
  }

  // 2. Order into connected chains in O(M) time
  // Sort candidate tiles ascending for strict determinism
  candidateTiles.sort((a, b) => a - b);
  for (let i = 0; i < candidateTiles.length; i++) {
    unvisitedStamp[candidateTiles[i]] = stamp;
  }

  const endpoints = borderWaypointCtx.endpoints;
  endpoints.length = 0;

  for (let i = 0; i < candidateTiles.length; i++) {
    const tile = candidateTiles[i];
    let deg = 0;
    const count = map.neighbors4(tile, nbuf);
    for (let j = 0; j < count; j++) {
      if (unvisitedStamp[nbuf[j]] === stamp) deg++;
    }
    degrees[tile] = deg;
    if (deg <= 1) {
      endpoints.push(tile);
    }
  }

  let endpointIdx = 0;
  let candidateIdx = 0;
  let unvisitedCount = candidateTiles.length;
  const ordered = borderWaypointCtx.ordered;
  ordered.length = 0;

  while (unvisitedCount > 0) {
    // Select start node: prefer endpoints (degree <= 1), else lowest coord
    let startNode: TileRef = -1;
    while (endpointIdx < endpoints.length) {
      const ep = endpoints[endpointIdx++];
      if (unvisitedStamp[ep] === stamp) {
        startNode = ep;
        break;
      }
    }
    if (startNode === -1) {
      while (candidateIdx < candidateTiles.length) {
        const c = candidateTiles[candidateIdx++];
        if (unvisitedStamp[c] === stamp) {
          startNode = c;
          break;
        }
      }
    }
    if (startNode === -1) break;

    let curr: TileRef | null = startNode;
    while (curr !== null) {
      unvisitedStamp[curr] = 0;
      unvisitedCount--;
      ordered.push(curr);

      let next: TileRef | null = null;
      let nextCoord = 99999999;
      const count = map.neighbors4(curr, nbuf);
      for (let i = 0; i < count; i++) {
        const neighbor = nbuf[i];
        if (unvisitedStamp[neighbor] === stamp) {
          degrees[neighbor]--;
          if (neighbor < nextCoord) {
            nextCoord = neighbor;
            next = neighbor;
          }
        }
      }
      curr = next;
    }
  }

  const N = ordered.length;
  if (numTanks >= N) {
    if (numTanks === N) {
      return ordered.slice();
    }
    // Replicate waypoints evenly so all tanks receive an assigned waypoint
    const waypoints: TileRef[] = [];
    for (let i = 0; i < numTanks; i++) {
      waypoints.push(ordered[i % N]);
    }
    return waypoints;
  }

  // 3. Spacing calculation
  // If rally point is set, prioritize section nearest rally point
  if (rallyTile !== undefined && mg.isValidRef(rallyTile)) {
    ordered.sort(
      (a, b) => mg.manhattanDist(a, rallyTile) - mg.manhattanDist(b, rallyTile),
    );
    return ordered.slice(0, numTanks);
  }

  if (numTanks === 1) {
    return [ordered[Math.floor(N / 2)]];
  }

  const waypoints: TileRef[] = [];
  for (let i = 0; i < numTanks; i++) {
    const idx = Math.floor(((i + 0.5) * N) / numTanks);
    waypoints.push(ordered[idx]);
  }

  return waypoints;
}

/** How often (in ticks) each tank re-validates border slotting (staggered per tank ID). */
const SLOTTING_INTERVAL = 10;
const SPEARHEAD_MAX_HOLD_TICKS = 6;
const TRAPPED_DESTRUCTION_TICKS = 6;
const MAX_STRANDED_RETREAT_TICKS = 36;
const MAX_RETREAT_DISTANCE = 28;
const FAILED_GOAL_RETRY_TICKS = 30;

type FrontTier = "enemy" | "neutral" | "coastal" | "none";
const frontNbuf: TileRef[] = [0, 0, 0, 0];

function classifyTileFront(mg: Game, owner: Player, tile: TileRef): FrontTier {
  const map = mg.map();
  const count = map.neighbors4(tile, frontNbuf);
  let hasNeutral = false;
  let hasCoast = false;
  for (let i = 0; i < count; i++) {
    const n = frontNbuf[i];
    if (map.isLand(n) && !map.isImpassable(n)) {
      const nOwner = mg.owner(n);
      if (nOwner.isPlayer()) {
        if (!owner.isFriendly(nOwner)) {
          return "enemy";
        }
      } else {
        hasNeutral = true;
      }
    } else if (map.isWater(n)) {
      hasCoast = true;
    }
  }
  if (hasNeutral) return "neutral";
  if (hasCoast) return "coastal";
  return "none";
}

interface RallySlottingData {
  waypoints: TileRef[];
  waypointSet: Set<TileRef>;
  frontTier: FrontTier;
  assignment: Map<number, TileRef>;
}

interface SlottingCacheEntry {
  computedTick: number;
  lastTileChange: number;
  alliesCount: number;
  tankSig: number;
  byRally: Map<number, RallySlottingData>;
}

/**
 * Per-player slotting results shared across ticks until ownership, alliances,
 * or active tank roster change (or after SLOTTING_INTERVAL to detect neighbor shifts).
 * Keyed weakly on Player so finished games are garbage collected cleanly.
 */
const slottingCache = new WeakMap<Player, SlottingCacheEntry>();

export class TankExecution implements Execution {
  private active = true;
  private mg: Game;
  private lastOwner: Player | null = null;
  private targetWaypoint: TileRef | null = null;
  private lastSlottingTick = -100;
  private spearheadHoldTicks = 0;
  private strandedTicks = 0;
  private enemyRetreatTicks = 0;

  // Cached route to targetWaypoint (or retreat path to nearest friendly tile)
  private path: TileRef[] = [];
  private pathIdx = 0;
  private pathGoal: TileRef | null = null;
  private retreatPath: TileRef[] = [];
  private retreatPathIdx = 0;
  private failedGoal: TileRef | null = null;
  private failedFrom: TileRef | null = null;
  private failedAtTick = -100;

  constructor(
    private tank: Unit,
    private factory?: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.lastOwner = this.tank.owner();
  }

  tick(ticks: number): void {
    if (!this.tank.isActive() || !this.tank.owner().isAlive()) {
      this.active = false;
      return;
    }

    const owner = this.tank.owner();
    if (this.lastOwner !== null && owner !== this.lastOwner) {
      this.lastOwner = owner;
      this.factory = undefined;
      this.targetWaypoint = null;
      this.clearPath();
      this.retreatPath = [];
      this.retreatPathIdx = 0;
      this.spearheadHoldTicks = 0;
      this.strandedTicks = 0;
      this.enemyRetreatTicks = 0;
    }
    this.lastOwner ??= owner;

    // Drop link to captured/destroyed source factory so old rally points cannot hijack surviving tanks
    if (
      this.factory !== undefined &&
      (!this.factory.isActive() || this.factory.owner() !== owner)
    ) {
      this.factory = undefined;
    }

    // 1. Reload cooldown progression
    if (this.tank.tankCooldown() > 0) {
      this.tank.setTankCooldown(this.tank.tankCooldown() - 1);
      if (
        this.tank.tankCooldown() === 0 &&
        this.tank.tankState() === TankState.Reloading
      ) {
        this.tank.setTankState(TankState.Patrolling);
      }
    }

    const currentTile = this.tank.tile();
    const curTileOwner = this.mg.owner(currentTile);
    const onOwnTile = curTileOwner.isPlayer() && curTileOwner === owner;
    const onFriendlyAllyTile =
      curTileOwner.isPlayer() &&
      curTileOwner !== owner &&
      owner.isFriendly(curTileOwner);
    const onHostileTile =
      curTileOwner.isPlayer() && !owner.isFriendly(curTileOwner);

    // 2. Hostile territory detection (checks even Spearheading tanks if tile fell to enemy!)
    if (onHostileTile) {
      this.spearheadHoldTicks = 0;
      if (this.tank.tankState() === TankState.Spearheading) {
        this.tank.setTankState(TankState.Patrolling);
      }
      this.handleStrandedInHostileTerritory(currentTile, owner);
      return;
    }

    // Safe on own or allied tile: clear retreat counters
    this.strandedTicks = 0;
    this.enemyRetreatTicks = 0;
    this.retreatPath = [];
    this.retreatPathIdx = 0;

    // 3. Spearhead breakthrough anchoring (only while tile stays owned and attack is active)
    if (this.tank.tankState() === TankState.Spearheading) {
      this.spearheadHoldTicks++;
      const hasActiveAttack = owner.outgoingAttacks().length > 0;
      if (
        onOwnTile &&
        hasActiveAttack &&
        this.spearheadHoldTicks <= SPEARHEAD_MAX_HOLD_TICKS
      ) {
        return;
      }
      this.spearheadHoldTicks = 0;
      this.tank.setTankState(TankState.Patrolling);
      this.targetWaypoint = null;
      this.clearPath();
    }

    // Validate manual / factory rally points (clear if captured by enemy or impassable)
    this.validateRallyPoint(owner);

    // 4. Staggered + reactive border slotting recalculation
    const staggerDue =
      ((ticks + this.tank.id()) % SLOTTING_INTERVAL === 0 &&
        ticks !== this.lastSlottingTick) ||
      (this.lastSlottingTick < 0 && ticks !== this.lastSlottingTick);

    const wpOwner =
      this.targetWaypoint !== null && this.mg.hasOwner(this.targetWaypoint)
        ? this.mg.owner(this.targetWaypoint)
        : null;
    const wpLostOwnership = this.targetWaypoint !== null && wpOwner !== owner;

    let wpBecameObsolete = false;
    if (!wpLostOwnership && this.targetWaypoint !== null && staggerDue) {
      const wpTier = classifyTileFront(this.mg, owner, this.targetWaypoint);
      const cached = slottingCache.get(owner);
      const activeTier = cached?.byRally.get(
        this.getValidRallyTile(owner) ?? -1,
      )?.frontTier;
      if (wpTier === "none" || (activeTier === "enemy" && wpTier !== "enemy")) {
        wpBecameObsolete = true;
      }
    }

    const needsSlotting =
      staggerDue ||
      (this.targetWaypoint === null && this.lastSlottingTick !== ticks) ||
      wpLostOwnership ||
      wpBecameObsolete ||
      (!onOwnTile && !onFriendlyAllyTile && this.lastSlottingTick !== ticks);

    if (needsSlotting) {
      this.lastSlottingTick = ticks;
      this.recalculateSlotting(ticks);
    }

    // 5. Movement along path to target waypoint
    if (
      this.targetWaypoint !== null &&
      this.tank.tile() !== this.targetWaypoint
    ) {
      if (this.tank.tankState() !== TankState.Reloading) {
        this.tank.setTankState(TankState.Deploying);
      }
      const nextTile = this.nextStep(this.targetWaypoint, ticks);
      if (nextTile !== null) {
        this.tank.move(nextTile);
        this.pathIdx++;
        if (this.tank.tile() === this.targetWaypoint) {
          this.tank.setTankState(TankState.Patrolling);
        }
      }
    } else if (
      this.targetWaypoint !== null &&
      this.tank.tile() === this.targetWaypoint
    ) {
      if (this.tank.tankState() === TankState.Deploying) {
        this.tank.setTankState(TankState.Patrolling);
      }
    }
  }

  private clearPath(): void {
    this.path = [];
    this.pathGoal = null;
    this.pathIdx = 0;
  }

  private isFriendlyRallyTile(owner: Player, tile: TileRef): boolean {
    if (!this.mg.isValidRef(tile)) return false;
    const map = this.mg.map();
    if (map.isWater(tile) || map.isImpassable(tile)) return false;
    const tileOwner = this.mg.owner(tile);
    return tileOwner.isPlayer() && owner.isFriendly(tileOwner);
  }

  private getValidRallyTile(owner: Player): TileRef | undefined {
    const raw = this.tank.tankRallyTile() ?? this.factory?.tankRallyTile();
    if (raw === undefined) return undefined;
    return this.isFriendlyRallyTile(owner, raw) ? raw : undefined;
  }

  private validateRallyPoint(owner: Player): void {
    const personal = this.tank.tankRallyTile();
    if (personal !== undefined && !this.isFriendlyRallyTile(owner, personal)) {
      this.tank.setTankRallyTile(undefined);
      this.targetWaypoint = null;
      this.clearPath();
    }
    if (this.factory !== undefined) {
      const fr = this.factory.tankRallyTile();
      if (fr !== undefined && !this.isFriendlyRallyTile(owner, fr)) {
        this.factory.setTankRallyTile(undefined);
        this.targetWaypoint = null;
        this.clearPath();
      }
    }
  }

  /**
   * Stranded tank recovery when enemy conquers the tank's current tile:
   * - Attempts step-by-step land retreat back to nearest reachable owned tile.
   * - Dynamically replans if border shifts during retreat.
   * - Deterministically destroys truly trapped/surrounded units when cut off or surrounded.
   */
  private handleStrandedInHostileTerritory(
    currentTile: TileRef,
    owner: Player,
  ): void {
    this.targetWaypoint = null;
    this.clearPath();
    this.validateRallyPoint(owner);

    this.enemyRetreatTicks++;
    if (this.enemyRetreatTicks > MAX_STRANDED_RETREAT_TICKS) {
      this.tank.delete(true);
      this.active = false;
      return;
    }

    const map = this.mg.map();
    const dest =
      this.retreatPath.length > 0
        ? this.retreatPath[this.retreatPath.length - 1]
        : null;
    const retreatValid =
      dest !== null &&
      this.mg.hasOwner(dest) &&
      this.mg.owner(dest) === owner &&
      this.retreatPathIdx > 0 &&
      this.retreatPathIdx < this.retreatPath.length &&
      this.retreatPath[this.retreatPathIdx - 1] === currentTile &&
      !map.isWater(this.retreatPath[this.retreatPathIdx]) &&
      !map.isImpassable(this.retreatPath[this.retreatPathIdx]);

    if (!retreatValid) {
      const path = fastTankAStar.findNearestOwnedLandPath(
        this.mg,
        currentTile,
        owner,
        MAX_RETREAT_DISTANCE,
      );
      if (path === null || path.length < 2) {
        this.retreatPath = [];
        this.retreatPathIdx = 0;
        this.strandedTicks++;
        if (this.strandedTicks >= TRAPPED_DESTRUCTION_TICKS) {
          this.tank.delete(true);
          this.active = false;
        }
        return;
      }
      this.retreatPath = path;
      this.retreatPathIdx = 1;
    }

    this.strandedTicks = 0;
    const nextTile = this.retreatPath[this.retreatPathIdx];
    this.retreatPathIdx++;
    if (this.tank.tankState() !== TankState.Reloading) {
      this.tank.setTankState(TankState.Deploying);
    }
    this.tank.move(nextTile);

    const afterOwner = this.mg.owner(this.tank.tile());
    if (afterOwner.isPlayer() && afterOwner === owner) {
      // Returned to friendly land: reset retreat counters & re-slot immediately next tick
      this.strandedTicks = 0;
      this.enemyRetreatTicks = 0;
      this.retreatPath = [];
      this.retreatPathIdx = 0;
      this.lastSlottingTick = -100;
      if (this.tank.tankState() !== TankState.Reloading) {
        this.tank.setTankState(TankState.Patrolling);
      }
    }
  }

  /** Returns the next tile toward `goal`, re-planning only when needed. */
  private nextStep(goal: TileRef, ticks: number): TileRef | null {
    const map = this.mg.map();
    const here = this.tank.tile();
    const owner = this.tank.owner();
    const nextStepTile =
      this.pathIdx > 0 && this.pathIdx < this.path.length
        ? this.path[this.pathIdx]
        : null;
    const nextStepOwner =
      nextStepTile !== null ? this.mg.owner(nextStepTile) : null;
    const valid =
      nextStepTile !== null &&
      this.pathGoal === goal &&
      this.path[this.pathIdx - 1] === here &&
      !map.isWater(nextStepTile) &&
      !map.isImpassable(nextStepTile) &&
      (nextStepOwner === null ||
        !nextStepOwner.isPlayer() ||
        owner.isFriendly(nextStepOwner));

    if (!valid) {
      if (
        this.failedGoal === goal &&
        this.failedFrom === here &&
        ticks - this.failedAtTick < FAILED_GOAL_RETRY_TICKS
      ) {
        return null;
      }
      const path = findTankPath(this.mg, here, goal, owner, false);
      if (path === null || path.length < 2) {
        // Goal may be cut off by water/mountains/enemy: try nearest reachable frontier waypoint
        const fallback = this.findReachableFallbackWaypoint(here, goal, owner);
        if (fallback !== null) {
          this.targetWaypoint = fallback.goal;
          this.pathGoal = fallback.goal;
          this.path = fallback.path;
          this.pathIdx = 1;
          this.failedGoal = null;
          this.failedFrom = null;
          return this.path[this.pathIdx];
        }
        this.pathGoal = goal;
        this.clearPath();
        this.failedGoal = goal;
        this.failedFrom = here;
        this.failedAtTick = ticks;
        return null;
      }
      this.failedGoal = null;
      this.failedFrom = null;
      this.pathGoal = goal;
      this.path = path;
      this.pathIdx = 1;
    }
    return this.path[this.pathIdx];
  }

  private findReachableFallbackWaypoint(
    here: TileRef,
    excludeGoal: TileRef,
    owner: Player,
  ): { goal: TileRef; path: TileRef[] } | null {
    const entry = slottingCache.get(owner);
    const rallyKey = this.getValidRallyTile(owner) ?? -1;
    const data = entry?.byRally.get(rallyKey);
    if (!data || data.waypoints.length === 0) return null;

    const candidates: Array<{ wp: TileRef; dist: number }> = [];
    for (let i = 0; i < data.waypoints.length; i++) {
      const wp = data.waypoints[i];
      if (wp === excludeGoal || wp === here) continue;
      if (!this.mg.hasOwner(wp) || this.mg.owner(wp) !== owner) continue;
      candidates.push({ wp, dist: this.mg.manhattanDist(here, wp) });
    }
    candidates.sort((a, b) => a.dist - b.dist || a.wp - b.wp);

    if (candidates.length > 0) {
      const wp = candidates[0].wp;
      const p = findTankPath(this.mg, here, wp, owner, false);
      if (p !== null && p.length >= 2) {
        return { goal: wp, path: p };
      }
    }
    return null;
  }

  private recalculateSlotting(ticks: number): void {
    const owner = this.tank.owner();
    const rallyTile = this.getValidRallyTile(owner);
    const rallyKey = rallyTile ?? -1;

    const lastTileChange =
      typeof owner.lastTileChange === "function" ? owner.lastTileChange() : -1;
    const alliesCount =
      typeof owner.allies === "function" ? owner.allies().length : 0;

    let entry = slottingCache.get(owner);
    const wpInvalid =
      this.targetWaypoint !== null &&
      (!this.mg.hasOwner(this.targetWaypoint) ||
        this.mg.owner(this.targetWaypoint) !== owner);
    const cacheStale =
      entry === undefined ||
      ticks - entry.computedTick >= SLOTTING_INTERVAL ||
      entry.alliesCount !== alliesCount ||
      (wpInvalid && ticks - entry.computedTick >= 2);

    if (cacheStale) {
      entry = {
        computedTick: ticks,
        lastTileChange,
        alliesCount,
        tankSig: 0,
        byRally: new Map(),
      };
      slottingCache.set(owner, entry);
    }

    let rallyData = entry!.byRally.get(rallyKey);
    if (rallyData === undefined || !rallyData.assignment.has(this.tank.id())) {
      rallyData = this.computeAssignment(owner, rallyTile);
      entry!.byRally.set(rallyKey, rallyData);
    }

    const chosen = rallyData.assignment.get(this.tank.id());

    // Keep current waypoint without path thrashing if it is STILL on the active frontier
    // and close to the newly computed slot (prevents constant A* recalculation on minor shifts)
    if (
      rallyTile === undefined &&
      this.targetWaypoint !== null &&
      !wpInvalid &&
      (rallyData.waypointSet.has(this.targetWaypoint) ||
        (classifyTileFront(this.mg, owner, this.targetWaypoint) ===
          rallyData.frontTier &&
          (chosen === undefined ||
            this.mg.manhattanDist(this.targetWaypoint, chosen) <= 8)))
    ) {
      return;
    }

    if (chosen !== undefined) {
      if (this.targetWaypoint !== chosen) {
        this.targetWaypoint = chosen;
        this.failedGoal = null;
        this.failedFrom = null;
        this.clearPath();
      }
    } else if (rallyData.waypoints.length === 0) {
      this.targetWaypoint = null;
      this.failedGoal = null;
      this.failedFrom = null;
      this.clearPath();
    }
  }

  private computeAssignment(
    owner: Player,
    rallyTile: TileRef | undefined,
  ): RallySlottingData {
    const assignment = new Map<number, TileRef>();
    const tanks = owner.units(UnitType.Tank).filter((u) => u.isActive());
    if (tanks.length === 0) {
      return {
        waypoints: [],
        waypointSet: new Set(),
        frontTier: "none",
        assignment,
      };
    }
    tanks.sort((a, b) => a.id() - b.id());

    const waypoints = computeHostileBorderWaypoints(
      this.mg,
      owner,
      tanks.length,
      rallyTile,
    );

    const waypointSet = new Set<TileRef>(waypoints);
    const frontTier: FrontTier =
      waypoints.length > 0
        ? classifyTileFront(this.mg, owner, waypoints[0])
        : "none";

    if (waypoints.length === 0) {
      return { waypoints, waypointSet, frontTier, assignment };
    }

    const used = new Uint8Array(waypoints.length);
    const assigned = new Uint8Array(tanks.length);

    // Pass 1 (anti-oscillation): tanks already stationed directly on an active waypoint keep it
    if (rallyTile === undefined) {
      const tileToWpIdx = new Map<TileRef, number>();
      for (let i = 0; i < waypoints.length; i++) {
        if (!tileToWpIdx.has(waypoints[i])) {
          tileToWpIdx.set(waypoints[i], i);
        }
      }
      for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
        const curTile = tanks[tIdx].tile();
        const wpIdx = tileToWpIdx.get(curTile);
        if (wpIdx !== undefined && !used[wpIdx]) {
          used[wpIdx] = 1;
          assigned[tIdx] = 1;
          assignment.set(tanks[tIdx].id(), waypoints[wpIdx]);
        }
      }
    }

    // Pass 2: deterministic greedy nearest-waypoint matching for moving/unslotted tanks
    for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
      if (assigned[tIdx]) continue;
      const t = tanks[tIdx];
      const tTile = t.tile();
      let closestIdx = -1;
      let closestDist = Infinity;
      for (let i = 0; i < waypoints.length; i++) {
        if (used[i]) continue;
        const d = this.mg.manhattanDist(tTile, waypoints[i]);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      if (closestIdx !== -1) {
        used[closestIdx] = 1;
        assignment.set(t.id(), waypoints[closestIdx]);
      } else {
        let fallbackIdx = 0;
        let fallbackDist = Infinity;
        for (let i = 0; i < waypoints.length; i++) {
          const d = this.mg.manhattanDist(tTile, waypoints[i]);
          if (d < fallbackDist) {
            fallbackDist = d;
            fallbackIdx = i;
          }
        }
        assignment.set(t.id(), waypoints[fallbackIdx]);
      }
    }
    return { waypoints, waypointSet, frontTier, assignment };
  }

  public static calculateBorderWaypoints(
    mg: Game,
    player: Player,
    numTanks: number,
    rallyTile?: TileRef,
  ): TileRef[] {
    return computeHostileBorderWaypoints(mg, player, numTanks, rallyTile);
  }

  getTargetWaypoint(): TileRef | null {
    return this.targetWaypoint;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
