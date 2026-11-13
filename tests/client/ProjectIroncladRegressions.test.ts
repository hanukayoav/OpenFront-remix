import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  ClientGameRunner,
  type LobbyConfig,
} from "../../src/client/ClientGameRunner";
import type { Controller } from "../../src/client/Controller";
import { AttackingTroopsController } from "../../src/client/controllers/AttackingTroopsController";
import { BuildPreviewController } from "../../src/client/controllers/BuildPreviewController";
import { WarshipSelectionController } from "../../src/client/controllers/WarshipSelectionController";
import { MatchAnalytics } from "../../src/client/graphics/engine/MatchAnalytics";
import { WebAudioEngine } from "../../src/client/graphics/engine/WebAudioEngine";
import { GameRenderer } from "../../src/client/hud/GameRenderer";
import { ActionableEvents } from "../../src/client/hud/layers/ActionableEvents";
import { AttacksDisplay } from "../../src/client/hud/layers/AttacksDisplay";
import { BuildMenu } from "../../src/client/hud/layers/BuildMenu";
import { ChatDisplay } from "../../src/client/hud/layers/ChatDisplay";
import { ControlPanel } from "../../src/client/hud/layers/ControlPanel";
import { EmojiTable } from "../../src/client/hud/layers/EmojiTable";
import { EventsDisplay } from "../../src/client/hud/layers/EventsDisplay";
import { GameLeftSidebar } from "../../src/client/hud/layers/GameLeftSidebar";
import { GameRightSidebar } from "../../src/client/hud/layers/GameRightSidebar";
import { HeadsUpMessage } from "../../src/client/hud/layers/HeadsUpMessage";
import { ImmunityTimer } from "../../src/client/hud/layers/ImmunityTimer";
import { ReplayPanel } from "../../src/client/hud/layers/ReplayPanel";
import { SpawnTimer } from "../../src/client/hud/layers/SpawnTimer";
import { TacticalOverlaySelector } from "../../src/client/hud/layers/TacticalOverlaySelector";
import { UnitDisplay } from "../../src/client/hud/layers/UnitDisplay";
import { WinModal } from "../../src/client/hud/layers/WinModal";
import { LocalServer } from "../../src/client/LocalServer";
import type { MapRenderer } from "../../src/client/render/gl";
import type { TransformHandler } from "../../src/client/TransformHandler";
import {
  BuildUnitIntentEvent,
  SendAttackIntentEvent,
  SendEmojiIntentEvent,
  SendQuickChatEvent,
  SendSpawnIntentEvent,
  SendTargetPlayerIntentEvent,
  Transport,
} from "../../src/client/Transport";
import type { UIState } from "../../src/client/UIState";
import type { GameView, PlayerView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { UserSettings } from "../../src/core/game/UserSettings";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  public readyState: number = MockWebSocket.CONNECTING;
  public sent: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public closeCalls = 0;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error(`InvalidStateError: readyState=${this.readyState}`);
    }
    this.sent.push(data);
  }

  close() {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSED;
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  triggerClose(code: number, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function createFakeLobbyConfig(
  overrides: Partial<LobbyConfig> = {},
): LobbyConfig {
  return {
    gameID: "ironclad-test-game",
    playerName: "Tester",
    playerRole: 0 as unknown as LobbyConfig["playerRole"],
    gameStartInfo: {
      gameID: "ironclad-test-game",
      listed: false,
      players: [],
      config: {
        gameType: GameType.Public,
        gameMode: GameMode.FFA,
      } as unknown as NonNullable<LobbyConfig["gameStartInfo"]>["config"],
    },
    ...overrides,
  } as LobbyConfig;
}

function setTestBootstrapConfig() {
  (
    window as unknown as { BOOTSTRAP_CONFIG?: Record<string, unknown> }
  ).BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 2,
    turnstileSiteKey: "",
    jwtAudience: "test",
    instanceId: "local",
    gitCommit: "test",
  };
  ClientEnv.reset();
}

async function flushMicrotasks(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makeStartGameMessage(turns: Array<{ turnNumber: number }> = []) {
  return {
    type: "start",
    lobbyCreatedAt: 1000,
    myClientID: "client01",
    turns: turns.map((t) => ({
      turnNumber: t.turnNumber,
      intents: [],
    })),
    gameStartInfo: {
      gameID: "game0001",
      lobbyCreatedAt: 1000,
      players: [],
      config: {
        gameMap: GameMapType.World,
        gameMapSize: GameMapSize.Normal,
        difficulty: Difficulty.Medium,
        donateGold: false,
        donateTroops: false,
        gameType: GameType.Public,
        gameMode: GameMode.FFA,
        nations: 1,
        bots: 0,
        randomSpawn: false,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
      },
    },
  };
}

describe("Project IRONCLAD regressions", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    localStorage.clear();
    sessionStorage.clear();
    setTestBootstrapConfig();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ClientEnv.reset();
    document.body.innerHTML = "";
  });

  describe("Transport authentication, queue ordering, staleness, and reconnect hardening", () => {
    it("authenticates and rejoins BEFORE flushing buffered intents in FIFO order", async () => {
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);
      const syncOrder: string[] = [];

      transport.connect(
        () => {
          syncOrder.push("onconnect");
          void transport.rejoinGame(4);
        },
        (msg) => {
          syncOrder.push(`onmessage:${msg.type}`);
        },
      );

      const ws1 = MockWebSocket.instances[0];
      expect(ws1).toBeDefined();

      // Important actions emitted while CONNECTING must buffer, not send or throw.
      bus.emit(new SendSpawnIntentEvent(101));
      bus.emit(new BuildUnitIntentEvent(UnitType.City, 202));
      bus.emit(new SendAttackIntentEvent("p2", 500, 303));
      expect(ws1.sent).toHaveLength(0);

      // Opening socket runs onconnect() -> async getPlayToken() -> sends "rejoin",
      // and MUST NOT flush queued gameplay intents until server state sync arrives.
      ws1.triggerOpen();
      await flushMicrotasks();

      expect(ws1.sent).toHaveLength(1);
      const firstSent = JSON.parse(ws1.sent[0]);
      expect(firstSent.type).toBe("rejoin");
      expect(firstSent.lastTurn).toBe(4);
      expect(typeof firstSent.token).toBe("string");

      // Server responds with "start" (including missed turn catchup).
      ws1.triggerMessage(makeStartGameMessage([{ turnNumber: 4 }]));
      expect(syncOrder).toEqual(["onconnect", "onmessage:start"]);

      // Now all queued intents flush strictly after "rejoin" & "start", in FIFO order.
      expect(ws1.sent).toHaveLength(4);
      expect(JSON.parse(ws1.sent[1]).intent.type).toBe("spawn");
      expect(JSON.parse(ws1.sent[2]).intent.type).toBe("build_unit");
      expect(JSON.parse(ws1.sent[3]).intent.type).toBe("attack");

      transport.leaveGame();
    });

    it("handles network interruption during active gameplay and recovers after rejoin + start sync", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);
      let currentTurns = 10;

      transport.connect(
        () => {
          void transport.rejoinGame(currentTurns);
        },
        (msg) => {
          if (msg.type === "start") {
            currentTurns += msg.turns.length;
          }
        },
      );

      // Initial connection + auth + start sync
      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      await flushMicrotasks();
      ws1.triggerMessage(makeStartGameMessage([]));
      expect(ws1.sent.map((s) => JSON.parse(s).type)).toEqual(["rejoin"]);

      // Normal synced intent sends immediately
      bus.emit(new SendAttackIntentEvent("bot-1", 1200, 444));
      expect(ws1.sent).toHaveLength(2);

      // Network drops (1006); player triggers action while disconnected -> queued once, not dropped
      ws1.triggerClose(1006, "network drop");
      bus.emit(new BuildUnitIntentEvent(UnitType.Port, 555));
      expect(MockWebSocket.instances).toHaveLength(1);

      // Reconnect fires after 500ms backoff
      vi.advanceTimersByTime(500);
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = MockWebSocket.instances[1];
      ws2.triggerOpen();
      await flushMicrotasks();

      // First message on ws2 MUST be "rejoin", NOT the buffered "build_unit"
      expect(ws2.sent).toHaveLength(1);
      expect(JSON.parse(ws2.sent[0]).type).toBe("rejoin");

      // Server replies with missed turn 10 -> client applies it BEFORE buffered port build flushes
      ws2.triggerMessage(makeStartGameMessage([{ turnNumber: 10 }]));
      expect(currentTurns).toBe(11);
      expect(ws2.sent).toHaveLength(2);
      expect(JSON.parse(ws2.sent[1]).intent.type).toBe("build_unit");

      transport.leaveGame();
    });

    it("drops stale queued actions (>5s old) and never queues ephemeral/ping offline messages", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);

      transport.connect(() => {
        void transport.rejoinGame(0);
      }, vi.fn());

      const ws1 = MockWebSocket.instances[0];

      // While disconnected/connecting: old attack + ephemeral intents + offline ping
      bus.emit(new SendAttackIntentEvent("enemy", 500, 10));
      bus.emit(
        new SendEmojiIntentEvent(
          { id: () => "enemy" } as unknown as PlayerView,
          3,
        ),
      );
      bus.emit(
        new SendQuickChatEvent(
          { id: () => "enemy" } as unknown as PlayerView,
          "hello",
        ),
      );
      bus.emit(new SendTargetPlayerIntentEvent("enemy"));
      (
        transport as unknown as { sendMsg: (m: { type: "ping" }) => void }
      ).sendMsg({ type: "ping" });

      // Advance >5s so earlier attack becomes stale, then emit a fresh build intent
      vi.advanceTimersByTime(5500);
      bus.emit(new BuildUnitIntentEvent(UnitType.DefensePost, 99));

      ws1.triggerOpen();
      await flushMicrotasks();
      ws1.triggerMessage(makeStartGameMessage([]));

      const sentTypes = ws1.sent.map((raw) => {
        const p = JSON.parse(raw);
        return p.type === "intent" ? `intent:${p.intent.type}` : p.type;
      });
      expect(sentTypes).toEqual(["rejoin", "intent:build_unit"]);

      transport.leaveGame();
    });

    it("does not duplicate handshakes when join/rejoin is invoked offline before open", async () => {
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const transport = new Transport(createFakeLobbyConfig(), new EventBus());

      transport.connect(() => {
        void transport.rejoinGame(0);
      }, vi.fn());

      // Stale join/rejoin attempts while CONNECTING must not pile up into buffer
      await transport.joinGame();
      await transport.rejoinGame(0);

      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      await flushMicrotasks();
      ws1.triggerMessage(makeStartGameMessage([]));

      expect(ws1.sent).toHaveLength(1);
      expect(JSON.parse(ws1.sent[0]).type).toBe("rejoin");
      transport.leaveGame();
    });

    it("aborts queued intents and reconnects when restarted server rejects rejoin (1002)", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);

      transport.connect(() => {
        void transport.rejoinGame(25);
      }, vi.fn());

      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      await flushMicrotasks();
      ws1.triggerMessage(makeStartGameMessage([]));

      // Connection drops and player queues an attack before server restarts
      ws1.triggerClose(1006, "server rebooting");
      bus.emit(new SendAttackIntentEvent("enemy", 900, 77));

      vi.advanceTimersByTime(500);
      const ws2 = MockWebSocket.instances[1];
      ws2.triggerOpen();
      await flushMicrotasks();

      // Restarted server rejects unknown gameID with 1002
      ws2.triggerClose(1002, "Game not found");

      // Buffered attack must NEVER be sent to restarted server and no further reconnect occurs
      const sentIntents = ws2.sent.filter(
        (raw) => JSON.parse(raw).type === "intent",
      );
      expect(sentIntents).toHaveLength(0);

      // Even if UI emits another intent or timers advance, stopped transport stays dead
      bus.emit(new BuildUnitIntentEvent(UnitType.City, 88));
      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it("does NOT bypass exponential backoff when sending while CLOSING or CLOSED", () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);
      transport.connect(vi.fn(), vi.fn());

      const ws1 = MockWebSocket.instances[0];
      // Simulated CLOSING state before onclose fires
      ws1.readyState = MockWebSocket.CLOSING;

      // Rapid offline actions during CLOSING/CLOSED must schedule at most ONE backoff attempt
      bus.emit(new SendAttackIntentEvent("p2", 100, 1));
      bus.emit(new SendAttackIntentEvent("p2", 200, 2));
      expect(MockWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(499);
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      // Second failure waits 1000ms (even if intents are sent while CLOSED)
      MockWebSocket.instances[1].triggerClose(1006, "abnormal");
      bus.emit(new SendAttackIntentEvent("p2", 300, 3));
      vi.advanceTimersByTime(999);
      expect(MockWebSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(3);

      transport.leaveGame();
    });

    it("stops reconnecting permanently once MAX_RECONNECT_ATTEMPTS is exhausted", () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const bus = new EventBus();
      const transport = new Transport(createFakeLobbyConfig(), bus);
      transport.connect(vi.fn(), vi.fn());

      // Exhaust 10 reconnect attempts (1 initial + 10 retries = 11 sockets total)
      for (let i = 0; i < 10; i++) {
        MockWebSocket.instances[i].triggerClose(1006, "unreachable");
        vi.advanceTimersByTime(20_000);
      }
      expect(MockWebSocket.instances).toHaveLength(11);

      // 11th socket closes -> hits attempt limit, stops permanently
      MockWebSocket.instances[10].triggerClose(1006, "unreachable");
      vi.advanceTimersByTime(120_000);
      bus.emit(new BuildUnitIntentEvent(UnitType.City, 50));
      vi.advanceTimersByTime(120_000);
      expect(MockWebSocket.instances).toHaveLength(11);
    });

    it("cancels pending reconnects, aborts CONNECTING sockets, and ignores delayed auth on leaveGame()", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);

      let resolveFetch!: () => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise((resolve) => {
              resolveFetch = () =>
                resolve({ ok: false } as unknown as Response);
            }),
        ),
      );

      const transport = new Transport(createFakeLobbyConfig(), new EventBus());
      let connectPromise: Promise<void> | undefined;
      transport.connect(() => {
        connectPromise = transport.joinGame();
      }, vi.fn());

      // Case A: leave while async auth inside onopen is still awaiting
      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      expect(connectPromise).toBeDefined();
      transport.leaveGame();
      resolveFetch?.();
      await connectPromise;
      await flushMicrotasks();
      expect(ws1.sent).toHaveLength(0);
      expect(ws1.closeCalls).toBe(1);

      // Case B: fresh session left mid-reconnect backoff never opens another WebSocket
      MockWebSocket.instances = [];
      const transport2 = new Transport(createFakeLobbyConfig(), new EventBus());
      transport2.connect(vi.fn(), vi.fn());
      MockWebSocket.instances[0].triggerClose(1006, "drop");
      transport2.leaveGame();
      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe("Controller RAF, DOM, and timer cleanup", () => {
    it("AttackingTroopsController starts demand-driven RAF on attacks and cancels on destroy()", async () => {
      let nextId = 1;
      const callbacks = new Map<number, FrameRequestCallback>();
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      });
      const cancelSpy = vi.fn((id: number) => {
        callbacks.delete(id);
      });
      vi.stubGlobal("cancelAnimationFrame", cancelSpy);

      const defender = {
        isPlayer: () => true,
        type: () => PlayerType.Human,
      };
      const myPlayer = {
        outgoingAttacks: () => [{ id: "atk-1", targetID: 2, troops: 500 }],
        incomingAttacks: () => [],
        attackClusteredPositions: async () => [],
      };
      const gameView = {
        myPlayer: () => myPlayer,
        playerBySmallID: (id: number) => (id === 2 ? defender : null),
        updatesSinceLastTick: () => null,
      } as unknown as GameView;
      const view = {
        setAttackTroopLabels: vi.fn(),
      } as unknown as MapRenderer;

      const controller = new AttackingTroopsController(
        gameView,
        new EventBus(),
        new UserSettings(),
        view,
      );
      controller.init();
      // Demand-driven optimization: idle controller schedules no RAF loop.
      expect(callbacks.size).toBe(0);

      controller.tick();
      expect(callbacks.size).toBe(1);

      controller.destroy();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.size).toBe(0);

      // Post-destroy ticks must not restart the RAF loop.
      controller.tick();
      await Promise.resolve();
      expect(callbacks.size).toBe(0);
    });

    it("BuildPreviewController starts cursor RAF lazily and cancels on destroy()", async () => {
      let nextId = 1;
      const callbacks = new Map<number, FrameRequestCallback>();
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      });
      const cancelSpy = vi.fn((id: number) => {
        callbacks.delete(id);
      });
      vi.stubGlobal("cancelAnimationFrame", cancelSpy);

      let resolveBuildables: ((v: unknown[]) => void) | null = null;
      const myPlayer = {
        isAlive: () => true,
        gold: () => 500n,
        smallID: () => 1,
        readyMissileCount: () => 0,
        units: () => [],
        allies: () => [],
        buildables: () =>
          new Promise((resolve) => {
            resolveBuildables = resolve;
          }),
      };
      const gameView = {
        myPlayer: () => myPlayer,
        isValidCoord: () => true,
        ref: () => 42,
        isImpassable: () => false,
        x: () => 10,
        y: () => 10,
        height: () => 100,
      } as unknown as GameView;
      const transformHandler = {
        screenToWorldCoordinates: () => ({ x: 10, y: 10 }),
        screenToWorldCoordinatesFloat: () => ({ x: 10, y: 10 }),
      } as unknown as TransformHandler;
      const view = {
        updateGhostPreview: vi.fn(),
        updateNukeTrajectory: vi.fn(),
      } as unknown as MapRenderer;

      const uiState = {
        attackRatio: 20,
        ghostStructure: null as UnitType.City | null,
        rocketDirectionUp: true,
        upgradeMultiplier: 1,
      };
      const controller = new BuildPreviewController(
        gameView,
        new EventBus(),
        uiState,
        transformHandler,
        view,
        new UserSettings(),
      );
      controller.init();
      // Demand-driven optimization: idle cursor loop does not run on init().
      expect(callbacks.size).toBe(0);

      // Activate a build ghost preview to trigger the cursor RAF loop.
      uiState.ghostStructure = UnitType.City;
      controller.tick();
      (resolveBuildables as unknown as ((val: unknown[]) => void) | null)?.([
        {
          type: UnitType.City,
          canBuild: true,
          canUpgrade: false,
          upgradeTargetTile: null,
          cost: 100n,
          customFlag: false,
        },
      ]);
      await Promise.resolve();
      expect(callbacks.size).toBe(1);

      controller.destroy();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.size).toBe(0);

      // Late async buildables callback or tick after destroy() must not revive loop.
      controller.tick();
      await Promise.resolve();
      expect(callbacks.size).toBe(0);
    });

    it("WarshipSelectionController.destroy() removes #warship-drag-rect from document.body", () => {
      const controller = new WarshipSelectionController(
        {
          myPlayer: () => null,
          units: () => [],
        } as unknown as GameView,
        new EventBus(),
        {} as unknown as TransformHandler,
        { setSelectedUnits: vi.fn() } as unknown as MapRenderer,
      );
      (
        controller as unknown as { ensureDragRectEl: () => void }
      ).ensureDragRectEl();
      expect(document.querySelectorAll("#warship-drag-rect")).toHaveLength(1);

      controller.destroy();
      expect(document.querySelectorAll("#warship-drag-rect")).toHaveLength(0);
    });

    it("ClientGameRunner.stop() before 20s cancels connection check timer so no interval leaks", () => {
      vi.useFakeTimers();
      const runner = new ClientGameRunner(
        createFakeLobbyConfig(),
        "client-1",
        new EventBus(),
        {
          initialize: vi.fn(),
          destroy: vi.fn(),
        } as unknown as GameRenderer,
        {
          initialize: vi.fn(),
          destroy: vi.fn(),
        } as unknown as ClientGameRunner["input"],
        {
          connect: vi.fn(),
          updateCallback: vi.fn(),
          joinGame: vi.fn(),
          rejoinGame: vi.fn(),
          leaveGame: vi.fn(),
          isLocal: true,
        } as unknown as Transport,
        {
          cleanup: vi.fn(),
          start: vi.fn(),
        } as unknown as ClientGameRunner["worker"],
        {} as unknown as GameView,
        {
          playBackgroundMusic: vi.fn(),
          dispose: vi.fn(),
        } as unknown as ClientGameRunner["soundManager"],
        new UserSettings(),
      );

      runner.start();
      vi.advanceTimersByTime(5000);
      runner.stop();

      const spy = vi.spyOn(globalThis, "setInterval");
      vi.advanceTimersByTime(30_000);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("HUD teardown, z-index, positioning, and localization", () => {
    it("TacticalOverlaySelector stays hidden before init(), renders translated fallback + bottom-right position on init(), and hides on destroy()", async () => {
      const selector = new TacticalOverlaySelector();
      selector.game = {} as unknown as GameView;
      selector.eventBus = new EventBus();
      document.body.append(selector);
      await selector.updateComplete;

      // Must not appear on pre-match menu
      expect(selector.querySelector("button")).toBeNull();
      expect(selector.textContent?.trim()).toBe("");

      selector.init();
      await selector.updateComplete;
      expect(selector.textContent).not.toContain("TACTICAL_OVERLAY.OFF");
      expect(selector.textContent).toContain("Off");
      const wrapper = selector.querySelector("div");
      expect(wrapper?.className).toContain("bottom-24");
      expect(wrapper?.className).toContain("right-16");

      selector.destroy();
      await selector.updateComplete;
      expect(selector.querySelector("button")).toBeNull();
      expect(selector.textContent?.trim()).toBe("");
      selector.remove();
    });

    it("WinModal.destroy() clears the 3s delayed button reveal timer and hides modal", async () => {
      vi.useFakeTimers();
      const winModal = new WinModal();
      winModal.game = {
        config: () => ({
          gameConfig: () => ({}),
          doomsdayClockConfig: () => ({ enabled: false }),
        }),
        myPlayer: () => null,
        updatesSinceLastTick: () => null,
      } as unknown as GameView;
      winModal.eventBus = new EventBus();
      vi.spyOn(
        winModal as unknown as { loadPatternContent: () => Promise<void> },
        "loadPatternContent",
      ).mockResolvedValue();

      document.body.append(winModal);
      await winModal.show();
      expect(winModal.isVisible).toBe(true);

      winModal.destroy();
      await winModal.updateComplete;
      expect(winModal.isVisible).toBe(false);

      vi.advanceTimersByTime(5000);
      expect(
        (winModal as unknown as { showButtons: boolean }).showButtons,
      ).toBe(false);
      winModal.remove();
    });

    it("GameRenderer.destroy() hides stateful HUD layers after leaving a match", async () => {
      const eventBus = new EventBus();
      const game = {
        config: () => ({
          gameConfig: () => ({
            gameMode: GameMode.FFA,
            gameType: GameType.Singleplayer,
          }),
          isReplay: () => false,
          isRandomSpawn: () => false,
          doomsdayClockConfig: () => ({ enabled: false }),
          isUnitDisabled: () => false,
          hasExtendedSpawnImmunity: () => false,
          spawnImmunityDuration: () => 0,
          numSpawnPhaseTurns: () => 10,
          troopIncreaseRate: () => 0,
        }),
        gameID: () => "g1",
        inSpawnPhase: () => false,
        ticks: () => 1,
        myPlayer: () => null,
        playerViews: () => [],
        updatesSinceLastTick: () => null,
      } as unknown as GameView;

      const left = new GameLeftSidebar();
      const right = new GameRightSidebar();
      const spawnTimer = new SpawnTimer();
      const immunityTimer = new ImmunityTimer();
      const headsUp = new HeadsUpMessage();
      const controlPanel = new ControlPanel();
      controlPanel.uiState = {
        attackRatio: 20,
        ghostStructure: null,
        rocketDirectionUp: true,
        upgradeMultiplier: 1,
      };
      const attacks = new AttacksDisplay();
      const events = new EventsDisplay();
      const actionable = new ActionableEvents();
      const chat = new ChatDisplay();
      const replay = new ReplayPanel();
      const unitDisplay = new UnitDisplay();
      const buildMenu = new BuildMenu();
      const emojiTable = new EmojiTable();

      const layers = [
        left,
        right,
        spawnTimer,
        immunityTimer,
        headsUp,
        controlPanel,
        attacks,
        events,
        actionable,
        chat,
        replay,
        unitDisplay,
        buildMenu,
        emojiTable,
      ];
      for (const l of layers) {
        (l as { game?: GameView }).game = game;
        (l as { eventBus?: EventBus }).eventBus = eventBus;
      }
      document.body.append(...layers);

      const renderer = new GameRenderer(
        {
          updateCanvasBoundingRect: vi.fn(),
          centerAll: vi.fn(),
        } as unknown as TransformHandler,
        {} as unknown as UIState,
        layers as unknown as Controller[],
        {} as unknown as GameRenderer["performanceOverlay"],
      );
      renderer.initialize();
      controlPanel.setVisibile(true);
      replay.visible = true;
      await Promise.all(layers.map((l) => l.updateComplete));

      renderer.destroy();
      await Promise.all(layers.map((l) => l.updateComplete));

      expect(left.querySelector("aside")?.className).toContain("hidden");
      expect(right.querySelector("aside")?.className).toContain("hidden");
      expect(replay.querySelector("div")).toBeNull();
      expect(unitDisplay.querySelector("div")).toBeNull();
      expect(headsUp.querySelector(".fixed")).toBeNull();
    });

    it("WebAudioEngine mute button is placed bottom-right above occlusion zone", () => {
      const audio = new WebAudioEngine();
      const btn = audio.attachMuteButton(document.body);
      expect(btn.className).toContain("bottom-24");
      expect(btn.className).toContain("right-4");
      expect(btn.className).toContain("z-[900]");
      expect(btn.className).not.toContain("top-3");
      audio.dispose();
      expect(
        document.getElementById("openfront-procedural-audio-toggle"),
      ).toBeNull();
    });

    it("MatchAnalytics victory modal renders above HUD sidebars (z-[10005])", () => {
      const analytics = new MatchAnalytics();
      const modal = analytics.showVictoryModal(
        {
          winnerName: "Tester",
          winnerColor: "#3b82f6",
          winnerId: "p1",
          victoryType: "Domination",
        },
        document.body,
      );
      expect(modal.className).toContain("z-[10005]");
      expect(modal.className).not.toContain("z-50 ");
      analytics.hideVictoryModal();
    });
  });

  describe("LocalServer replay hash safety", () => {
    it("ignores out-of-range replay hash turns without throwing", () => {
      const localServer = new LocalServer(
        createFakeLobbyConfig({
          gameRecord: {
            turns: [],
            info: {},
            gitCommit: "test",
            version: "v0.26",
          } as unknown as LobbyConfig["gameRecord"],
        }),
        true,
        new EventBus(),
      );

      expect(() => {
        localServer.onMessage({
          type: "hash",
          turnNumber: 999,
          hash: 12345,
        });
      }).not.toThrow();
    });
  });
});
