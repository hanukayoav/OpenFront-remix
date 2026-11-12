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
import { Transport } from "../../src/client/Transport";
import type { UIState } from "../../src/client/UIState";
import type { GameView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import { GameMode, GameType } from "../../src/core/game/Game";
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

describe("Project IRONCLAD regressions", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    localStorage.clear();
    setTestBootstrapConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ClientEnv.reset();
    document.body.innerHTML = "";
  });

  describe("Transport queue ordering, socket states, and reconnect backoff", () => {
    it("flushes buffered offline messages in FIFO order on socket open", () => {
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const transport = new Transport(createFakeLobbyConfig(), new EventBus());
      const onconnect = vi.fn();
      const onmessage = vi.fn();

      transport.connect(onconnect, onmessage);
      const ws1 = MockWebSocket.instances[0];
      expect(ws1).toBeDefined();

      // While CONNECTING, sendMsg should queue without throwing InvalidStateError
      (
        transport as unknown as {
          sendMsg: (m: { type: "ping" }) => void;
        }
      ).sendMsg({ type: "ping" });
      (
        transport as unknown as {
          sendMsg: (m: { type: "hash"; tick: number; hash: number }) => void;
        }
      ).sendMsg({ type: "hash", tick: 1, hash: 111 } as unknown as {
        type: "hash";
        tick: number;
        hash: number;
      });

      ws1.triggerOpen();
      expect(onconnect).toHaveBeenCalledTimes(1);
      expect(ws1.sent).toHaveLength(2);
      expect(JSON.parse(ws1.sent[0]).type).toBe("ping");
      expect(JSON.parse(ws1.sent[1]).type).toBe("hash");

      transport.leaveGame();
    });

    it("buffers instead of throwing when socket is CLOSING", () => {
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const transport = new Transport(createFakeLobbyConfig(), new EventBus());
      transport.connect(vi.fn(), vi.fn());

      const ws1 = MockWebSocket.instances[0];
      ws1.readyState = MockWebSocket.CLOSING;

      expect(() => {
        (
          transport as unknown as {
            sendMsg: (m: { type: "ping" }) => void;
          }
        ).sendMsg({ type: "ping" });
      }).not.toThrow();

      // Reconnect should have opened ws2 and queued message for FIFO flush
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = MockWebSocket.instances[1];
      ws2.triggerOpen();
      expect(ws2.sent).toHaveLength(1);
      expect(JSON.parse(ws2.sent[0]).type).toBe("ping");

      transport.leaveGame();
    });

    it("schedules bounded exponential backoff on unexpected close and cancels timer on leaveGame()", () => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
      const transport = new Transport(createFakeLobbyConfig(), new EventBus());
      transport.connect(vi.fn(), vi.fn());

      // Unexpected close triggers backoff instead of immediate tight reconnect loop
      MockWebSocket.instances[0].triggerClose(1006, "abnormal");
      expect(MockWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(499);
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      // Second consecutive failure waits 1000ms (500 * 2^1)
      MockWebSocket.instances[1].triggerClose(1006, "abnormal");
      vi.advanceTimersByTime(999);
      expect(MockWebSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(3);

      // Calling leaveGame cancels any queued reconnect timer
      MockWebSocket.instances[2].triggerClose(1006, "abnormal");
      transport.leaveGame();
      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances).toHaveLength(3);
    });
  });

  describe("Controller RAF, DOM, and timer cleanup", () => {
    it("AttackingTroopsController.destroy() cancels RAF loop", () => {
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

      const gameView = {
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
      expect(callbacks.size).toBe(1);

      controller.destroy();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.size).toBe(0);
    });

    it("BuildPreviewController.destroy() cancels cursor RAF loop", () => {
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

      const gameView = {} as unknown as GameView;
      const transformHandler = {
        screenToWorldCoordinatesFloat: () => ({ x: 0, y: 0 }),
      } as unknown as TransformHandler;
      const view = {
        updateGhostPreview: vi.fn(),
        updateNukeTrajectory: vi.fn(),
      } as unknown as MapRenderer;

      const controller = new BuildPreviewController(
        gameView,
        new EventBus(),
        {
          attackRatio: 20,
          ghostStructure: null,
          rocketDirectionUp: true,
          upgradeMultiplier: 1,
        },
        transformHandler,
        view,
        new UserSettings(),
      );
      controller.init();
      expect(callbacks.size).toBe(1);

      controller.destroy();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
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
