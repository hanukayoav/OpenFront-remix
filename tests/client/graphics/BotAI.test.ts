import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOT_ARCHETYPES,
  BotAI,
  BotArchetype,
} from "../../../src/core/execution/utils/BotAI";

describe("Adaptive Bot Personality Engine (BotAI)", () => {
  beforeEach(() => {
    BotAI.clear();
  });

  afterEach(() => {
    BotAI.clear();
  });

  describe("Autonomous Archetype Assignment", () => {
    it("assigns Rusher, Hoarder, and Turtle archetypes with correct attributes", () => {
      const rusher = BotAI.assignPersonality("bot_rush", 0, "rusher");
      expect(rusher.archetype).toBe("rusher");
      expect(rusher.title).toBe("Swarm Bot");
      expect(rusher.badgeColor).toBe("#ef4444");
      expect(rusher.troopAllocationRatio).toBe(0.8);

      const hoarder = BotAI.assignPersonality("bot_hoard", 0, "hoarder");
      expect(hoarder.archetype).toBe("hoarder");
      expect(hoarder.title).toBe("Opportunist Bot");
      expect(hoarder.badgeColor).toBe("#f59e0b");
      expect(hoarder.troopAllocationRatio).toBe(0.5);

      const turtle = BotAI.assignPersonality("bot_def", 0, "turtle");
      expect(turtle.archetype).toBe("turtle");
      expect(turtle.title).toBe("Tactician Bot");
      expect(turtle.badgeColor).toBe("#38bdf8");
      expect(turtle.minAdvantageRatio).toBe(2.5);
    });

    it("assigns deterministic personalities based on playerId hash", () => {
      const p1 = BotAI.assignPersonality("player_alpha_1");
      const p2 = BotAI.assignPersonality("player_alpha_1");
      expect(p1).toBe(p2);
      expect(["rusher", "hoarder", "turtle"]).toContain(p1.archetype);
    });

    it("retrieves previously assigned personalities via getPersonality", () => {
      BotAI.assignPersonality(101, 0, "hoarder");
      const fetched = BotAI.getPersonality(101);
      expect(fetched).not.toBeNull();
      expect(fetched?.archetype).toBe("hoarder");
      expect(fetched?.title).toBe("Opportunist Bot");
    });
  });

  describe("The Rusher (Aggressive) Archetype Logic", () => {
    const rusher = BOT_ARCHETYPES.rusher;

    it("allocates 80% of troops towards attack target", () => {
      const troopsToSend = BotAI.calculateAttackTroops(rusher, 10000);
      expect(troopsToSend).toBe(8000); // 80% of 10,000
    });

    it("ignores neutral zones when bordering player enemies are present", () => {
      const borderingEnemies = 2;
      const ignoreNeutral = BotAI.shouldRusherIgnoreNeutral(rusher, borderingEnemies);
      expect(ignoreNeutral).toBe(true);
    });

    it("expands to neutral zones when blocked (zero bordering enemies)", () => {
      const borderingEnemies = 0;
      const ignoreNeutral = BotAI.shouldRusherIgnoreNeutral(rusher, borderingEnemies);
      expect(ignoreNeutral).toBe(false);
    });
  });

  describe("The Hoarder (Opportunist) Archetype Logic", () => {
    const hoarder = BOT_ARCHETYPES.hoarder;

    it("prioritizes target crate node when supply drop spawns", () => {
      const botTile = 100;
      const activeCrates = [500, 200, 800];
      const getDistance = (t1: number, t2: number) => Math.abs(t1 - t2);

      const targetCrate = BotAI.getHoarderCrateTarget(hoarder, botTile, activeCrates, getDistance);
      // Distance from 100 to 200 is 100, which is the closest
      expect(targetCrate).toBe(200);
    });

    it("returns null when no supply drops are active on the board", () => {
      const targetCrate = BotAI.getHoarderCrateTarget(hoarder, 100, []);
      expect(targetCrate).toBeNull();
    });
  });

  describe("The Turtle (Defensive) Archetype Logic", () => {
    const turtle = BOT_ARCHETYPES.turtle;

    it("refuses to attack when holding less than 2.5x numerical advantage", () => {
      const botTroops = 2000;
      const neighborTroops = 1000; // Requires 2500 (2.5x)
      const canAttack = BotAI.canTurtleAttack(turtle, botTroops, neighborTroops);
      expect(canAttack).toBe(false);
    });

    it("launches attack only when maintaining at least 2.5x numerical advantage", () => {
      const botTroops = 2500;
      const neighborTroops = 1000; // Exactly 2.5x
      const canAttack = BotAI.canTurtleAttack(turtle, botTroops, neighborTroops);
      expect(canAttack).toBe(true);
    });

    it("allocates conservative 35% of troops upon attack", () => {
      const troopsToSend = BotAI.calculateAttackTroops(turtle, 10000);
      expect(troopsToSend).toBe(3500);
    });
  });

  describe("Visual Indicators & Badge Attributes", () => {
    it("returns distinct mini title and badge color beneath bot name", () => {
      BotAI.assignPersonality("bot_alpha", 0, "rusher");
      BotAI.assignPersonality("bot_beta", 0, "turtle");
      BotAI.assignPersonality("bot_gamma", 0, "hoarder");

      expect(BotAI.getTitle("bot_alpha")).toBe("Swarm Bot");
      expect(BotAI.getBadgeColor("bot_alpha")).toBe("#ef4444");

      expect(BotAI.getTitle("bot_beta")).toBe("Tactician Bot");
      expect(BotAI.getBadgeColor("bot_beta")).toBe("#38bdf8");

      expect(BotAI.getTitle("bot_gamma")).toBe("Opportunist Bot");
      expect(BotAI.getBadgeColor("bot_gamma")).toBe("#f59e0b");
    });
  });
});
