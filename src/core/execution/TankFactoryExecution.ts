import { Execution, Game, Unit, UnitType } from "../game/Game";
import { TankExecution } from "./TankExecution";

export class TankFactoryExecution implements Execution {
  private active = true;
  private game: Game;
  private tanks: Unit[] = [];
  private productionProgress = 0;
  private isBuilding = false;

  constructor(private factory: Unit) {}

  init(mg: Game, ticks: number): void {
    this.game = mg;
  }

  tick(ticks: number): void {
    if (!this.factory.isActive() || !this.factory.owner().isAlive()) {
      this.active = false;
      return;
    }

    const tile = this.factory.tile();
    if (tile === null) {
      return;
    }

    // Compact active tanks in-place to avoid per-tick array allocations
    let activeCount = 0;
    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i];
      if (t.isActive()) {
        this.tanks[activeCount++] = t;
      }
    }
    this.tanks.length = activeCount;

    const maxTanks = this.game.config().tankMaxPerFactory();
    const goldCost = this.game.config().tankProductionGoldCost();
    const troopCost = this.game.config().tankTroopCost();
    const buildDuration = this.game.config().tankBuildDurationTicks();
    const owner = this.factory.owner();

    // Advance ongoing production
    if (this.isBuilding) {
      this.productionProgress++;
      if (this.productionProgress >= buildDuration) {
        this.spawnTank();
        this.isBuilding = false;
        this.productionProgress = 0;
      }
    }

    // Start production if capacity is available
    while (!this.isBuilding && this.tanks.length < maxTanks) {
      if (owner.gold() >= goldCost && owner.troops() >= troopCost) {
        owner.removeGold(goldCost);
        owner.removeTroops(troopCost);
        if (buildDuration === 0) {
          this.spawnTank();
        } else {
          this.isBuilding = true;
          this.productionProgress = 0;
          break;
        }
      } else {
        break;
      }
    }
  }

  private spawnTank(): Unit {
    const tile = this.factory.tile()!;
    const tank = this.factory
      .owner()
      .buildUnit(UnitType.Tank, tile, { factoryId: this.factory.id() });
    this.game.addExecution(new TankExecution(tank, this.factory));
    this.tanks.push(tank);
    return tank;
  }

  getTanks(): Unit[] {
    return [...this.tanks];
  }

  isProducing(): boolean {
    return this.isBuilding;
  }

  getProgress(): number {
    return this.productionProgress;
  }

  getFactory(): Unit {
    return this.factory;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
