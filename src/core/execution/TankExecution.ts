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
  }

  findPath(
    mg: Game,
    start: TileRef,
    goal: TileRef,
    owner: Player,
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

    this.open.enqueue(start, h(start));

    let iterations = 0;
    const maxIterations = 10000;

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
): TileRef[] | null {
  return fastTankAStar.findPath(mg, start, goal, owner);
}

export function computeHostileBorderWaypoints(
  mg: Game,
  player: Player,
  numTanks: number,
  rallyTile?: TileRef,
): TileRef[] {
  if (numTanks <= 0) return [];
  const map = mg.map();
  const borderTiles = Array.from(player.borderTiles());
  const nbuf: TileRef[] = [0, 0, 0, 0];

  // 1. Filter hostile/contested border tiles
  const enemyBorders: TileRef[] = [];
  const neutralBorders: TileRef[] = [];
  const coastalBorders: TileRef[] = [];

  for (let i = 0; i < borderTiles.length; i++) {
    const b = borderTiles[i];
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
  const unvisited = new Set<TileRef>(candidateTiles);
  const ordered: TileRef[] = [];

  // Precompute degrees of candidate tiles within the unvisited set
  const degrees = new Map<TileRef, number>();
  const endpoints: TileRef[] = [];

  for (let i = 0; i < candidateTiles.length; i++) {
    const tile = candidateTiles[i];
    let deg = 0;
    const count = map.neighbors4(tile, nbuf);
    for (let j = 0; j < count; j++) {
      if (unvisited.has(nbuf[j])) deg++;
    }
    degrees.set(tile, deg);
    if (deg <= 1) {
      endpoints.push(tile);
    }
  }

  let endpointIdx = 0;
  let candidateIdx = 0;

  while (unvisited.size > 0) {
    // Select start node: prefer endpoints (degree <= 1), else lowest coord
    let startNode: TileRef = -1;
    while (endpointIdx < endpoints.length) {
      const ep = endpoints[endpointIdx++];
      if (unvisited.has(ep)) {
        startNode = ep;
        break;
      }
    }
    if (startNode === -1) {
      while (candidateIdx < candidateTiles.length) {
        const c = candidateTiles[candidateIdx++];
        if (unvisited.has(c)) {
          startNode = c;
          break;
        }
      }
    }
    if (startNode === -1) break;

    let curr: TileRef | null = startNode;
    while (curr !== null) {
      unvisited.delete(curr);
      ordered.push(curr);

      let next: TileRef | null = null;
      let nextCoord = 99999999;
      const count = map.neighbors4(curr, nbuf);
      for (let i = 0; i < count; i++) {
        const neighbor = nbuf[i];
        if (unvisited.has(neighbor)) {
          const d = degrees.get(neighbor) ?? 1;
          degrees.set(neighbor, d - 1);
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

/** How often (in ticks) tanks re-slot along the border and re-plan routes. */
const SLOTTING_INTERVAL = 10;

interface SlottingCacheEntry {
  tick: number;
  // rally tile (or -1) -> (tank id -> assigned waypoint)
  byRally: Map<number, Map<number, TileRef>>;
}

/**
 * Per-player slotting results for the current tick. Every tank of a player
 * computes the exact same border waypoints + greedy assignment, so sharing it
 * turns K identical O(border) passes into one. Keyed weakly on the Player so
 * finished games are garbage collected.
 */
const slottingCache = new WeakMap<Player, SlottingCacheEntry>();

export class TankExecution implements Execution {
  private active = true;
  private mg: Game;
  private targetWaypoint: TileRef | null = null;
  private lastSlottingTick = -100;

  // Cached route to targetWaypoint. path[pathIdx] is the next tile to step
  // to; previously the full A* route was recomputed every single tick.
  private path: TileRef[] = [];
  private pathIdx = 0;
  private pathGoal: TileRef | null = null;
  private failedGoal: TileRef | null = null;
  private failedFrom: TileRef | null = null;

  constructor(
    private tank: Unit,
    private factory?: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.tank.isActive() || !this.tank.owner().isAlive()) {
      this.active = false;
      return;
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

    // 2. Spearhead anchoring
    if (this.tank.tankState() === TankState.Spearheading) {
      // Anchored defending the breakthrough
      return;
    }

    // 3. Periodic border slotting recalculation. Aligned to a global tick
    // boundary so all of a player's tanks re-slot on the same tick and share
    // one computation via slottingCache.
    const needsSlotting =
      (ticks % SLOTTING_INTERVAL === 0 && ticks !== this.lastSlottingTick) ||
      (this.targetWaypoint === null && this.lastSlottingTick !== ticks) ||
      (this.targetWaypoint !== null &&
        (!this.mg.hasOwner(this.targetWaypoint) ||
          this.mg.owner(this.targetWaypoint) !== this.tank.owner()));

    if (needsSlotting) {
      this.lastSlottingTick = ticks;
      this.recalculateSlotting(ticks);
    }

    // 4. Movement along path to target waypoint
    if (
      this.targetWaypoint !== null &&
      this.tank.tile() !== this.targetWaypoint
    ) {
      if (this.tank.tankState() !== TankState.Reloading) {
        this.tank.setTankState(TankState.Deploying);
      }
      const nextTile = this.nextStep(this.targetWaypoint);
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

  /** Returns the next tile toward `goal`, re-planning only when needed. */
  private nextStep(goal: TileRef): TileRef | null {
    const map = this.mg.map();
    const here = this.tank.tile();
    const valid =
      this.pathGoal === goal &&
      this.pathIdx > 0 &&
      this.pathIdx < this.path.length &&
      // Tank is where the route expects (it can be moved externally, e.g. by
      // a vanguard spearhead advance).
      this.path[this.pathIdx - 1] === here &&
      !map.isWater(this.path[this.pathIdx]) &&
      !map.isImpassable(this.path[this.pathIdx]);

    if (!valid) {
      if (this.failedGoal === goal && this.failedFrom === here) {
        return null;
      }
      const path = findTankPath(this.mg, here, goal, this.tank.owner());
      this.pathGoal = goal;
      if (path === null || path.length < 2) {
        this.path = [];
        this.pathIdx = 0;
        this.failedGoal = goal;
        this.failedFrom = here;
        return null;
      }
      this.failedGoal = null;
      this.failedFrom = null;
      this.path = path;
      this.pathIdx = 1;
    }
    return this.path[this.pathIdx];
  }

  private recalculateSlotting(ticks: number): void {
    this.failedGoal = null;
    this.failedFrom = null;
    const owner = this.tank.owner();
    const rallyTile =
      this.tank.tankRallyTile() ?? this.factory?.tankRallyTile();
    const rallyKey = rallyTile ?? -1;

    let entry = slottingCache.get(owner);
    if (entry === undefined || entry.tick !== ticks) {
      entry = { tick: ticks, byRally: new Map() };
      slottingCache.set(owner, entry);
    }
    let assignment = entry.byRally.get(rallyKey);
    if (assignment === undefined) {
      assignment = this.computeAssignment(owner, rallyTile);
      entry.byRally.set(rallyKey, assignment);
    }

    const chosen = assignment.get(this.tank.id());
    if (chosen !== undefined) {
      if (this.targetWaypoint !== chosen) {
        this.targetWaypoint = chosen;
        // Invalidate route only when destination actually changed
        this.path = [];
        this.pathGoal = null;
        this.pathIdx = 0;
      }
    }
  }

  private computeAssignment(
    owner: Player,
    rallyTile: TileRef | undefined,
  ): Map<number, TileRef> {
    const assignment = new Map<number, TileRef>();
    const tanks = owner.units(UnitType.Tank).filter((u) => u.isActive());
    if (tanks.length === 0) return assignment;
    tanks.sort((a, b) => a.id() - b.id());

    const waypoints = computeHostileBorderWaypoints(
      this.mg,
      owner,
      tanks.length,
      rallyTile,
    );

    if (waypoints.length === 0) {
      return assignment;
    }

    // Deterministic greedy assignment using indexed flags to eliminate splice() overhead
    const used = new Uint8Array(waypoints.length);
    for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
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
        // All distinct waypoints used; assign nearest even if shared
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
    return assignment;
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
