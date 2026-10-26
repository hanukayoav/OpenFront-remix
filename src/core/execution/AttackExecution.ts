import { renderTroops } from "../../client/Utils";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  PlayerType,
  TankState,
  TerrainType,
  TerraNullius,
  UnitType,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { assertNever } from "../Util";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;
export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  // Specific connected land piece tiles of the defender, if targeted
  private targetPieceTiles: Set<TileRef> | null = null;

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    private targetTile: TileRef | null = null,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  public getAttack(): Attack | null {
    return this.attack;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
      this.targetTile,
    );

    if (
      this.targetTile !== null &&
      this.map.ownerID(this.targetTile) === this.targetSmallID
    ) {
      this.targetPieceTiles = this.computeConnectedPiece(this.targetTile);
    }

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null &&
        outgoing.sourceTile() === null &&
        this.attack.targetTile() === outgoing.targetTile()
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    if (this.target.isPlayer()) {
      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private computeConnectedPiece(startTile: TileRef): Set<TileRef> {
    const piece = new Set<TileRef>();
    const queue: TileRef[] = [startTile];
    piece.add(startTile);
    let head = 0;
    const scratch: TileRef[] = [0, 0, 0, 0];

    while (head < queue.length) {
      const curr = queue[head++];
      const numNeighbors = this.map.neighbors4(curr, scratch);
      for (let i = 0; i < numNeighbors; i++) {
        const neighbor = scratch[i];
        if (
          !piece.has(neighbor) &&
          this.map.isLand(neighbor) &&
          !this.map.isImpassable(neighbor) &&
          this.map.ownerID(neighbor) === this.targetSmallID
        ) {
          piece.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return piece;
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    for (const tile of this._owner.borderTiles()) {
      if (this.targetPieceTiles !== null) {
        let bordersPiece = false;
        const numNeighbors = this.map.neighbors4(tile, this.nbuf);
        for (let i = 0; i < numNeighbors; i++) {
          if (this.targetPieceTiles.has(this.nbuf[i])) {
            bordersPiece = true;
            break;
          }
        }
        if (!bordersPiece) {
          continue;
        }
      }
      this.addNeighbors(tile);
    }
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    let numTilesPerTick = this.mg
      .config()
      .attackTilesPerTick(
        troopCount,
        this._owner,
        this.target,
        this.attack.borderSize() + this.random.nextInt(0, 5),
      );

    // Tank (vanguard) effects need spatial queries per conquered tile. Most
    // players own no tanks, so check once per tick and skip those queries
    // entirely. Tanks can't be created mid-loop, so this stays accurate.
    const hasTanks = this._owner.units(UnitType.Tank).length > 0;
    const tankFiringRange = hasTanks ? this.mg.config().tankFiringRange() : 0;

    while (numTilesPerTick > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tilesPerTickUsed } = this.mg
        .config()
        .attackLogic(
          this.mg,
          troopCount,
          this._owner,
          this.target,
          tileToConquer,
        );
      // Vanguard Covering Fire
      let finalAttackerLoss = attackerTroopLoss;
      const hasVanguard =
        hasTanks &&
        this.mg.nearbyUnits(
          tileToConquer,
          tankFiringRange,
          UnitType.Tank,
          ({ unit }) => unit.owner() === this._owner && unit.isActive(),
        ).length > 0;
      if (hasVanguard) {
        const reduction = this.mg.config().tankVanguardCasualtyReduction();
        finalAttackerLoss = Math.floor(attackerTroopLoss * (1 - reduction));

        if (targetPlayer) {
          const posts = this.mg.nearbyUnits(
            tileToConquer,
            this.mg.config().defensePostRange(),
            UnitType.DefensePost,
            ({ unit }) => unit.owner() === targetPlayer && unit.isActive(),
          );
          for (const post of posts) {
            post.unit.modifyHealth(-50, this._owner);
          }
        }
      }

      numTilesPerTick -= tilesPerTickUsed;
      troopCount -= finalAttackerLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      if (this.targetPieceTiles !== null) {
        this.targetPieceTiles.delete(tileToConquer);
      }

      // Vanguard Spearhead Advance
      if (!hasTanks) {
        this.handleDeadDefender();
        continue;
      }
      const nearbyAdvanceTanks = this.mg.nearbyUnits(
        tileToConquer,
        2,
        UnitType.Tank,
        ({ unit }) =>
          unit.owner() === this._owner &&
          unit.isActive() &&
          unit.tankState() !== TankState.Spearheading &&
          unit.tile() !== tileToConquer,
      );
      if (nearbyAdvanceTanks.length > 0) {
        nearbyAdvanceTanks.sort(
          (a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id(),
        );
        const vanguardTank = nearbyAdvanceTanks[0].unit;
        vanguardTank.move(tileToConquer);
        vanguardTank.setTankState(TankState.Spearheading);
      }

      this.handleDeadDefender();
    }
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID ||
        (this.targetPieceTiles !== null && !this.targetPieceTiles.has(neighbor))
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }
}
