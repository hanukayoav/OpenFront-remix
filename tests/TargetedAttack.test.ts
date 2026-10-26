import { describe, expect, test, beforeEach } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

let game: Game;
const gameID: GameID = "test_game_id";
let attacker: Player;
let defender: Player;

describe("Targeted Land Attacks", () => {
  beforeEach(async () => {
    game = await setup("plains", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });

    const attackerInfo = new PlayerInfo(
      "Attacker",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(attackerInfo);

    const defenderInfo = new PlayerInfo(
      "Defender",
      PlayerType.Human,
      null,
      "defender_id",
    );
    game.addPlayer(defenderInfo);

    attacker = game.player(attackerInfo.id);
    defender = game.player(defenderInfo.id);

    const attackerSpawn = game.ref(20, 20);
    const defenderSpawn = game.ref(50, 50);

    game.addExecution(
      new SpawnExecution(gameID, attacker.info(), attackerSpawn),
      new SpawnExecution(gameID, defender.info(), defenderSpawn),
    );

    game.executeNextTick();
    game.executeNextTick();

    // Ensure defender has plenty of tiles (> 100) so they don't get marked dead
    for (let x = 50; x < 65; x++) {
      for (let y = 50; y < 65; y++) {
        defender.conquer(game.ref(x, y));
      }
    }

    // Clear initial immunity / spawn states
    for (let i = 0; i < 15; i++) {
      game.executeNextTick();
    }
  });

  test("Targeted attack only conquers the connected land piece containing targetTile", () => {
    // Pocket 1 (South): (20, 25), (20, 26)
    const pocket1Tile1 = game.ref(20, 25);
    const pocket1Tile2 = game.ref(20, 26);
    defender.conquer(pocket1Tile1);
    defender.conquer(pocket1Tile2);

    // Pocket 2 (North): (20, 15), (20, 16)
    const pocket2Tile1 = game.ref(20, 15);
    const pocket2Tile2 = game.ref(20, 16);
    defender.conquer(pocket2Tile1);
    defender.conquer(pocket2Tile2);

    // Attacker owns (20, 20) through (20, 24) and (20, 17)
    attacker.conquer(game.ref(20, 24));
    attacker.conquer(game.ref(20, 17));

    expect(game.owner(pocket1Tile1)).toBe(defender);
    expect(game.owner(pocket2Tile1)).toBe(defender);

    // Attacker launches targeted attack ONLY on Pocket 1 (pocket1Tile1)
    const targetedAttack = new AttackExecution(
      5000,
      attacker,
      defender.id(),
      null,
      true,
      pocket1Tile1,
    );
    game.addExecution(targetedAttack);
    game.executeNextTick();

    for (let i = 0; i < 30; i++) {
      game.executeNextTick();
    }

    // Pocket 1 was targeted and should be conquered by attacker
    expect(game.owner(pocket1Tile1)).toBe(attacker);
    expect(game.owner(pocket1Tile2)).toBe(attacker);

    // Pocket 2 was NOT targeted, so it must still belong to defender!
    expect(game.owner(pocket2Tile1)).toBe(defender);
    expect(game.owner(pocket2Tile2)).toBe(defender);

    // Defender's main base at (50, 50) is also completely untouched
    expect(game.owner(game.ref(50, 50))).toBe(defender);
  });

  test("Full country attack (no targetTile) conquers across all shared borders", () => {
    // Pocket 1
    const pocket1Tile = game.ref(20, 25);
    defender.conquer(pocket1Tile);

    // Pocket 2
    const pocket2Tile = game.ref(20, 16);
    defender.conquer(pocket2Tile);

    // Attacker borders both
    attacker.conquer(game.ref(20, 24));
    attacker.conquer(game.ref(20, 17));

    // Attacker issues global full attack (targetTile = null)
    const fullAttack = new AttackExecution(
      10000,
      attacker,
      defender.id(),
      null,
      true,
      null,
    );
    game.addExecution(fullAttack);
    game.executeNextTick();

    for (let i = 0; i < 30; i++) {
      game.executeNextTick();
    }

    // Both pockets should be conquered
    expect(game.owner(pocket1Tile)).toBe(attacker);
    expect(game.owner(pocket2Tile)).toBe(attacker);
  });

  test("Multiple targeted attacks on different land pieces can run simultaneously", () => {
    // Pocket 1
    const pocket1Tile = game.ref(20, 25);
    defender.conquer(pocket1Tile);

    // Pocket 2
    const pocket2Tile = game.ref(20, 16);
    defender.conquer(pocket2Tile);

    // Attacker borders both
    attacker.conquer(game.ref(20, 24));
    attacker.conquer(game.ref(20, 17));

    // Launch targeted attack on Pocket 1
    game.addExecution(
      new AttackExecution(
        5000,
        attacker,
        defender.id(),
        null,
        true,
        pocket1Tile,
      ),
    );

    // Launch targeted attack on Pocket 2
    game.addExecution(
      new AttackExecution(
        5000,
        attacker,
        defender.id(),
        null,
        true,
        pocket2Tile,
      ),
    );

    game.executeNextTick();

    // Both attacks should exist separately in outgoing attacks
    expect(attacker.outgoingAttacks().length).toBe(2);

    for (let i = 0; i < 30; i++) {
      game.executeNextTick();
    }

    expect(game.owner(pocket1Tile)).toBe(attacker);
    expect(game.owner(pocket2Tile)).toBe(attacker);
  });
});
