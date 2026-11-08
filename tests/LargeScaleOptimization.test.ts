import { describe, expect, test } from "vitest";
import {
  computeHostileBorderWaypoints,
  TankExecution,
} from "../src/core/execution/TankExecution";
import { TankFactoryExecution } from "../src/core/execution/TankFactoryExecution";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("LargeScaleOptimization Regression Suite (v1.0.3)", () => {
  test("waypoint allocation handles excess tanks gracefully without null assignments", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    const player = game.player("player_id");
    const enemy = game.player("enemy_id");
    player.addGold(50_000_000n);
    player.addTroops(100_000);

    // Establish a short border: 5 tiles
    for (let x = 10; x <= 14; x++) {
      player.conquer(game.ref(x, 10));
      enemy.conquer(game.ref(x, 9));
    }

    const waypoints = computeHostileBorderWaypoints(game, player, 5);
    expect(waypoints.length).toBe(5);

    // Create 25 tanks (5x more tanks than waypoints)
    const tanks: TankExecution[] = [];
    for (let i = 0; i < 25; i++) {
      const tile = game.ref(10 + (i % 5), 10);
      const unit = player.buildUnit(UnitType.Tank, tile, {});
      const te = new TankExecution(unit);
      te.init(game, 0);
      game.addExecution(te);
      tanks.push(te);
    }

    // In a scenario where tanks > waypoints, old code left tanks 5..24 with targetWaypoint === null.
    // Our fix replicates waypoints modulo N and assigns every single tank a valid target.
    for (let t = 0; t < 15; t++) {
      game.executeNextTick();
    }

    for (let i = 0; i < tanks.length; i++) {
      const te = tanks[i];
      if (te.isActive()) {
        const target = te.getTargetWaypoint();
        // The tank must have a valid targetWaypoint assigned
        expect(target).not.toBeNull();
      }
    }
  });

  test("100 factories and 500 tanks maintain strict production limits and execute within limits", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    const player = game.player("player_id");
    const enemy = game.player("enemy_id");
    player.addGold(1_000_000_000n);
    player.addTroops(10_000_000);

    // Give player a 50x50 territory
    for (let y = 10; y < 60; y++) {
      for (let x = 10; x < 60; x++) {
        player.conquer(game.ref(x, y));
      }
    }
    // Enemy border at y = 9
    for (let x = 10; x < 60; x++) {
      enemy.conquer(game.ref(x, 9));
    }

    // Build 100 tank factories
    const factoryExecutions: TankFactoryExecution[] = [];
    let count = 0;
    for (let y = 15; y < 55 && count < 100; y += 4) {
      for (let x = 15; x < 55 && count < 100; x += 4) {
        const tile = game.ref(x, y);
        const unit = player.buildUnit(UnitType.TankFactory, tile, {});
        const fe = new TankFactoryExecution(unit);
        fe.init(game, 0);
        game.addExecution(fe);
        factoryExecutions.push(fe);
        count++;
      }
    }
    expect(factoryExecutions.length).toBe(100);

    // Replenish player gold and troops after building 100 factories so they can produce tanks
    player.addGold(100_000_000n);
    player.addTroops(10_000_000);

    // Tick simulation to produce all tanks across all 100 factories
    for (let t = 0; t < 10; t++) {
      game.executeNextTick();
    }

    // Verify each factory respects capacity limit (<= 5 active tanks)
    let totalTanks = 0;
    for (const fe of factoryExecutions) {
      const tanks = fe.getTanks();
      expect(tanks.length).toBe(5);
      totalTanks += tanks.length;
    }
    expect(totalTanks).toBe(500);

    // Run 20 ticks and measure tick performance
    const start = performance.now();
    for (let t = 0; t < 20; t++) {
      game.executeNextTick();
    }
    const elapsed = performance.now() - start;
    const avgPerTick = elapsed / 20;
    // With optimization, 100 factories / 500 tanks execute very rapidly (< 15ms per full authoritative tick)
    expect(avgPerTick).toBeLessThan(15);
  });

  test("state cleanup after unit destruction and factory deletion releases memory without leaks", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    const player = game.player("player_id");
    player.addGold(500_000n);
    player.addTroops(50_000);

    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 20; x++) {
        player.conquer(game.ref(x, y));
      }
    }

    const factoryTile = game.ref(15, 15);
    const factoryUnit = player.buildUnit(UnitType.TankFactory, factoryTile, {});
    const factory = new TankFactoryExecution(factoryUnit);
    factory.init(game, 0);
    game.addExecution(factory);

    // Advance ticks to initialize and spawn 5 tanks
    game.executeNextTick();
    game.executeNextTick();

    const initialTanks = factory.getTanks();
    expect(initialTanks.length).toBe(5);

    // Deplete gold so factory compacts without instantly replacing
    player.removeGold(player.gold());

    // Destroy 3 tanks
    initialTanks[0].delete();
    initialTanks[1].delete();
    initialTanks[2].delete();

    // Advance 1 tick so factory compacts in-place
    game.executeNextTick();

    const remainingTanks = factory.getTanks();
    expect(remainingTanks.length).toBe(2);

    // Restore gold: factory should auto-replace back to 5
    player.addGold(500_000n);
    game.executeNextTick();
    expect(factory.getTanks().length).toBe(5);

    // Destroy factory itself
    factoryUnit.delete();
    game.executeNextTick();
    expect(factory.isActive()).toBe(false);
  });

  test("simulation determinism: identical initial states yield bit-for-bit identical outcomes", async () => {
    async function createAndRun() {
      const g = await setup("plains", { instantBuild: true }, [
        new PlayerInfo("player", PlayerType.Human, null, "player_id"),
        new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
      ]);
      const p = g.player("player_id");
      const e = g.player("enemy_id");
      p.addGold(500_000n);
      p.addTroops(50_000);

      for (let x = 10; x <= 20; x++) {
        p.conquer(g.ref(x, 10));
        e.conquer(g.ref(x, 9));
      }

      for (let i = 0; i < 5; i++) {
        const u = p.buildUnit(UnitType.Tank, g.ref(10 + i, 10), {});
        const te = new TankExecution(u);
        te.init(g, 0);
        g.addExecution(te);
      }

      for (let t = 0; t < 20; t++) {
        g.executeNextTick();
      }

      // Collect snapshot
      return g.units().map((u) => ({
        id: u.id(),
        type: u.type(),
        tile: u.tile(),
        active: u.isActive(),
      }));
    }

    const run1 = await createAndRun();
    const run2 = await createAndRun();

    expect(run1).toEqual(run2);
  });
});
