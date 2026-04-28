import {
  Execution,
  Game,
  OwnerComp,
  Unit,
  UnitParamsMap,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";

export class JetExecution implements Execution {
  private mg!: Game;
  private jet!: Unit;
  private input: UnitParamsMap[UnitType.Jet] & OwnerComp;
  private survivedRoll: boolean = false;
  private rollCompleted: boolean = false;
  private pathFinder!: SteppingPathFinder<TileRef>;
  private startTick: number = -1;

  constructor(input: UnitParamsMap[UnitType.Jet] & OwnerComp) {
    this.input = input;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
    this.startTick = ticks;

    // Get a friendly runway to spawn at
    const runways = this.input.owner.units(UnitType.Runway);
    if (runways.length === 0) {
      return;
    }
    const spawnTile = runways[0].tile();

    // Jet costs 2,000,000 to launch
    const cost = 2000000n;
    if (this.input.owner.gold() < cost) {
      return;
    }
    this.input.owner.removeGold(cost);
    console.log("SEAD Launch: Cost deducted");

    this.jet = this.input.owner.buildUnit(UnitType.Jet, spawnTile, this.input);
    this.jet.setTargetable(false);
  }

  tick(ticks: number): void {
    if (!this.jet || !this.jet.isActive()) {
      return;
    }

    // Roll for survival once immediately or on first tick? The requirement says:
    // "On the server, roll a random number (0-100). If the roll is > 30, the jet survives."
    if (!this.rollCompleted) {
      this.rollCompleted = true;
      const roll = Math.floor(Math.random() * 101); // 0-100
      this.survivedRoll = roll > 30;
      if (this.survivedRoll) {
        console.log("SEAD Survival Roll: Success");
      } else {
        console.log("SEAD Survival Roll: Fail");
      }
    }

    const target = this.input.targetTile;
    const current = this.jet.tile();

    if (current === target) {
      // Reached target!
      if (!this.survivedRoll) {
        // Shot down at the target
        this.jet.delete();
        return;
      }

      // Execute strike!
      const targetUnits = this.mg.nearbyUnits(target, 0, [
        UnitType.SAMLauncher,
        UnitType.City,
        UnitType.Factory,
        UnitType.Port,
        UnitType.DefensePost,
        UnitType.MissileSilo,
        UnitType.Runway,
      ]);
      for (const u of targetUnits) {
        if (u.unit.tile() === target) {
          console.log(`SEAD Target Destroyed: ID_${u.unit.id()}`);
          u.unit.delete();
        }
      }

      this.jet.delete();
      return;
    }

    // Move jet towards target. It travels fast.
    // Speed ramps up from 1 to 4 to simulate take-off.
    const flightTicks = ticks - this.startTick;
    const speed = flightTicks < 10 ? 1 : 4;

    for (let i = 0; i < speed; i++) {
      const result = this.pathFinder.next(this.jet.tile(), target);
      if (result.status === PathStatus.COMPLETE) {
        break;
      } else if (result.status === PathStatus.NEXT) {
        this.jet.move(result.node);
      }
    }
  }

  isActive(): boolean {
    return this.jet?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
