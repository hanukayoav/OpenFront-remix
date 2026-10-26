import { beforeEach, describe, expect, test } from "vitest";
import { TankShellExecution } from "../src/core/execution/TankShellExecution";
import { TankStrikeExecution } from "../src/core/execution/TankStrikeExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TankState,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

describe("TankStrike", () => {
  let game: Game;
  let player: Player;
  let enemy: Player;

  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);

    player = game.player("player_id");
    enemy = game.player("enemy_id");
    enemy.addTroops(5000);
  });

  test("executes strike on enemy structure within range and deals structural & splash damage", () => {
    // Player tank at (10, 10)
    const tankTile = game.ref(10, 10);
    player.conquer(tankTile);
    const tank = player.buildUnit(UnitType.Tank, tankTile, {});

    // Enemy structure at (13, 10) - distance 3 (within range 5)
    const targetTile = game.ref(13, 10);
    enemy.conquer(targetTile);
    const targetStruct = enemy.buildUnit(UnitType.TankFactory, targetTile, {});
    const initialHealth = targetStruct.health();
    const initialEnemyTroops = enemy.troops();

    // Trigger tank strike
    const strike = new TankStrikeExecution(
      player,
      targetTile,
      String(targetStruct.id()),
    );
    strike.init(game, 0);

    // Tank should have pivoted and entered cooldown
    expect(tank.tankCooldown()).toBe(game.config().tankReloadTicks());
    expect(tank.tankState()).toBe(TankState.Reloading);
    expect(tank.turretAngle()).toBe(0); // target is directly east (dx=3, dy=0)

    // A TankShellExecution was added to game executions.
    // Progress ticks for shell travel and impact (speed is 3 tiles/tick)
    executeTicks(game, 5);

    // Structural damage is 500
    expect(targetStruct.health()).toBe(
      initialHealth - game.config().tankStructureDamage(),
    );
    // Defending troops splashed by up to 500
    expect(initialEnemyTroops - enemy.troops()).toBe(500);
  });

  test("does nothing if all tanks are on cooldown or out of range", () => {
    const tankTile = game.ref(10, 10);
    player.conquer(tankTile);
    const tank = player.buildUnit(UnitType.Tank, tankTile, {});

    // Target out of range: distance 10 > 5
    const farTarget = game.ref(20, 10);
    enemy.conquer(farTarget);

    const farStrike = new TankStrikeExecution(player, farTarget);
    farStrike.init(game, 0);
    expect(tank.tankCooldown()).toBe(0);

    // Target in range, but tank is on cooldown
    tank.setTankCooldown(30);
    const inRangeTarget = game.ref(12, 10);
    enemy.conquer(inRangeTarget);

    const cooldownStrike = new TankStrikeExecution(player, inRangeTarget);
    cooldownStrike.init(game, 0);
    expect(tank.tankCooldown()).toBe(30); // remains unchanged
  });

  test("handles mid-flight target destruction gracefully", () => {
    const tankTile = game.ref(10, 10);
    player.conquer(tankTile);
    const tank = player.buildUnit(UnitType.Tank, tankTile, {});

    const targetTile = game.ref(14, 10);
    enemy.conquer(targetTile);
    const targetUnit = enemy.buildUnit(UnitType.City, targetTile, {});

    const shellExec = new TankShellExecution(
      tank,
      player,
      tankTile,
      targetTile,
      targetUnit,
    );
    shellExec.init(game, 0);

    // Mid-flight: delete target unit
    targetUnit.delete();
    expect(targetUnit.isActive()).toBe(false);

    // Shell ticks to impact
    expect(() => {
      for (let t = 1; t <= 5; t++) {
        shellExec.tick(t);
      }
    }).not.toThrow();
  });
});
