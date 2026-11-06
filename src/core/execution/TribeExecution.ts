import { Execution, Game, Player, Structures } from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";
import { AllianceExtensionExecution } from "./alliance/AllianceExtensionExecution";
import { DeleteUnitExecution } from "./DeleteUnitExecution";
import { AiAttackBehavior } from "./utils/AiAttackBehavior";

export class TribeExecution implements Execution {
  private active = true;
  private random: PseudoRandom;
  private mg: Game;

  private attackBehavior: AiAttackBehavior | null = null;
  private attackRate: number;
  private attackTick: number;
  private triggerRatio: number;
  private reserveRatio: number;
  private expandRatio: number;

  constructor(private tribe: Player) {
    this.random = new PseudoRandom(simpleHash(tribe.id()));
    this.attackRate = this.random.nextInt(25, 50);
    this.attackTick = this.random.nextInt(0, this.attackRate);
    this.triggerRatio = this.random.nextInt(40, 55) / 100;
    this.reserveRatio = this.random.nextInt(25, 35) / 100;
    this.expandRatio = this.random.nextInt(10, 20) / 100;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game) {
    this.mg = mg;
    this.attackBehavior = new AiAttackBehavior(
      this.random,
      this.mg,
      this.tribe,
      this.triggerRatio,
      this.reserveRatio,
      this.expandRatio,
    );
  }

  tick(ticks: number) {
    if (ticks % this.attackRate !== this.attackTick) return;

    if (!this.tribe.isAlive()) {
      //removeOnDeath is called from tribe's PlayerExecution
      this.active = false;
      return;
    }

    this.acceptAllAllianceRequests();
    this.deleteNextStructure();
    this.maybeAttack();
  }

  private acceptAllAllianceRequests() {
    // Accept all alliance requests
    for (const req of this.tribe.incomingAllianceRequests()) {
      req.accept();
    }

    // Accept all alliance extension requests
    for (const alliance of this.tribe.alliances()) {
      // Alliance expiration tracked by Events Panel, only human ally can click Request to Renew
      // Skip if no expiration yet/ ally didn't request extension yet / tribe already agreed to extend
      if (!alliance.onlyOneAgreedToExtend()) continue;

      const human = alliance.other(this.tribe);
      this.mg.addExecution(
        new AllianceExtensionExecution(this.tribe, human.id()),
      );
    }
  }

  private deleteNextStructure() {
    if (!this.tribe.canDeleteUnit()) return;
    for (const unit of this.tribe.units()) {
      if (!Structures.has(unit.type())) continue;
      if (unit.isMarkedForDeletion()) continue;
      this.mg.addExecution(new DeleteUnitExecution(this.tribe, unit.id()));
      return;
    }
  }

  private maybeAttack() {
    if (this.attackBehavior === null) {
      throw new Error("not initialized");
    }

    // Leverage full strategic AI targeting pipeline (neutral expansion, victims, weak targets, retaliation, difficulty strategies)
    this.attackBehavior.maybeAttack();
  }

  isActive(): boolean {
    return this.active;
  }
}
