import { beforeEach, describe, expect, test } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { TankExecution } from "../src/core/execution/TankExecution";
import { TankFactoryExecution } from "../src/core/execution/TankFactoryExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TankState,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("Fix 2 & Fix 3: Tank Border Following, Stranded Retreat & Capture Recovery", () => {
  let game: Game;
  let player: Player;
  let enemy: Player;
  let bot: Player;

  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
      new PlayerInfo("bot", PlayerType.Bot, null, "bot_id"),
    ]);

    player = game.player("player_id");
    enemy = game.player("enemy_id");
    bot = game.player("bot_id");

    player.addTroops(100_000);
    enemy.addTroops(100_000);
    bot.addTroops(100_000);
    player.addGold(10_000_000n);
    enemy.addGold(10_000_000n);
    bot.addGold(10_000_000n);
  });

  test("tanks advance from obsolete interior waypoints to newly expanded frontlines", () => {
    // Strip (x = 5..12, y = 10) for player, enemy at y = 9? Actually strip x=10, y=5..8 -> enemy at y=9
    for (let y = 5; y <= 8; y++) {
      player.conquer(game.ref(10, y));
    }
    for (let y = 9; y <= 14; y++) {
      enemy.conquer(game.ref(10, y));
    }

    const tank = player.buildUnit(UnitType.Tank, game.ref(10, 5), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);

    // Move tank to initial border at (10, 8)
    for (let t = 0; t <= 10; t++) {
      exec.tick(t);
    }
    expect(tank.tile()).toBe(game.ref(10, 8));
    expect(tank.tankState()).toBe(TankState.Patrolling);

    // Player expands territory forward: (10, 9), (10, 10), (10, 11) conquered!
    player.conquer(game.ref(10, 9));
    player.conquer(game.ref(10, 10));
    player.conquer(game.ref(10, 11));

    // Old waypoint (10, 8) is now interior (player owns 9,10,11).
    // Tank must detect border shift and advance to the new frontline at (10, 11)!
    for (let t = 11; t <= 40; t++) {
      exec.tick(t);
    }
    expect(tank.tile()).toBe(game.ref(10, 11));
    expect(exec.getTargetWaypoint()).toBe(game.ref(10, 11));
  });

  test("tanks redeploy when a previously neutral border becomes hostile elsewhere", () => {
    // Player strip at x = 20..25, y = 10; surrounding tiles neutral at first
    for (let x = 20; x <= 25; x++) {
      player.conquer(game.ref(x, 10));
    }
    const tank = player.buildUnit(UnitType.Tank, game.ref(20, 10), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);
    for (let t = 0; t < 10; t++) exec.tick(t);

    // Hostile enemy appears next to eastern edge at (26, 10)
    enemy.conquer(game.ref(26, 10));

    for (let t = 10; t <= 45; t++) {
      exec.tick(t);
    }
    expect(tank.tile()).toBe(game.ref(25, 10));
  });

  test("handles 20+ tanks across multiple fronts without oscillation or stalling", () => {
    for (let y = 10; y <= 20; y++) {
      for (let x = 10; x <= 30; x++) {
        player.conquer(game.ref(x, y));
      }
    }
    // Two separate enemy fronts: West (x=9) and East (x=31)
    for (let y = 12; y <= 18; y++) {
      enemy.conquer(game.ref(9, y));
      enemy.conquer(game.ref(31, y));
    }

    const execs: TankExecution[] = [];
    for (let i = 0; i < 24; i++) {
      const t = player.buildUnit(UnitType.Tank, game.ref(20, 15), {});
      const e = new TankExecution(t);
      e.init(game, 0);
      execs.push(e);
    }

    for (let tick = 0; tick <= 60; tick++) {
      for (const e of execs) e.tick(tick);
    }

    const tanks = player.units(UnitType.Tank);
    const westFront = tanks.filter((u) => game.x(u.tile()) === 10).length;
    const eastFront = tanks.filter((u) => game.x(u.tile()) === 30).length;
    expect(westFront).toBeGreaterThan(0);
    expect(eastFront).toBeGreaterThan(0);
    expect(westFront + eastFront).toBeGreaterThanOrEqual(20);
  });

  test("invalidated rally point is cleared when captured by enemy", () => {
    for (let x = 10; x <= 30; x++) {
      player.conquer(game.ref(x, 10));
    }
    enemy.conquer(game.ref(9, 10));
    enemy.conquer(game.ref(31, 10));

    const factory = player.buildUnit(
      UnitType.TankFactory,
      game.ref(25, 10),
      {},
    );
    const rallyTile = game.ref(28, 10);
    factory.setTankRallyTile(rallyTile);

    const tank = player.buildUnit(UnitType.Tank, game.ref(20, 10), {
      factoryId: factory.id(),
    });
    const exec = new TankExecution(tank, factory);
    exec.init(game, 0);
    for (let t = 0; t <= 12; t++) exec.tick(t);
    expect(game.x(exec.getTargetWaypoint()!)).toBe(30); // East frontier near rally

    // Enemy captures rally tile!
    enemy.conquer(rallyTile);
    for (let t = 13; t <= 25; t++) exec.tick(t);

    expect(factory.tankRallyTile()).toBeUndefined();
    expect(tank.tankRallyTile()).toBeUndefined();
  });

  test("stranded defensive tank retreats step-by-step to friendly land (never teleports) and reslots", () => {
    for (let x = 10; x <= 20; x++) {
      player.conquer(game.ref(x, 10));
    }
    enemy.conquer(game.ref(21, 10));

    const tank = player.buildUnit(UnitType.Tank, game.ref(18, 10), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);
    exec.tick(0);

    // Enemy captures x = 16..20 underneath the tank (player still holds x = 10..15)
    for (let x = 16; x <= 20; x++) {
      enemy.conquer(game.ref(x, 10));
    }

    // Check 1 tile per tick retreat (no teleporting!)
    let prevX = game.x(tank.tile());
    for (let t = 1; t <= 10; t++) {
      exec.tick(t);
      const curX = game.x(tank.tile());
      expect(Math.abs(curX - prevX)).toBeLessThanOrEqual(1);
      prevX = curX;
      if (game.owner(tank.tile()) === player) break;
    }

    expect(tank.isActive()).toBe(true);
    expect(game.owner(tank.tile())).toBe(player);
    // After retreat, settles onto new frontline (15, 10)
    for (let t = 11; t <= 25; t++) exec.tick(t);
    expect(tank.tile()).toBe(game.ref(15, 10));
  });

  test("dynamically replans retreat if target friendly tile falls mid-retreat", () => {
    for (let x = 5; x <= 15; x++) {
      player.conquer(game.ref(x, 10));
    }
    enemy.conquer(game.ref(16, 10));
    const tank = player.buildUnit(UnitType.Tank, game.ref(14, 10), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);
    exec.tick(0);

    // Tick 0 advances tank 1 tile from (14, 10) onto frontline (15, 10)
    expect(game.x(tank.tile())).toBe(15);

    // Enemy captures x = 12..15
    for (let x = 12; x <= 15; x++) {
      enemy.conquer(game.ref(x, 10));
    }
    exec.tick(1);
    expect(game.x(tank.tile())).toBe(14); // 1-step retreat west toward (11, 10) without teleporting

    // Mid-retreat, enemy captures x = 9..11! Tank must keep retreating cleanly to x = 8!
    for (let x = 9; x <= 11; x++) {
      enemy.conquer(game.ref(x, 10));
    }
    for (let t = 2; t <= 15; t++) {
      exec.tick(t);
    }
    expect(tank.isActive()).toBe(true);
    expect(game.owner(tank.tile())).toBe(player);
    expect(game.x(tank.tile())).toBeLessThanOrEqual(8);
  });

  test("completely surrounded / cut-off tank without reachable friendly land is deterministically destroyed", () => {
    for (let y = 10; y <= 14; y++) {
      for (let x = 10; x <= 14; x++) {
        player.conquer(game.ref(x, y));
      }
    }
    // Player still has an island elsewhere so player remains alive
    player.conquer(game.ref(90, 90));

    const tank = player.buildUnit(UnitType.Tank, game.ref(12, 12), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);
    exec.tick(0);

    // Enemy conquers the entire local pocket (35+ tiles radius far beyond retreat range or 0 nearby owned)
    for (let y = 1; y <= 45; y++) {
      for (let x = 1; x <= 45; x++) {
        enemy.conquer(game.ref(x, y));
      }
    }

    for (let t = 1; t <= 12; t++) {
      exec.tick(t);
    }
    expect(tank.isActive()).toBe(false);
    expect(exec.isActive()).toBe(false);
  });

  test("Spearheading tank exits stale breakthrough after attack ends and retreats if enemy recaptures tile", () => {
    const pTile = game.ref(10, 10);
    const eTile = game.ref(10, 11);
    const pBack = game.ref(10, 9);
    player.conquer(pBack);
    player.conquer(pTile);
    enemy.conquer(eTile);
    enemy.conquer(game.ref(10, 12));

    const tank = player.buildUnit(UnitType.Tank, pTile, {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);

    const attack = new AttackExecution(
      1000,
      player,
      enemy.id(),
      null,
      false,
      eTile,
    );
    attack.init(game, 0);
    attack.tick(0);

    expect(tank.tankState()).toBe(TankState.Spearheading);
    expect(tank.tile()).toBe(eTile);

    // Enemy counter-captures eTile right underneath the Spearheading tank!
    enemy.conquer(eTile);
    exec.tick(1);

    // Spearheading must NOT skip hostile tile check; tank retreats onto player land!
    expect(tank.tankState()).not.toBe(TankState.Spearheading);
    expect(game.owner(tank.tile())).toBe(player);
  });

  test("captured TankFactory clears old tanks, production, and rally tile for new owner", () => {
    for (let x = 10; x <= 20; x++) {
      player.conquer(game.ref(x, 10));
    }
    enemy.conquer(game.ref(21, 10));

    const factory = player.buildUnit(
      UnitType.TankFactory,
      game.ref(15, 10),
      {},
    );
    factory.setTankRallyTile(game.ref(18, 10));
    const fExec = new TankFactoryExecution(factory);
    fExec.init(game, 0);
    fExec.tick(0);

    expect(fExec.getTanks().length).toBeGreaterThan(0);

    // Enemy captures the factory!
    enemy.conquer(game.ref(15, 10));
    enemy.captureUnit(factory);
    fExec.tick(1);

    expect(factory.owner()).toBe(enemy);
    expect(factory.tankRallyTile()).toBeUndefined();
    // Captured factory spawns fresh tanks for enemy without being blocked by old owner's tanks
    expect(fExec.getTanks().length).toBeGreaterThan(0);
    expect(fExec.getTanks().every((u) => u.owner() === enemy)).toBe(true);
  });

  test("AI bots retreat and re-slot identically to human players", () => {
    for (let x = 10; x <= 20; x++) {
      bot.conquer(game.ref(x, 20));
    }
    enemy.conquer(game.ref(21, 20));

    const tank = bot.buildUnit(UnitType.Tank, game.ref(19, 20), {});
    const exec = new TankExecution(tank);
    exec.init(game, 0);
    exec.tick(0);

    // Enemy takes x = 17..20
    for (let x = 17; x <= 20; x++) {
      enemy.conquer(game.ref(x, 20));
    }
    for (let t = 1; t <= 20; t++) {
      exec.tick(t);
    }

    expect(tank.isActive()).toBe(true);
    expect(game.owner(tank.tile())).toBe(bot);
    expect(tank.tile()).toBe(game.ref(16, 20));
  });
});
