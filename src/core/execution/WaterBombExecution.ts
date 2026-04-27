import { Execution, Game, Player, Unit, UnitType } from "../game/Game";

export class WaterBombExecution implements Execution {
  private active: boolean = true;

  constructor(private readonly waterBomb: Unit) {}

  isActive(): boolean {
    return this.waterBomb.isActive() && this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(game: Game): void {}

  tick(ticks: number, game: Game): void {
    if (!this.waterBomb.isActive()) {
      this.active = false;
      return;
    }
    
    // Check for enemy ships on this tile
    const ships = game.nearbyUnits(
      this.waterBomb.tile(), 
      0, 
      [UnitType.Warship, UnitType.TransportShip, UnitType.TradeShip]
    );
    
    for (const { unit } of ships) {
      if (unit.owner().isPlayer() && 
          unit.owner() !== this.waterBomb.owner() && 
          !unit.owner().isFriendly(this.waterBomb.owner())) {
          
        // take 75% of max health as damage
        const maxHealth = unit.info().maxHealth ?? 1000;
        const damage = Math.max(1, Math.floor(maxHealth * 0.75));
        unit.modifyHealth(-damage, this.waterBomb.owner());
        
        // destroy the water bomb
        this.waterBomb.delete(false, unit.owner());
        this.active = false;
        break;
      }
    }
  }
}
