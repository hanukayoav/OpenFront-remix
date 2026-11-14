import { beforeEach, describe, expect, test } from "vitest";
import {
  ClaimSupplyDropExecution,
  SupplyDropExecution,
} from "../src/core/execution/SupplyDropExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import {
  GameUpdateType,
  SupplyDropEventUpdate,
} from "../src/core/game/GameUpdates";
import { SupplyDropFrequency } from "../src/core/Schemas";
import { setup } from "./util/Setup";

describe("Fix 4: Authoritative Deterministic SupplyDropExecution", () => {
  let game: Game;
  let human: Player;
  let botA: Player;
  let botB: Player;
  let nation: Player;
  let sde: SupplyDropExecution;

  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("human", PlayerType.Human, "client_h", "human_id"),
      new PlayerInfo("botA", PlayerType.Bot, null, "bota_id"),
      new PlayerInfo("botB", PlayerType.Bot, null, "botb_id"),
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    ]);
    human = game.player("human_id");
    botA = game.player("bota_id");
    botB = game.player("botb_id");
    nation = game.player("nation_id");

    human.conquer(game.ref(10, 10));
    botA.conquer(game.ref(20, 20));
    botB.conquer(game.ref(30, 30));
    nation.conquer(game.ref(40, 40));

    sde = new SupplyDropExecution("test_game_supply", 450, 2, 10);
    sde.init(game, 0);
  });

  test("does NOT collect while descending, then auto-collects ONCE for owning AI (Bots & Nations)", () => {
    const startGoldA = botA.gold();
    const startTroopsA = botA.troops();

    const drop = sde.spawnDropAt(game.ref(20, 20), 0);
    expect(drop.state).toBe("descending");

    // Ticks 0..9: still descending -> NO collection!
    for (let t = 0; t < 10; t++) {
      sde.tick(t);
    }
    expect(botA.gold()).toBe(startGoldA);
    expect(botA.troops()).toBe(startTroopsA);
    expect(sde.getActiveDrops().length).toBe(1);

    // Tick 10: descent complete -> AI auto-collects once!
    sde.tick(10);
    expect(sde.getActiveDrops().length).toBe(0);
    expect(botA.gold()).toBe(startGoldA + BigInt(drop.gold));
    expect(botA.troops()).toBe(startTroopsA + drop.troops);

    // Subsequent ticks must never award duplicate rewards
    sde.tick(11);
    sde.tick(12);
    expect(botA.gold()).toBe(startGoldA + BigInt(drop.gold));
    expect(botA.troops()).toBe(startTroopsA + drop.troops);

    // AI Nations (PlayerType.FakeHuman) also auto-collect identically
    const startGoldN = nation.gold();
    const nationDrop = sde.spawnDropAt(game.ref(40, 40), 20);
    for (let t = 20; t <= 30; t++) sde.tick(t);
    expect(nation.gold()).toBe(startGoldN + BigInt(nationDrop.gold));
  });

  test("neutral territory never auto-claims; AI conquering neutral drop claims after landing", () => {
    const neutralTile = game.ref(50, 50);
    const drop = sde.spawnDropAt(neutralTile, 0);

    // Finish descent & remain on neutral land for several ticks
    for (let t = 0; t <= 20; t++) sde.tick(t);
    expect(sde.getActiveDrops().length).toBe(1);
    expect(drop.state).toBe("landed");

    // Now Bot B conquers the neutral tile!
    const beforeGoldB = botB.gold();
    const beforeTroopsB = botB.troops();
    botB.conquer(neutralTile);
    sde.tick(21);

    expect(sde.getActiveDrops().length).toBe(0);
    expect(botB.gold()).toBe(beforeGoldB + BigInt(drop.gold));
    expect(botB.troops()).toBe(beforeTroopsB + drop.troops);
  });

  test("handles ownership changes during descent and awards final landed AI owner", () => {
    const contestedTile = game.ref(25, 25);
    botA.conquer(contestedTile);

    const beforeGoldA = botA.gold();
    const beforeGoldB = botB.gold();

    const drop = sde.spawnDropAt(contestedTile, 0);
    sde.tick(2);
    expect(botA.gold()).toBe(beforeGoldA); // Still descending

    // Ownership shifts to Bot B mid-descent
    botB.conquer(contestedTile);
    for (let t = 3; t <= 10; t++) sde.tick(t);

    expect(sde.getActiveDrops().length).toBe(0);
    expect(botA.gold()).toBe(beforeGoldA);
    expect(botB.gold()).toBe(beforeGoldB + BigInt(drop.gold));
  });

  test("human retains manual click/tap collection, blocks descending/enemy/neutral claims, prevents duplicates", () => {
    const hTile = game.ref(10, 10);
    const drop = sde.spawnDropAt(hTile, 0);
    const beforeGoldH = human.gold();
    const beforeTroopsH = human.troops();

    // Finish descent
    for (let t = 0; t <= 15; t++) sde.tick(t);
    // Human does NOT auto-claim automatically
    expect(sde.getActiveDrops().length).toBe(1);
    expect(human.gold()).toBe(beforeGoldH);

    // Enemy trying to claim human's tile fails
    const invalidEnemyClaim = new ClaimSupplyDropExecution(
      botB,
      drop.id,
      hTile,
    );
    invalidEnemyClaim.init(game, 16);
    expect(sde.getActiveDrops().length).toBe(1);

    // Human claims once landed -> succeeds cleanly once
    const validHumanClaim = new ClaimSupplyDropExecution(human, drop.id, hTile);
    validHumanClaim.init(game, 17);
    expect(sde.getActiveDrops().length).toBe(0);
    expect(human.gold()).toBe(beforeGoldH + BigInt(drop.gold));
    expect(human.troops()).toBe(beforeTroopsH + drop.troops);

    // Duplicate click/intent fails cleanly with zero duplicate rewards
    const duplicateHumanClaim = new ClaimSupplyDropExecution(
      human,
      drop.id,
      hTile,
    );
    duplicateHumanClaim.init(game, 18);
    expect(human.gold()).toBe(beforeGoldH + BigInt(drop.gold));
    expect(human.troops()).toBe(beforeTroopsH + drop.troops);

    // Clicking while descending must fail
    const descDrop = sde.spawnDropAt(hTile, 20);
    const premature = new ClaimSupplyDropExecution(human, descDrop.id, hTile);
    premature.init(game, 22);
    expect(sde.getActiveDrops().length).toBe(1);
    expect(human.gold()).toBe(beforeGoldH + BigInt(drop.gold));
  });

  test("deterministic identical supply drop spawn & AI claim across two peer simulations", async () => {
    const peerGame1 = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("bot1", PlayerType.Bot, null, "b1"),
      new PlayerInfo("bot2", PlayerType.Bot, null, "b2"),
    ]);
    const peerGame2 = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("bot1", PlayerType.Bot, null, "b1"),
      new PlayerInfo("bot2", PlayerType.Bot, null, "b2"),
    ]);

    for (const pg of [peerGame1, peerGame2]) {
      for (let y = 10; y < 30; y++) {
        for (let x = 10; x < 30; x++) {
          pg.player("b1").conquer(pg.ref(x, y));
        }
      }
    }

    const sde1 = new SupplyDropExecution("multiplayer_seed_99", 50, 2, 10);
    const sde2 = new SupplyDropExecution("multiplayer_seed_99", 50, 2, 10);
    sde1.init(peerGame1, 0);
    sde2.init(peerGame2, 0);

    for (let t = 0; t <= 120; t++) {
      sde1.tick(t);
      sde2.tick(t);
    }

    expect(peerGame1.player("b1").gold()).toBe(peerGame2.player("b1").gold());
    expect(peerGame1.player("b1").troops()).toBe(
      peerGame2.player("b1").troops(),
    );
    expect(sde1.getActiveDrops()).toEqual(sde2.getActiveDrops());
  });

  test.each<{
    label: string;
    frequency?: SupplyDropFrequency;
    expectedInterval: number;
    expectedMaxCrates: number;
    expectedSpawnTicks: number[];
    totalTicks: number;
  }>([
    {
      label: "default (normal)",
      frequency: undefined,
      expectedInterval: 450,
      expectedMaxCrates: 2,
      expectedSpawnTicks: [450, 900],
      totalTicks: 1400,
    },
    {
      label: "normal",
      frequency: "normal",
      expectedInterval: 450,
      expectedMaxCrates: 2,
      expectedSpawnTicks: [450, 900],
      totalTicks: 1400,
    },
    {
      label: "rapid",
      frequency: "rapid",
      expectedInterval: 200,
      expectedMaxCrates: 2,
      expectedSpawnTicks: [200, 400],
      totalTicks: 700,
    },
    {
      label: "extreme",
      frequency: "extreme",
      expectedInterval: 200,
      expectedMaxCrates: 3,
      expectedSpawnTicks: [200, 400, 600],
      totalTicks: 900,
    },
  ])(
    "respects configured frequency and max crates for $label mode",
    async ({
      frequency,
      expectedInterval,
      expectedMaxCrates,
      expectedSpawnTicks,
      totalTicks,
    }) => {
      const cfgGame = await setup(
        "plains",
        {
          instantBuild: true,
          ...(frequency ? { supplyDropFrequency: frequency } : {}),
        },
        [new PlayerInfo("human", PlayerType.Human, "client_h", "human_id")],
      );

      // Human owns land only indirectly; unclaimed drops stay active to test crate cap
      const exec = new SupplyDropExecution(
        `freq_test_${frequency ?? "default"}`,
      );
      cfgGame.addExecution(exec);
      // Wait for init on tick 0
      cfgGame.executeNextTick();

      expect(exec.getEvaluationIntervalTicks()).toBe(expectedInterval);
      expect(exec.getMaxActiveCrates()).toBe(expectedMaxCrates);

      const spawnTicks: number[] = [];
      for (let t = 1; t <= totalTicks; t++) {
        const updates = cfgGame.executeNextTick();
        const events = updates[GameUpdateType.SupplyDropEvent] as
          | SupplyDropEventUpdate[]
          | undefined;
        if (events) {
          for (const ev of events) {
            if (ev.action === "spawn") {
              spawnTicks.push(t);
            }
          }
        }
      }

      expect(spawnTicks).toEqual(expectedSpawnTicks);
      expect(exec.getActiveDrops().length).toBe(expectedMaxCrates);
    },
  );
});
