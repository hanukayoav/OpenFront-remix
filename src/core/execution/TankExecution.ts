import { Execution, Game, Player, TankState, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap";

/**
 * A* over passable land. Uses a binary heap for the open set (the previous
 * version linearly scanned a Set for the min-F node, which was O(N^2) over up
 * to 10k expansions and ran for every moving tank every tick).
 */
export function findTankPath(
  mg: Game,
  start: TileRef,
  goal: TileRef,
  owner: Player,
): TileRef[] | null {
  if (start === goal) return [start];
  const map = mg.map();
  const goalX = map.x(goal);
  const goalY = map.y(goal);

  const h = (tile: TileRef) =>
    Math.abs(map.x(tile) - goalX) + Math.abs(map.y(tile) - goalY);

  const gScore = new Map<TileRef, number>();
  const cameFrom = new Map<TileRef, TileRef>();
  const closed = new Set<TileRef>();
  const open = new FlatBinaryHeap(256);
  gScore.set(start, 0);
  open.enqueue(start, h(start));

  const nbuf: TileRef[] = [0, 0, 0, 0];
  let iterations = 0;
  const maxIterations = 10000;

  while (open.size() > 0 && iterations < maxIterations) {
    const current = open.dequeue();
    // Lazy deletion: a node can be queued several times as its g improves.
    if (closed.has(current)) continue;
    iterations++;

    if (current === goal) {
      const path: TileRef[] = [goal];
      let curr = goal;
      while (cameFrom.has(curr)) {
        curr = cameFrom.get(curr)!;
        path.push(curr);
      }
      path.reverse();
      return path;
    }

    closed.add(current);
    const currentG = gScore.get(current)!;

    const count = map.neighbors4(current, nbuf);
    for (let i = 0; i < count; i++) {
      const neighbor = nbuf[i];
      if (closed.has(neighbor)) continue;
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
      const prevG = gScore.get(neighbor);
      if (prevG === undefined || tentativeG < prevG) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        open.enqueue(neighbor, tentativeG + h(neighbor));
      }
    }
  }

  return null;
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

  for (const b of borderTiles) {
    let isEnemy = false;
    let isNeutral = false;
    let isCoast = false;
    const count = map.neighbors4(b, nbuf);
    for (let i = 0; i < count; i++) {
      const n = nbuf[i];
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

  // 2. Order into connected chains
  const unvisited = new Set<TileRef>(candidateTiles);
  const ordered: TileRef[] = [];

  while (unvisited.size > 0) {
    let startNode: TileRef = -1;
    let minDegree = 999;
    let minCoord = 99999999;

    for (const tile of unvisited) {
      let degree = 0;
      const count = map.neighbors4(tile, nbuf);
      for (let i = 0; i < count; i++) {
        if (unvisited.has(nbuf[i])) degree++;
      }
      if (degree < minDegree || (degree === minDegree && tile < minCoord)) {
        minDegree = degree;
        minCoord = tile;
        startNode = tile;
        if (degree === 0) break; // isolated node cannot have lower degree
      }
    }

    let curr: TileRef | null = startNode;
    while (curr !== null) {
      unvisited.delete(curr);
      ordered.push(curr);

      let next: TileRef | null = null;
      let nextCoord = 99999999;
      const count = map.neighbors4(curr, nbuf);
      for (let i = 0; i < count; i++) {
        const neighbor = nbuf[i];
        if (unvisited.has(neighbor) && neighbor < nextCoord) {
          nextCoord = neighbor;
          next = neighbor;
        }
      }
      curr = next;
    }
  }

  const N = ordered.length;
  if (numTanks >= N) {
    return ordered.slice();
  }

  // 3. Spacing calculation
  // If rally point is set, prioritize section nearest rally point
  if (rallyTile !== undefined && mg.isValidRef(rallyTile)) {
    ordered.sort(
      (a, b) =>
        mg.manhattanDist(a, rallyTile) - mg.manhattanDist(b, rallyTile),
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
    if (
      (ticks % SLOTTING_INTERVAL === 0 && ticks !== this.lastSlottingTick) ||
      this.targetWaypoint === null ||
      !this.mg.hasOwner(this.targetWaypoint) ||
      this.mg.owner(this.targetWaypoint) !== this.tank.owner()
    ) {
      this.lastSlottingTick = ticks;
      this.recalculateSlotting(ticks);
      // Re-plan on the slotting cadence so routes adapt to territory changes
      // (enemy land is costlier) without paying for A* every tick.
      this.path = [];
    }

    // 4. Movement along path to target waypoint
    if (this.targetWaypoint !== null && this.tank.tile() !== this.targetWaypoint) {
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
    } else if (this.targetWaypoint !== null && this.tank.tile() === this.targetWaypoint) {
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
      this.targetWaypoint = chosen;
    }
  }

  private computeAssignment(
    owner: Player,
    rallyTile: TileRef | undefined,
  ): Map<number, TileRef> {
    const assignment = new Map<number, TileRef>();
    const tanks = owner.units(UnitType.Tank).filter((u) => u.isActive());
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

    // Deterministic greedy assignment
    const available = [...waypoints];
    for (const t of tanks) {
      if (available.length === 0) break;
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < available.length; i++) {
        const d = this.mg.manhattanDist(t.tile(), available[i]);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      assignment.set(t.id(), available.splice(closestIdx, 1)[0]);
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
