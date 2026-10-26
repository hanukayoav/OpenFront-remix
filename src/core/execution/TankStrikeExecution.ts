import { Execution, Game, Player, Structures, TankState, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { TankShellExecution } from "./TankShellExecution";

export class TankStrikeExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private targetTile: TileRef,
    private targetUnitId?: string,
  ) {}

  init(mg: Game, ticks: number): void {
    const firingRange = mg.config().tankFiringRange();

    // Find all friendly active tanks within firing range
    const nearby = mg.nearbyUnits(
      this.targetTile,
      firingRange,
      UnitType.Tank,
      ({ unit }) => unit.owner() === this.player && unit.isActive(),
    );

    // Filter ready tanks (cooldown <= 0)
    const readyTanks = nearby.filter((t) => t.unit.tankCooldown() === 0);
    if (readyTanks.length === 0) {
      // Out of range or on cooldown
      this.active = false;
      return;
    }

    // Pick nearest ready tank (tie-break by unit ID for determinism)
    readyTanks.sort(
      (a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id(),
    );
    const firingTank = readyTanks[0].unit;

    // Enforce reload cooldown and aiming/reloading state
    firingTank.setTankCooldown(mg.config().tankReloadTicks());
    firingTank.setTankState(TankState.Reloading);

    // Turret aiming angle calculation (degrees)
    const map = mg.map();
    const dx = map.x(this.targetTile) - map.x(firingTank.tile());
    const dy = map.y(this.targetTile) - map.y(firingTank.tile());
    const angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    firingTank.setTurretAngle(angle);

    // Resolve target unit if provided or target structure
    let targetUnit: Unit | undefined;
    if (this.targetUnitId) {
      const idNum = Number(this.targetUnitId);
      if (!isNaN(idNum)) {
        const u = mg.unit(idNum);
        if (
          u &&
          u.isActive() &&
          u.owner() !== this.player &&
          !this.player.isFriendly(u.owner() as Player)
        ) {
          targetUnit = u;
        }
      }
    }
    if (!targetUnit) {
      const nearbyStructs = mg.nearbyUnits(
        this.targetTile,
        1,
        Structures.types,
        ({ unit }) =>
          unit.owner() !== this.player &&
          !this.player.isFriendly(unit.owner() as Player),
      );
      targetUnit = nearbyStructs[0]?.unit;
    }

    // Launch ballistic armor-piercing tank shell
    mg.addExecution(
      new TankShellExecution(
        firingTank,
        this.player,
        firingTank.tile(),
        this.targetTile,
        targetUnit,
      ),
    );

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
