import { Execution, Game, Unit, UnitType } from "../game/Game";

export class WaterBombExecution implements Execution {
  private active: boolean = true;
  private game: Game;

  constructor(private readonly waterBomb: Unit) {}

  isActive(): boolean {
    return this.waterBomb.isActive() && this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(game: Game, ticks: number): void {
    this.game = game;
  }

  tick(ticks: number): void {
    if (!this.waterBomb.isActive()) {
      this.active = false;
      return;
    }

    // Check for ships within radius (16 euclidean distance squared, approx 4 tiles)
    const ships = this.game.nearbyUnits(this.waterBomb.tile(), 16, [
      UnitType.Warship,
      UnitType.TransportShip,
      UnitType.TradeShip,
    ]);

    for (const { unit } of ships) {
      if (!unit.owner().isPlayer()) continue;

      const isFriendly =
        unit.owner() === this.waterBomb.owner() ||
        unit.owner().isFriendly(this.waterBomb.owner());

      if (isFriendly) {
        // Friendly ship safely defuses/erases the bomb
        this.waterBomb.delete(true, unit.owner());
        this.active = false;
        break;
      } else {
        // Enemy ship takes 50% of max health as damage
        const maxHealth = unit.info().maxHealth ?? 1000;
        const damage = Math.max(1, Math.floor(maxHealth * 0.5));
        unit.modifyHealth(-damage, this.waterBomb.owner());

        // destroy the water bomb and trigger explosion visual
        this.waterBomb.setReachedTarget();
        this.waterBomb.delete(false, unit.owner());
        this.active = false;
        break;
      }
    }
  }
}
