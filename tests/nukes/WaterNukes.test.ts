import { NukeExecution } from "../../src/core/execution/NukeExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { setup } from "../util/Setup";
import { constructionExecution } from "../util/utils";

function launchNukeAt(game: Game, player: Player, target: TileRef): void {
  game.addExecution(new NukeExecution(UnitType.AtomBomb, player, target, null));
  // init + build
  game.executeNextTick();
  game.executeNextTick();
}

function tickUntilNukeLands(game: Game, maxTicks = 50): void {
  for (let i = 0; i < maxTicks; i++) {
    game.executeNextTick();
  }
}

describe("Missile impact territory behavior", () => {
  let game: Game;
  let player: Player;
  const info = new PlayerInfo("p", PlayerType.Human, null, "p");

  beforeEach(async () => {
    game = await setup(
      "plains",
      {
        infiniteGold: true,
        instantBuild: true,
      },
      [info],
    );
    player = game.player(info.id);
    player.conquer(game.ref(1, 1));

    // Build a missile silo
    constructionExecution(game, player, 1, 1, UnitType.MissileSilo);
  });

  test("nuke impact leaves land as normal claimable land, not water or fallout", () => {
    const target = game.ref(10, 10);
    expect(game.isLand(target)).toBe(true);

    launchNukeAt(game, player, target);
    tickUntilNukeLands(game);

    // Target should remain land, never water, and never fallout
    expect(game.isLand(target)).toBe(true);
    expect(game.isWater(target)).toBe(false);
    expect(game.hasFallout(target)).toBe(false);
    expect(game.hasOwner(target)).toBe(false);
  });

  test("waterGraphVersion does not change on nuke impact", () => {
    const versionBefore = game.waterGraphVersion();
    const target = game.ref(10, 10);

    launchNukeAt(game, player, target);
    tickUntilNukeLands(game);

    expect(game.waterGraphVersion()).toBe(versionBefore);
  });

  test("impacted land can be immediately claimed by players like at start of game", () => {
    const target = game.ref(10, 10);
    launchNukeAt(game, player, target);
    tickUntilNukeLands(game);

    expect(game.hasOwner(target)).toBe(false);
    player.conquer(target);
    expect(game.hasOwner(target)).toBe(true);
    expect(game.owner(target)).toBe(player);
  });
});
