import { Execution, Game, Player, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

export class SetTankRallyPointExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private rallyTile: TileRef | null,
    private factoryUnitId?: number,
  ) {}

  init(mg: Game, ticks: number): void {
    if (this.factoryUnitId !== undefined) {
      const unit = mg.unit(this.factoryUnitId);
      if (
        unit &&
        unit.owner() === this.player &&
        unit.type() === UnitType.TankFactory
      ) {
        unit.setTankRallyTile(this.rallyTile ?? undefined);
      }
    } else {
      for (const factory of this.player.units(UnitType.TankFactory)) {
        factory.setTankRallyTile(this.rallyTile ?? undefined);
      }
    }
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
