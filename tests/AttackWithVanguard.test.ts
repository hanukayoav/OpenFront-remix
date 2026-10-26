import { beforeEach, describe, expect, test } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TankState,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("AttackWithVanguard", () => {
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
  });

  test("covering fire reduces friendly assault casualties by 25%", async () => {
    // Setup two identical matches to accurately compare baseline vs vanguard casualties
    const game1 = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("e1", PlayerType.Human, null, "e1"),
    ]);
    const p1 = game1.player("p1");
    const e1 = game1.player("e1");
    p1.addTroops(10_000);
    e1.addTroops(10_000);

    const pTile1 = game1.ref(10, 10);
    const eTile1 = game1.ref(10, 11);
    const eBackTile1 = game1.ref(10, 12);
    p1.conquer(pTile1);
    e1.conquer(eTile1);
    e1.conquer(eBackTile1);

    const baselineAttack = new AttackExecution(
      1000,
      p1,
      e1.id(),
      null,
      false,
      eTile1,
    );
    baselineAttack.init(game1, 0);
    baselineAttack.tick(0);
    const baselineCasualties = 1000 - baselineAttack.getAttack()!.troops();

    // Match 2: with Vanguard Tank support stationed adjacent within firing range
    const game2 = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
      new PlayerInfo("e2", PlayerType.Human, null, "e2"),
    ]);
    const p2 = game2.player("p2");
    const e2 = game2.player("e2");
    p2.addTroops(10_000);
    e2.addTroops(10_000);

    const pTile2 = game2.ref(10, 10);
    const eTile2 = game2.ref(10, 11);
    const eBackTile2 = game2.ref(10, 12);
    p2.conquer(pTile2);
    e2.conquer(eTile2);
    e2.conquer(eBackTile2);

    const tank = p2.buildUnit(UnitType.Tank, pTile2, {});
    expect(tank.isActive()).toBe(true);

    const vanguardAttack = new AttackExecution(
      1000,
      p2,
      e2.id(),
      null,
      false,
      eTile2,
    );
    vanguardAttack.init(game2, 0);
    vanguardAttack.tick(0);
    const vanguardCasualties = 1000 - vanguardAttack.getAttack()!.troops();

    // Vanguard casualties must be strictly lower than baseline
    expect(vanguardCasualties).toBeLessThan(baselineCasualties);

    // Casualty reduction is ~25%
    expect(vanguardCasualties).toBe(Math.floor(baselineCasualties * 0.75));
  });

  test("covering fire degrades defending fortifications (Defense Post)", () => {
    const playerTile = game.ref(10, 10);
    const enemyTile = game.ref(10, 11);
    player.conquer(playerTile);
    enemy.conquer(enemyTile);

    player.addTroops(10_000);
    enemy.addTroops(10_000);

    // Station vanguard tank at (10, 10)
    player.buildUnit(UnitType.Tank, playerTile, {});

    // Enemy has a defense post on enemyTile
    const defensePost = enemy.buildUnit(UnitType.DefensePost, enemyTile, {});
    const initialHealth = defensePost.health();

    const attack = new AttackExecution(
      1000,
      player,
      enemy.id(),
      null,
      false,
      enemyTile,
    );
    attack.init(game, 0);
    attack.tick(0);

    // Defense post took degradation damage
    expect(defensePost.health()).toBeLessThan(initialHealth);
  });

  test("spearhead advance: stationed tank advances into conquered enemy tile and sets Spearheading state", () => {
    const playerTile = game.ref(10, 10);
    const enemyTile = game.ref(10, 11);
    player.conquer(playerTile);
    enemy.conquer(enemyTile);

    player.addTroops(50_000);
    enemy.addTroops(10); // Very weak defender so tile gets conquered

    const tank = player.buildUnit(UnitType.Tank, playerTile, {});
    expect(tank.tile()).toBe(playerTile);
    expect(tank.tankState()).toBe(TankState.Idle);

    const attack = new AttackExecution(
      1000,
      player,
      enemy.id(),
      null,
      false,
      enemyTile,
    );
    attack.init(game, 0);
    attack.tick(0);

    // Tile conquered by player
    expect(game.owner(enemyTile)).toBe(player);

    // Stationed tank should have rolled into conquered tile to anchor breakthrough
    expect(tank.tile()).toBe(enemyTile);
    expect(tank.tankState()).toBe(TankState.Spearheading);
  });
});
