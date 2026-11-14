import path from "path";
import { describe, expect, test } from "vitest";
import { SupplyDropManager } from "../src/client/graphics/engine/SupplyDropManager";
import { Executor } from "../src/core/execution/ExecutionManager";
import { SupplyDropExecution } from "../src/core/execution/SupplyDropExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import {
  GameUpdateType,
  HashUpdate,
  SupplyDropEventUpdate,
} from "../src/core/game/GameUpdates";
import { createGameRunner } from "../src/core/GameRunner";
import { GameStartInfo, SupplyDropFrequency, Turn } from "../src/core/Schemas";
import { GameServer } from "../src/server/GameServer";
import { NodeGameMapLoader } from "./perf/fullgame/NodeGameMapLoader";
import { setup } from "./util/Setup";

interface ClientPeer {
  game: Game;
  exec: Executor;
  sde: SupplyDropExecution;
  mgr: SupplyDropManager;
  claims: SupplyDropEventUpdate[];
  lastHash: number | null;
  fxClaims: Array<{
    dropId: string | number;
    claimingId: number;
    gold: number;
    troops: number;
  }>;
}

async function createPeer(gameID: string): Promise<ClientPeer> {
  const game = await setup("plains", { instantBuild: true }, [
    new PlayerInfo("humanA", PlayerType.Human, "client_a", "human_a"),
    new PlayerInfo("humanB", PlayerType.Human, "client_b", "human_b"),
    new PlayerInfo("botAI", PlayerType.Bot, null, "bot_ai"),
    new PlayerInfo("nationAI", PlayerType.Nation, null, "nation_ai"),
  ]);

  // Seed separate territories for Human A, Human B, Bot, Nation
  game.player("human_a").conquer(game.ref(10, 10));
  game.player("human_b").conquer(game.ref(20, 20));
  game.player("bot_ai").conquer(game.ref(30, 30));
  game.player("nation_ai").conquer(game.ref(40, 40));

  const exec = new Executor(game, gameID, "client_a");
  const sde = new SupplyDropExecution(gameID, 450, 2, 10);
  game.addExecution(sde);
  // Advance tick 0 so SupplyDropExecution is initialized and active in execs
  game.executeNextTick();

  // Mock-minimal canvas-free SupplyDropManager in authoritative mode
  const fakePools = {
    spawnBeaconRing: () => {},
    spawnFloatingText: () => {},
  };
  const fakeEngine = {
    pools: fakePools,
    setSupplyCrates: () => {},
  };
  const mgr = new SupplyDropManager(fakeEngine as never, fakePools as never);
  mgr.authoritativeMode = true;

  return { game, exec, sde, mgr, claims: [], lastHash: null, fxClaims: [] };
}

function stepBothPeers(
  peerA: ClientPeer,
  peerB: ClientPeer,
  turn: Turn,
  spawnTile?: number,
): void {
  for (const peer of [peerA, peerB]) {
    if (spawnTile !== undefined) {
      peer.game.addExecution({
        isActive: () => false,
        activeDuringSpawnPhase: () => false,
        init: (_mg: Game, ticks: number) => {
          peer.sde.spawnDropAt(spawnTile, ticks);
        },
        tick: () => {},
      });
    }
    const turnExecs = peer.exec.createExecs(turn);
    peer.game.addExecution(...turnExecs);
    const updates = peer.game.executeNextTick();
    const hashes = updates[GameUpdateType.Hash] as HashUpdate[] | undefined;
    if (hashes && hashes.length > 0) {
      peer.lastHash = hashes[hashes.length - 1].hash;
    }
    const events = updates[GameUpdateType.SupplyDropEvent] as
      | SupplyDropEventUpdate[]
      | undefined;
    if (events) {
      for (const ev of events) {
        if (ev.action === "spawn") {
          peer.mgr.applyAuthoritativeSpawn(
            ev.dropId,
            ev.tile,
            peer.game.x(ev.tile),
            peer.game.y(ev.tile),
            ev.troops,
            ev.gold,
            ev.tier,
            ev.playerSmallId ?? null,
          );
        } else if (ev.action === "claim") {
          peer.claims.push(ev);
          peer.mgr.applyAuthoritativeClaim(
            ev.dropId,
            ev.tile,
            peer.game.x(ev.tile),
            peer.game.y(ev.tile),
            ev.troops,
            ev.gold,
            ev.tier,
            ev.playerSmallId ?? 0,
            (drop, claimingId) => {
              peer.fxClaims.push({
                dropId: drop.id,
                claimingId,
                gold: drop.gold,
                troops: drop.troops,
              });
            },
          );
        }
      }
    }
  }
}

