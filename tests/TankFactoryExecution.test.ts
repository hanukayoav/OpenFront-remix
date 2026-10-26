import { beforeEach, describe, expect, test } from "vitest";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { SetTankRallyPointExecution } from "../src/core/execution/SetTankRallyPointExecution";
import { TankFactoryExecution } from "../src/core/execution/TankFactoryExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("TankFactoryExecution", () => {
  let game: Game;
  let player: Player;

  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);

    player = game.player("player_id");
    player.addGold(500_000n);
    player.addTroops(50_000);
  });

  test("produces up to max tanks (5) and deducts gold and troops", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);

    const factory = player.buildUnit(UnitType.TankFactory, tile, {});
    const execution = new TankFactoryExecution(factory);
    execution.init(game, 0);

    const initialGold = player.gold();
    const initialTroops = player.troops();

    // With instantBuild: true, tick produces all 5 tanks
    execution.tick(0);

    const tanks = execution.getTanks();
    expect(tanks.length).toBe(5);
    expect(player.units(UnitType.Tank).length).toBe(5);

    const goldCost = game.config().tankProductionGoldCost();
    const troopCost = game.config().tankTroopCost();

    expect(initialGold - player.gold()).toBe(goldCost * 5n);
    expect(initialTroops - player.troops()).toBe(troopCost * 5);

    // Ticking again does not exceed the maximum of 5 tanks
    execution.tick(1);
    expect(execution.getTanks().length).toBe(5);
    expect(player.units(UnitType.Tank).length).toBe(5);
  });

  test("does not produce tanks when gold or troops are insufficient", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);

    const factory = player.buildUnit(UnitType.TankFactory, tile, {});
    const execution = new TankFactoryExecution(factory);
    execution.init(game, 0);

    // Starve gold
    player.removeGold(player.gold());
    player.addGold(10_000n); // Cost is 20,000n

    execution.tick(0);
    expect(execution.getTanks().length).toBe(0);

    // Add gold, starve troops
    player.addGold(100_000n);
    player.removeTroops(player.troops());
    player.addTroops(100); // Cost is 500

    execution.tick(1);
    expect(execution.getTanks().length).toBe(0);

    // Grant enough troops
    player.addTroops(1000);
    execution.tick(2);
    expect(execution.getTanks().length).toBeGreaterThan(0);
  });

  test("automatically trains replacement when a tank is destroyed", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);

    const factory = player.buildUnit(UnitType.TankFactory, tile, {});
    const execution = new TankFactoryExecution(factory);
    execution.init(game, 0);

    execution.tick(0);
    expect(execution.getTanks().length).toBe(5);

    // Destroy one tank
    const firstTank = execution.getTanks()[0];
    firstTank.delete();
    expect(firstTank.isActive()).toBe(false);

    // Tick factory to trigger auto-replacement
    execution.tick(1);
    const activeTanks = execution.getTanks().filter((t) => t.isActive());
    expect(activeTanks.length).toBe(5);
  });

  test("setting frontline rally point persists on factory", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);

    const factory = player.buildUnit(UnitType.TankFactory, tile, {});
    const rallyTile = game.ref(15, 15);

    const rallyExec = new SetTankRallyPointExecution(
      player,
      rallyTile,
      factory.id(),
    );
    rallyExec.init(game, 0);

    expect(factory.tankRallyTile()).toBe(rallyTile);
  });

  test("placed via ConstructionExecution builds factory and begins tank production", () => {
    const tile = game.ref(10, 10);
    player.conquer(tile);

    const construction = new ConstructionExecution(
      player,
      UnitType.TankFactory,
      tile,
    );
    construction.init(game, 0);

    // Initial tick creates the structure (with instantBuild: true, completes immediately)
    construction.tick(0);
    const factories = player.units(UnitType.TankFactory);
    expect(factories.length).toBe(1);
    const factory = factories[0];
    expect(factory.isUnderConstruction()).toBe(false);
    expect(construction.isActive()).toBe(false);

    // Game ticks process added executions (initializes and ticks TankFactoryExecution)
    game.executeNextTick(); // inits TankFactoryExecution
    game.executeNextTick(); // ticks TankFactoryExecution -> spawns tanks
    const tanks = player.units(UnitType.Tank);
    expect(tanks.length).toBeGreaterThan(0);
  });
});
