import { Execution, Game, Player, Structures, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";

export class TankShellExecution implements Execution {
  private active = true;
  private pathFinder: SteppingPathFinder<TileRef>;
  private shell: Unit | undefined;
  private mg: Game;

  constructor(
    private firingTank: Unit,
    private _owner: Player,
    private spawn: TileRef,
    private targetTile: TileRef,
    private targetUnit?: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.shell ??= this._owner.buildUnit(UnitType.TankShell, this.spawn, {
      targetTile: this.targetTile,
      targetUnit: this.targetUnit,
    });
    if (!this.shell.isActive()) {
      this.active = false;
      return;
    }

    const speed = this.mg.config().tankShellSpeed(); // 3 tiles per tick
    for (let i = 0; i < speed; i++) {
      const result = this.pathFinder.next(
        this.shell.tile(),
        this.targetTile,
      );
      if (result.status === PathStatus.COMPLETE) {
        this.active = false;
        this.onImpact();
        this.shell.setReachedTarget();
        this.shell.delete(false);
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.shell.move(result.node);
      } else {
        this.active = false;
        this.shell.delete(false);
        return;
      }
    }
  }

  private onImpact(): void {
    const structDamage = this.mg.config().tankStructureDamage();

    // 1. Structural Damage: Target unit or any enemy structure at targetTile
    let targetStruct: Unit | undefined;
    if (
      this.targetUnit &&
      this.targetUnit.isActive() &&
      this.targetUnit.owner() !== this._owner &&
      !this._owner.isFriendly(this.targetUnit.owner())
    ) {
      targetStruct = this.targetUnit;
    } else {
      const nearbyStructs = this.mg.nearbyUnits(
        this.targetTile,
        1,
        Structures.types,
        ({ unit }) =>
          unit.owner() !== this._owner &&
          !this._owner.isFriendly(unit.owner() as Player),
      );
      targetStruct = nearbyStructs[0]?.unit;
    }

    if (targetStruct && targetStruct.isActive()) {
      if (targetStruct.hasHealth()) {
        targetStruct.modifyHealth(-structDamage, this._owner);
      } else {
        targetStruct.decreaseLevel(this._owner);
      }
    }

    // 2. Defending troop cluster splash damage
    const tileOwner = this.mg.owner(this.targetTile);
    if (tileOwner.isPlayer() && !this._owner.isFriendly(tileOwner)) {
      const splashTroops = Math.min(tileOwner.troops(), 500);
      tileOwner.removeTroops(splashTroops);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
