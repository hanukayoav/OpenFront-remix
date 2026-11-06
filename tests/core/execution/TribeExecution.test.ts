import { describe, expect, test } from "vitest";
import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { TribeExecution } from "../../../src/core/execution/TribeExecution";
import { setup } from "../../util/Setup";

describe("TribeExecution (Bot Functionality & Strategic AI)", () => {
  test("tribe initializes and sends expansion attack into TerraNullius", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
    });

    const tribePlayer = game.addPlayer(
      new PlayerInfo("BotAlpha", PlayerType.Bot, null, "bot_1"),
    );

    // Give tribe a 3x3 territory in the middle of plains
    const center = game.ref(10, 10);
    tribePlayer.conquer(center);
    game.forEachNeighbor(center, (n) => tribePlayer.conquer(n));

    // Grant troops above the expansion threshold (maxTroops * expandRatio ~ 5000-8000)
    tribePlayer.setTroops(25000);

    const tribeExec = new TribeExecution(tribePlayer);
    tribeExec.init(game);

    const attackTick = (tribeExec as unknown as { attackTick: number }).attackTick;
    tribeExec.tick(attackTick);

    // Process queued executions
    game.executeNextTick();

    const attacks = tribePlayer.outgoingAttacks();
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    const firstAttack = attacks[0];
    expect(firstAttack.attacker()).toBe(tribePlayer);
    expect(firstAttack.target()).toBe(game.terraNullius());
  });

  test("tribe expands into unclaimed territory across multiple cycles", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
    });

    const tribePlayer = game.addPlayer(
      new PlayerInfo("BotBeta", PlayerType.Bot, null, "bot_2"),
    );

    const center = game.ref(15, 15);
    tribePlayer.conquer(center);
    game.forEachNeighbor(center, (n) => tribePlayer.conquer(n));
    tribePlayer.setTroops(25000);

    const tribeExec = new TribeExecution(tribePlayer);
    tribeExec.init(game);

    const attackRate = (tribeExec as unknown as { attackRate: number }).attackRate;
    const attackTick = (tribeExec as unknown as { attackTick: number }).attackTick;

    // First cycle
    tribeExec.tick(attackTick);
    game.executeNextTick();

    // Clear initial attack
    while (tribePlayer.outgoingAttacks().length > 0) {
      tribePlayer.outgoingAttacks()[0].delete();
    }

    // Second cycle
    tribePlayer.setTroops(25000);
    tribeExec.tick(attackTick + attackRate);
    game.executeNextTick();

    const attacks = tribePlayer.outgoingAttacks();
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    expect(attacks[0].target()).toBe(game.terraNullius());
  });

  test("tribe retaliates against an incoming attacker", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Hard,
    });

    const tribePlayer = game.addPlayer(
      new PlayerInfo("DefenderBot", PlayerType.Bot, null, "bot_def"),
    );
    const enemyPlayer = game.addPlayer(
      new PlayerInfo("AggressorHuman", PlayerType.Human, "client_1", "human_1"),
    );

    const t1 = game.ref(5, 5);
    const t2 = game.ref(6, 5);
    tribePlayer.conquer(t1);
    enemyPlayer.conquer(t2);

    tribePlayer.setTroops(25000);
    enemyPlayer.setTroops(2000);

    // Simulate incoming attack from enemyPlayer to tribePlayer
    const incomingAttack = new AttackExecution(500, enemyPlayer, tribePlayer.id());
    game.addExecution(incomingAttack);
    game.executeNextTick();

    expect(tribePlayer.incomingAttacks().length).toBeGreaterThanOrEqual(1);

    const tribeExec = new TribeExecution(tribePlayer);
    tribeExec.init(game);

    const attackRate = (tribeExec as unknown as { attackRate: number }).attackRate;
    const attackTick = (tribeExec as unknown as { attackTick: number }).attackTick;
    tribeExec.tick(attackTick + attackRate);
    game.executeNextTick();

    const retaliationAttacks = tribePlayer.outgoingAttacks().filter(
      (a) => a.target() === enemyPlayer,
    );
    expect(retaliationAttacks.length).toBeGreaterThanOrEqual(1);
  });

  test("tribe avoids wasteful attack against significantly superior opponents", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Hard,
    });

    const tribePlayer = game.addPlayer(
      new PlayerInfo("SmallBot", PlayerType.Bot, null, "bot_small"),
    );
    const giantEnemy = game.addPlayer(
      new PlayerInfo("GiantEnemy", PlayerType.Human, "client_g", "human_g"),
    );

    const t1 = game.ref(20, 20);
    const t2 = game.ref(21, 20);
    tribePlayer.conquer(t1);
    giantEnemy.conquer(t2);

    // Bot has only 50 troops, giant has 500,000 troops
    tribePlayer.setTroops(50);
    giantEnemy.setTroops(500000);

    const tribeExec = new TribeExecution(tribePlayer);
    tribeExec.init(game);

    const attackRate = (tribeExec as unknown as { attackRate: number }).attackRate;
    const attackTick = (tribeExec as unknown as { attackTick: number }).attackTick;
    tribeExec.tick(attackTick + attackRate);
    game.executeNextTick();

    // Tribe must NOT attack the giant enemy with a suicide attack
    const suicidalAttacks = tribePlayer.outgoingAttacks().filter(
      (a) => a.target() === giantEnemy,
    );
    expect(suicidalAttacks).toHaveLength(0);
  });

  test("tribe continues participating and does not freeze after borders close", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
    });

    const tribe = game.addPlayer(
      new PlayerInfo("ActiveBot", PlayerType.Bot, null, "bot_active"),
    );
    const neighbor = game.addPlayer(
      new PlayerInfo("NeighborBot", PlayerType.Bot, null, "bot_neighbor"),
    );

    tribe.conquer(game.ref(10, 10));
    neighbor.conquer(game.ref(11, 10));

    tribe.setTroops(25000);
    neighbor.setTroops(5000);

    const tribeExec = new TribeExecution(tribe);
    tribeExec.init(game);

    expect(tribeExec.isActive()).toBe(true);

    const attackRate = (tribeExec as unknown as { attackRate: number }).attackRate;
    const attackTick = (tribeExec as unknown as { attackTick: number }).attackTick;

    // Simulate multiple tick cycles
    for (let cycle = 0; cycle <= 3; cycle++) {
      tribe.setTroops(25000);
      tribeExec.tick(cycle * attackRate + attackTick);
      game.executeNextTick();
      expect(tribeExec.isActive()).toBe(true);
    }
  });
});
