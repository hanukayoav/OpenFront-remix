/**
 * OpenFront Adaptive Bot Personality Engine (BotAI)
 *
 * Assigns computer opponents autonomous personality archetypes at match start:
 * - The Rusher (Aggressive): Allocates 80% of generated troops directly towards bordering player territories.
 *   Ignores neutral zones (TerraNullius) unless blocked (zero bordering enemies).
 *   Mini Title: "Swarm Bot" (#ef4444)
 *
 * - The Hoarder (Opportunist): Reprioritises targets the moment a supply drop spawns,
 *   rerouting forces to contest crate nodes before the player can claim them.
 *   Mini Title: "Opportunist Bot" (#f59e0b)
 *
 * - The Turtle (Defensive): Holds troops on capital and border nodes until maintaining
 *   a 2.5x numerical advantage over adjacent neighbours before attacking.
 *   Mini Title: "Tactician Bot" (#38bdf8)
 */

export type BotArchetype = "rusher" | "hoarder" | "turtle";

export interface BotPersonality {
  archetype: BotArchetype;
  title: string;
  badgeColor: string;
  description: string;
  troopAllocationRatio: number;
  minAdvantageRatio: number;
}

export const BOT_ARCHETYPES: Record<BotArchetype, BotPersonality> = {
  rusher: {
    archetype: "rusher",
    title: "Swarm Bot",
    badgeColor: "#ef4444",
    description: "Aggressive blitz tactics. Allocates 80% troops to player borders, ignoring neutrals.",
    troopAllocationRatio: 0.8,
    minAdvantageRatio: 0.6,
  },
  hoarder: {
    archetype: "hoarder",
    title: "Opportunist Bot",
    badgeColor: "#f59e0b",
    description: "Tactical scavenger. Swarms supply drops the moment they spawn to contest crates.",
    troopAllocationRatio: 0.5,
    minAdvantageRatio: 1.0,
  },
  turtle: {
    archetype: "turtle",
    title: "Tactician Bot",
    badgeColor: "#38bdf8",
    description: "Fortress defense. Holds forces until securing a 2.5x advantage over targets.",
    troopAllocationRatio: 0.35,
    minAdvantageRatio: 2.5,
  },
};

export class BotAI {
  private static personalities = new Map<string | number, BotPersonality>();

  /**
   * Assigns or retrieves a deterministic personality archetype for a bot player.
   */
  public static assignPersonality(
    playerId: number | string,
    seed = 0,
    forceArchetype?: BotArchetype,
  ): BotPersonality {
    if (forceArchetype && BOT_ARCHETYPES[forceArchetype]) {
      const p = BOT_ARCHETYPES[forceArchetype];
      BotAI.personalities.set(playerId, p);
      return p;
    }

    const existing = BotAI.personalities.get(playerId);
    if (existing) return existing;

    // Deterministic distribution based on ID hash and seed
    const idStr = String(playerId);
    let hash = seed;
    for (let i = 0; i < idStr.length; i++) {
      hash = (hash * 31 + idStr.charCodeAt(i)) >>> 0;
    }

    const archetypes: BotArchetype[] = ["rusher", "hoarder", "turtle"];
    const chosenArchetype = archetypes[hash % archetypes.length];
    const personality = BOT_ARCHETYPES[chosenArchetype];
    BotAI.personalities.set(playerId, personality);
    return personality;
  }

  /**
   * Retrieves the assigned personality for a player or null if none assigned.
   */
  public static getPersonality(playerId: number | string): BotPersonality | null {
    return BotAI.personalities.get(playerId) ?? null;
  }

  /**
   * Checks whether a personality has been explicitly assigned.
   */
  public static hasPersonality(playerId: number | string): boolean {
    return BotAI.personalities.has(playerId);
  }

  /**
   * Explicitly sets a bot's personality.
   */
  public static setPersonality(
    playerId: number | string,
    personality: BotPersonality,
  ): void {
    BotAI.personalities.set(playerId, personality);
  }

  /**
   * Clears the bot personality registry (for new matches or test teardown).
   */
  public static clear(): void {
    BotAI.personalities.clear();
  }

  /**
   * Checks if a Rusher bot should skip expanding into neutral zones
   * because active player enemies border its territory.
   */
  public static shouldRusherIgnoreNeutral(
    personality: BotPersonality,
    borderingEnemyCount: number,
  ): boolean {
    if (personality.archetype !== "rusher") return false;
    return borderingEnemyCount > 0;
  }

  /**
   * Finds the best active supply crate tile for a Hoarder bot to contest.
   */
  public static getHoarderCrateTarget(
    personality: BotPersonality,
    botTile: number,
    activeCrateTiles: number[],
    getDistance?: (tileA: number, tileB: number) => number,
  ): number | null {
    if (personality.archetype !== "hoarder" || activeCrateTiles.length === 0) {
      return null;
    }

    if (!getDistance || activeCrateTiles.length === 1) {
      return activeCrateTiles[0];
    }

    let closestTile = activeCrateTiles[0];
    let minDistance = Infinity;

    for (let i = 0; i < activeCrateTiles.length; i++) {
      const tile = activeCrateTiles[i];
      const dist = getDistance(botTile, tile);
      if (dist < minDistance) {
        minDistance = dist;
        closestTile = tile;
      }
    }

    return closestTile;
  }

  /**
   * Evaluates if a Turtle bot has achieved the required 2.5x numerical advantage
   * over the defending target before launching an attack.
   */
  public static canTurtleAttack(
    personality: BotPersonality,
    botTroops: number,
    targetTroops: number,
  ): boolean {
    if (personality.archetype !== "turtle") return true;
    const required = targetTroops * personality.minAdvantageRatio;
    return botTroops >= required;
  }

  /**
   * Calculates troop commitment based on personality archetype:
   * - Rusher: 80% allocation
   * - Hoarder: 50% allocation
   * - Turtle: 35% allocation
   */
  public static calculateAttackTroops(
    personality: BotPersonality,
    availableTroops: number,
  ): number {
    return Math.max(1, Math.floor(availableTroops * personality.troopAllocationRatio));
  }

  /**
   * Retrieves visual mini title for HUD/canvas display beneath player/bot name.
   */
  public static getTitle(playerId: number | string): string {
    const p = BotAI.getPersonality(playerId);
    return p ? p.title : "Tactician Bot";
  }

  /**
   * Retrieves badge color for HUD/canvas display.
   */
  public static getBadgeColor(playerId: number | string): string {
    const p = BotAI.getPersonality(playerId);
    return p ? p.badgeColor : "#38bdf8";
  }
}
