import { Game, OwnerComp, Unit, UnitParamsMap, UnitType } from "../game/Game";
import { Execution } from "./Execution";

export class JetExecution implements Execution {
  private mg!: Game;
  private jet!: Unit;
  private input: UnitParamsMap[UnitType.Jet] & OwnerComp;
  private survivedRoll: boolean = false;
  private rollCompleted: boolean = false;

  constructor(input: UnitParamsMap[UnitType.Jet] & OwnerComp) {
    this.input = input;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

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
      const sams = this.mg.units(UnitType.SAMLauncher);
      const targetSam = sams.find((u) => u.tile() === target);
      if (targetSam) {
        console.log(`SEAD Target Destroyed: SAM_ID_${targetSam.id()}`);
        targetSam.delete();
      }

      this.jet.delete();
      return;
    }

    // Move jet towards target. It travels fast.
    // Wait, AtomBomb has trajectory, jets could just step towards target tile linearly.
    // For simplicity, let's move it 3 tiles per tick towards the target.
    for (let i = 0; i < 3; i++) {
      if (this.jet.tile() === target) break;
      const nextTile = this.mg.step(this.jet.tile(), target);
      this.jet.move(nextTile);
    }
  }
}
