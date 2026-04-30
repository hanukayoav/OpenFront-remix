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

    // Check for warships within radius (16 euclidean distance squared, approx 4 tiles)
    const ships = this.game.nearbyUnits(this.waterBomb.tile(), 16, [
      UnitType.Warship,
    ]);

    for (const { unit } of ships) {
      // We only care about warships from players/bots that are not friendly
      const isFriendly =
        unit.owner() === this.waterBomb.owner() ||
        unit.owner().isFriendly(this.waterBomb.owner());

      if (!isFriendly) {
        // Enemy warship takes significant damage (e.g., 100% of health to ensure destruction)
        const maxHealth = unit.info().maxHealth ?? 1000;
        const damage = maxHealth;
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