describe("Mission 22.1: Two-Client Multiplayer Supply Drop Parity & Human Once-Only Claim", () => {
  test("AI supply drop auto-claim produces identical resource deltas, events, crate removal, and hashes across both clients", async () => {
    const peerA = await createPeer("mp_ai_parity");
    const peerB = await createPeer("mp_ai_parity");

    const botBeforeGoldA = peerA.game.player("bot_ai").gold();
    const botBeforeTroopsA = peerA.game.player("bot_ai").troops();

    // Tick 0: spawn supply drop over Bot AI territory on both synced peers
    stepBothPeers(
      peerA,
      peerB,
      { turnNumber: 0, intents: [] },
      peerA.game.ref(30, 30),
    );

    expect(peerA.mgr.getActiveDrops().length).toBe(1);
    expect(peerB.mgr.getActiveDrops().length).toBe(1);

    // Ticks 2..10 (still descending: 10 ticks total from spawnTick=1) -> must NOT auto-claim
    for (let t = 2; t <= 10; t++) {
      stepBothPeers(peerA, peerB, { turnNumber: t, intents: [] });
      expect(peerA.claims.length).toBe(0);
      expect(peerB.claims.length).toBe(0);
    }

    // Tick 11: drop lands -> Bot AI automatically claims identically on BOTH peers
    stepBothPeers(peerA, peerB, { turnNumber: 11, intents: [] });

    expect(peerA.claims.length).toBe(1);
    expect(peerB.claims.length).toBe(1);
    expect(peerA.claims[0]).toEqual(peerB.claims[0]);
    expect(peerA.claims[0].gold).toBeGreaterThanOrEqual(80_000);
    expect(peerA.claims[0].troops).toBeGreaterThanOrEqual(8_000);

    const botA = peerA.game.player("bot_ai");
    const botB = peerB.game.player("bot_ai");
    expect(botA.gold() - botBeforeGoldA).toBe(BigInt(peerA.claims[0].gold));
    expect(botA.troops() - botBeforeTroopsA).toBe(peerA.claims[0].troops);
    expect(botB.gold()).toBe(botA.gold());
    expect(botB.troops()).toBe(botA.troops());

    // Crate visuals removed cleanly on both peers; no duplicate grants on subsequent ticks
    expect(peerA.mgr.getActiveDrops().filter((d) => !d.collected).length).toBe(
      0,
    );
    expect(peerB.mgr.getActiveDrops().filter((d) => !d.collected).length).toBe(
      0,
    );

    for (let t = 11; t <= 105; t++) {
      stepBothPeers(peerA, peerB, { turnNumber: t, intents: [] });
    }
    expect(peerA.claims.length).toBe(1);
    expect(peerB.claims.length).toBe(1);
    expect(peerA.fxClaims).toEqual(peerB.fxClaims);
    expect(peerA.lastHash).not.toBeNull();
    expect(peerA.lastHash).toBe(peerB.lastHash);
  });

  test("Human click-to-claim grants resources strictly once across peers and rejects alien/duplicate clicks", async () => {
    const peerA = await createPeer("mp_human_parity");
    const peerB = await createPeer("mp_human_parity");

    const humanTile = peerA.game.ref(10, 10);
    const startGold = peerA.game.player("human_a").gold();
    const startTroops = peerA.game.player("human_a").troops();

    // Tick 0: spawn on Human A's territory
    stepBothPeers(peerA, peerB, { turnNumber: 0, intents: [] }, humanTile);

    // Advance ticks 2..11 so crate lands (still uncollected because humans claim manually)
    for (let t = 2; t <= 11; t++) {
      stepBothPeers(peerA, peerB, { turnNumber: t, intents: [] });
      peerA.mgr.update(350);
      peerB.mgr.update(350);
    }
    expect(peerA.claims.length).toBe(0);
    expect(peerB.claims.length).toBe(0);

    // Client-side click probe on Human A checks eligibility & produces exact ClaimSupplyDrop payload
    const humanA = peerA.game.player("human_a");
    const clickRes = peerA.mgr.tryClaimAt(
      peerA.game.x(humanTile),
      peerA.game.y(humanTile),
      { id: () => humanA.id(), smallID: () => humanA.smallID() },
      (tile) => peerA.game.ownerID(tile),
    );
    expect(clickRes.handled).toBe(true);
    expect(clickRes.success).toBe(true);
    expect(clickRes.dropId).toBe(1);

    // Enemy Human B click probe on Human A's crate must fail cleanly client-side
    const humanB = peerB.game.player("human_b");
    const enemyProbe = peerB.mgr.tryClaimAt(
      peerB.game.x(humanTile),
      peerB.game.y(humanTile),
      { id: () => humanB.id(), smallID: () => humanB.smallID() },
      (tile) => peerB.game.ownerID(tile),
    );
    expect(enemyProbe.handled).toBe(true);
    expect(enemyProbe.success).toBe(false);

    // Submit BOTH an invalid alien claim by client_b AND duplicate rapid clicks by client_a in the same turn
    stepBothPeers(peerA, peerB, {
      turnNumber: 11,
      intents: [
        {
          type: "claim_supply_drop",
          clientID: "client_b",
          dropId: 1,
          tile: humanTile,
        },
        {
          type: "claim_supply_drop",
          clientID: "client_a",
          dropId: 1,
          tile: humanTile,
        },
        {
          type: "claim_supply_drop",
          clientID: "client_a",
          dropId: 1,
          tile: humanTile,
        },
      ],
    });

    // Resources granted strictly ONCE and identically on both peers
    expect(peerA.claims.length).toBe(1);
    expect(peerB.claims.length).toBe(1);
    expect(peerA.claims[0]).toEqual(peerB.claims[0]);

    const hA_on_A = peerA.game.player("human_a");
    const hA_on_B = peerB.game.player("human_a");
    expect(hA_on_A.gold() - startGold).toBe(BigInt(peerA.claims[0].gold));
    expect(hA_on_A.troops() - startTroops).toBe(peerA.claims[0].troops);
    expect(hA_on_B.gold()).toBe(hA_on_A.gold());
    expect(hA_on_B.troops()).toBe(hA_on_A.troops());
    expect(peerB.game.player("human_b").gold()).toBe(
      peerA.game.player("human_b").gold(),
    );

    // Subsequent duplicate claim intent on later turn must be a no-op
    stepBothPeers(peerA, peerB, {
      turnNumber: 12,
      intents: [
        {
          type: "claim_supply_drop",
          clientID: "client_a",
          dropId: 1,
          tile: humanTile,
        },
      ],
    });
    for (let t = 13; t <= 105; t++) {
      stepBothPeers(peerA, peerB, { turnNumber: t, intents: [] });
    }
    expect(peerA.claims.length).toBe(1);
    expect(peerA.lastHash).not.toBeNull();
    expect(peerA.lastHash).toBe(peerB.lastHash);
  });

  test.each<{
    frequency: SupplyDropFrequency;
    expectedActiveSpawnTicks: number[];
    expectedMaxActive: number;
    runActiveTicks: number;
  }>([
    {
      frequency: "normal",
      expectedActiveSpawnTicks: [450, 900],
      expectedMaxActive: 2,
      runActiveTicks: 920,
    },
    {
      frequency: "rapid",
      expectedActiveSpawnTicks: [200, 400],
      expectedMaxActive: 2,
      runActiveTicks: 620,
    },
    {
      frequency: "extreme",
      expectedActiveSpawnTicks: [200, 400, 600],
      expectedMaxActive: 3,
      runActiveTicks: 820,
    },
  ])(
    "GameRunner two-peer parity respects $frequency supply-drop settings independently of localStorage",
    async ({
      frequency,
      expectedActiveSpawnTicks,
      expectedMaxActive,
      runActiveTicks,
    }) => {
      const mapLoader = new NodeGameMapLoader(
        path.resolve(__dirname, "../resources/maps"),
      );
      const gameStart: GameStartInfo = {
        gameID: `runner_parity_${frequency}`,
        lobbyCreatedAt: 1000,
        players: [
          {
            clientID: "client_host",
            username: "HostPlayer",
            clanTag: null,
            cosmetics: {},
            isLobbyCreator: true,
          },
          {
            clientID: "client_joiner",
            username: "JoinerPlayer",
            clanTag: null,
            cosmetics: {},
            isLobbyCreator: false,
          },
        ],
        config: {
          gameMap: GameMapType.Asia,
          gameMapSize: GameMapSize.Normal,
          gameType: GameType.Private,
          gameMode: GameMode.FFA,
          difficulty: Difficulty.Easy,
          donateGold: false,
          donateTroops: false,
          nations: "disabled",
          bots: 0,
          infiniteGold: false,
          infiniteTroops: false,
          instantBuild: false,
          randomSpawn: true,
          supplyDropFrequency: frequency,
        },
      };

      const peerEvents: Array<{
        spawns: Array<{
          tick: number;
          dropId: number;
          tile: number;
          troops: number;
          gold: number;
          tier: string;
        }>;
        lastHash: number | null;
      }> = [
        { spawns: [], lastHash: null },
        { spawns: [], lastHash: null },
      ];

      // Simulate mismatched localStorage on Joiner browser before creating runners
      const origStorage = (globalThis as { localStorage?: Storage })
        .localStorage;
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: () =>
          JSON.stringify({
            matchPace: 2.0,
            dropFrequency: frequency === "normal" ? "extreme" : "normal",
            suddenDeathTimer: 180,
          }),
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      };

      try {
        const runners = await Promise.all([
          createGameRunner(gameStart, "client_host", mapLoader, (gu) => {
            if ("errMsg" in gu) {
              throw new Error(gu.errMsg);
            }
            const hashes = gu.updates[GameUpdateType.Hash] as
              | HashUpdate[]
              | undefined;
            if (hashes && hashes.length > 0) {
              peerEvents[0].lastHash = hashes[hashes.length - 1].hash;
            }
            const events = gu.updates[GameUpdateType.SupplyDropEvent] as
              | SupplyDropEventUpdate[]
              | undefined;
            if (events) {
              for (const ev of events) {
                if (ev.action === "spawn") {
                  peerEvents[0].spawns.push({
                    tick: gu.tick,
                    dropId: ev.dropId,
                    tile: ev.tile,
                    troops: ev.troops,
                    gold: ev.gold,
                    tier: ev.tier,
                  });
                }
              }
            }
          }),
          createGameRunner(gameStart, "client_joiner", mapLoader, (gu) => {
            if ("errMsg" in gu) {
              throw new Error(gu.errMsg);
            }
            const hashes = gu.updates[GameUpdateType.Hash] as
              | HashUpdate[]
              | undefined;
            if (hashes && hashes.length > 0) {
              peerEvents[1].lastHash = hashes[hashes.length - 1].hash;
            }
            const events = gu.updates[GameUpdateType.SupplyDropEvent] as
              | SupplyDropEventUpdate[]
              | undefined;
            if (events) {
              for (const ev of events) {
                if (ev.action === "spawn") {
                  peerEvents[1].spawns.push({
                    tick: gu.tick,
                    dropId: ev.dropId,
                    tile: ev.tile,
                    troops: ev.troops,
                    gold: ev.gold,
                    tier: ev.tier,
                  });
                }
              }
            }
          }),
        ]);

        // Advance through random-spawn phase (151 ticks) plus target active ticks
        const totalTurns = 152 + runActiveTicks;
        let firstActiveTick = -1;
        for (let t = 0; t < totalTurns; t++) {
          const turn: Turn = { turnNumber: t, intents: [] };
          runners[0].addTurn(turn);
          runners[1].addTurn(turn);
          await runners[0].executeNextTick();
          await runners[1].executeNextTick();
          if (firstActiveTick === -1 && !runners[0].game.inSpawnPhase()) {
            firstActiveTick = runners[0].game.ticks();
          }
        }

        expect(firstActiveTick).toBeGreaterThan(0);
        // SupplyDropExecution is inactive while SpawnTimerExecution runs the turn that ends spawn phase,
        // so active ticks begin on the tick immediately following firstActiveTick.
        const relativeTicks0 = peerEvents[0].spawns.map(
          (s) => s.tick - firstActiveTick,
        );
        expect(relativeTicks0).toEqual(expectedActiveSpawnTicks);
        expect(peerEvents[0].spawns).toEqual(peerEvents[1].spawns);
        expect(peerEvents[0].spawns.length).toBe(expectedMaxActive);
        expect(peerEvents[0].lastHash).not.toBeNull();
        expect(peerEvents[0].lastHash).toBe(peerEvents[1].lastHash);
      } finally {
        (globalThis as { localStorage?: Storage }).localStorage = origStorage;
      }
    },
    30000,
  );

  test("GameServer.updateGameConfig propagates supplyDropFrequency and SupplyDropManager stays deterministic across matchPace multipliers", () => {
    const logger = {
      child: function () {
        return this;
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const server = new GameServer(
      "lobby_supply_drop",
      logger as never,
      Date.now(),
      {
        gameMap: GameMapType.Asia,
        gameMapSize: GameMapSize.Normal,
        gameType: GameType.Private,
        gameMode: GameMode.FFA,
        difficulty: Difficulty.Easy,
        donateGold: false,
        donateTroops: false,
        nations: "disabled",
        bots: 0,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
    );

    server.updateGameConfig({ supplyDropFrequency: "extreme" });
    expect(server.gameConfig.supplyDropFrequency).toBe("extreme");
    server.updateGameConfig({ supplyDropFrequency: "normal" });
    expect(server.gameConfig.supplyDropFrequency).toBe("normal");

    // Verify matchPace visual delta multipliers (1.0x, 1.5x, 2.0x) never trigger duplicate local spawns
    // when authoritativeMode=true
    for (const pace of [1.0, 1.5, 2.0]) {
      let localSpawns = 0;
      const fakePools = {
        spawnBeaconRing: () => {},
        spawnFloatingText: () => {},
      };
      const fakeEngine = {
        pools: fakePools,
        setSupplyCrates: () => {},
      };
      const mgr = new SupplyDropManager(
        fakeEngine as never,
        fakePools as never,
      );
      mgr.configure({ intervalSec: 20, maxActiveCrates: 3 });
      mgr.authoritativeMode = true;

      for (let step = 0; step < 30; step++) {
        mgr.update(1000 * pace, undefined, () => {
          localSpawns++;
          return { tile: 1, x: 1, y: 1, ownerID: null };
        });
      }
      expect(localSpawns).toBe(0);
      expect(mgr.getEvaluationIntervalSec()).toBe(20);
      expect(mgr.getMaxActiveCrates()).toBe(3);
    }
  });
});
