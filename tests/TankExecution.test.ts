import { beforeEach, describe, expect, test } from "vitest";
import {
  computeHostileBorderWaypoints,
  TankExecution,
} from "../src/core/execution/TankExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TankState,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("TankExecution", () => {
  let game: Game;
  let player: Player;
  let enemy: Player;
  let ally: Player;

  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
      new PlayerInfo("ally", PlayerType.Human, null, "ally_id"),
    ]);

    player = game.player("player_id");
    enemy = game.player("enemy_id");
    ally = game.player("ally_id");

    player.createAllianceRequest(ally)?.accept();
  });

  test("computes equidistant waypoints along active hostile border", () => {
    // Setup player territory along x: 10..15, y: 10
    for (let x = 10; x <= 15; x++) {
      player.conquer(game.ref(x, 10));
    }
    // Setup enemy territory immediately to the north at y: 9
    for (let x = 10; x <= 15; x++) {
      enemy.conquer(game.ref(x, 9));
    }

    const waypoints = computeHostileBorderWaypoints(game, player, 3);
    expect(waypoints.length).toBe(3);

    // Verify all waypoints are owned by player and border enemy
    const map = game.map();
    for (const wp of waypoints) {
      expect(game.owner(wp)).toBe(player);
      expect(map.y(wp)).toBe(10);
      expect(map.x(wp)).toBeGreaterThanOrEqual(10);
      expect(map.x(wp)).toBeLessThanOrEqual(15);
    }

    // Verify equidistant spacing (ascending X positions)
    const xs = waypoints.map((w) => map.x(w));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  test("ignores friendly allied borders when calculating waypoints", () => {
    // Player territory
    player.conquer(game.ref(10, 10));
    player.conquer(game.ref(11, 10));
    player.conquer(game.ref(12, 10));

    // Enemy border at (10, 9)
    enemy.conquer(game.ref(10, 9));

    // Allied border at (12, 11)
    ally.conquer(game.ref(12, 11));

    const waypoints = computeHostileBorderWaypoints(game, player, 1);
    expect(waypoints.length).toBe(1);

    // Waypoint must be the hostile border tile bordering enemy (10, 10), not ally (12, 10)
    const map = game.map();
    expect(map.x(waypoints[0])).toBe(10);
    expect(map.y(waypoints[0])).toBe(10);
  });

  test("movement along path and state transitions from Deploying to Patrolling", () => {
    // Setup land from (5, 5) to (5, 8)
    for (let y = 5; y <= 8; y++) {
      player.conquer(game.ref(5, y));
    }
    // Hostile border at (5, 9)
    enemy.conquer(game.ref(5, 9));

    const spawnTile = game.ref(5, 5);
    const tank = player.buildUnit(UnitType.Tank, spawnTile, {});
    const execution = new TankExecution(tank);
    execution.init(game, 0);

    // Initial tick calculates slotting and starts deploying
    execution.tick(0);
    expect(tank.tankState()).toBe(TankState.Deploying);

    // Tick until tank moves along the path to the waypoint at (5, 8)
    for (let t = 1; t <= 10; t++) {
      execution.tick(t);
      if (tank.tankState() === TankState.Patrolling) break;
    }

    expect(tank.tankState()).toBe(TankState.Patrolling);
    expect(tank.tile()).toBe(game.ref(5, 8));
  });

  test("reload cooldown decrements and transitions state from Reloading to Patrolling", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);
    const tank = player.buildUnit(UnitType.Tank, tile, {});
    const execution = new TankExecution(tank);
    execution.init(game, 0);

    tank.setTankCooldown(2);
    tank.setTankState(TankState.Reloading);

    execution.tick(1);
    expect(tank.tankCooldown()).toBe(1);
    expect(tank.tankState()).toBe(TankState.Reloading);

    execution.tick(2);
    expect(tank.tankCooldown()).toBe(0);
    expect(tank.tankState()).toBe(TankState.Patrolling);
  });

  test("rally point biases border waypoint selection toward closest frontier", () => {
    // Frontier A at x: 5, y: 10
    player.conquer(game.ref(5, 10));
    enemy.conquer(game.ref(5, 9));

    // Frontier B at x: 25, y: 10
    player.conquer(game.ref(25, 10));
    enemy.conquer(game.ref(25, 9));

    // Rally point set near Frontier B
    const rallyTile = game.ref(25, 15);
    const waypoints = computeHostileBorderWaypoints(
      game,
      player,
      1,
      rallyTile,
    );

    expect(waypoints.length).toBe(1);
    const map = game.map();
    expect(map.x(waypoints[0])).toBe(25);
  });
});
