import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventBus } from "../../src/core/EventBus";
import {
  InputHandler,
  MouseUpEvent,
  ContextMenuEvent,
} from "../../src/client/InputHandler";
import { GameRenderer } from "../../src/client/hud/GameRenderer";
import { GameLeftSidebar } from "../../src/client/hud/layers/GameLeftSidebar";
import type { GameView } from "../../src/client/view";
import { GameMode } from "../../src/core/game/Game";
import type { UIState } from "../../src/client/UIState";
import type { TransformHandler } from "../../src/client/TransformHandler";
import type { PerformanceOverlay } from "../../src/client/hud/layers/PerformanceOverlay";

describe("Stability and Polish v1.0.4 Regressions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("EventBus.clear()", () => {
    it("removes all registered listeners", () => {
      const eventBus = new EventBus();
      let count = 0;
      class DummyEvent {}
      eventBus.on(DummyEvent, () => {
        count++;
      });
      eventBus.emit(new DummyEvent());
      expect(count).toBe(1);

      eventBus.clear();
      eventBus.emit(new DummyEvent());
      expect(count).toBe(1);
    });
  });

  describe("InputHandler touch and lifecycle", () => {
    function createMockGameView(): GameView {
      return {
        unit: () => null,
        myPlayer: () => null,
        troops: () => 0,
        inSpawnPhase: () => false,
        isOver: () => false,
        selectedUnits: () => [],
        playerViews: () => [],
        width: () => 1000,
        height: () => 1000,
        config: () => ({
          gameConfig: () => ({ gameMode: GameMode.FFA }),
          maxTroops: () => 1_000,
        }),
      } as unknown as GameView;
    }

    function createMockUIState(): UIState {
      return {
        attackRatio: 20,
        ghostStructure: null,
        rocketDirectionUp: true,
        upgradeMultiplier: 1,
      };
    }

    it("emits MouseUpEvent on quick touch tap (<800ms)", async () => {
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      const eventBus = new EventBus();
      const input = new InputHandler(
        createMockGameView(),
        createMockUIState(),
        canvas,
        eventBus,
      );
      input.initialize();

      let mouseUpFired = false;
      let contextMenuFired = false;
      eventBus.on(MouseUpEvent, () => {
        mouseUpFired = true;
      });
      eventBus.on(ContextMenuEvent, () => {
        contextMenuFired = true;
      });

      const downEvt = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.assign(downEvt, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
        x: 100,
        y: 100,
        button: 0,
      });
      canvas.dispatchEvent(downEvt);

      const upEvt = new Event("pointerup", { bubbles: true, cancelable: true });
      Object.assign(upEvt, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
        x: 100,
        y: 100,
        button: 0,
      });
      window.dispatchEvent(upEvt);

      expect(mouseUpFired).toBe(true);
      expect(contextMenuFired).toBe(false);

      input.destroy();
      canvas.remove();
    });

    it("emits ContextMenuEvent on touch long-press (>=800ms)", async () => {
      vi.useFakeTimers();
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      const eventBus = new EventBus();
      const input = new InputHandler(
        createMockGameView(),
        createMockUIState(),
        canvas,
        eventBus,
      );
      input.initialize();

      let mouseUpFired = false;
      let contextMenuFired = false;
      eventBus.on(MouseUpEvent, () => {
        mouseUpFired = true;
      });
      eventBus.on(ContextMenuEvent, () => {
        contextMenuFired = true;
      });

      const downEvt = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.assign(downEvt, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
        x: 100,
        y: 100,
        button: 0,
      });
      canvas.dispatchEvent(downEvt);

      // Advance time past the 800ms long-press threshold
      vi.advanceTimersByTime(850);

      const upEvt = new Event("pointerup", { bubbles: true, cancelable: true });
      Object.assign(upEvt, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
        x: 100,
        y: 100,
        button: 0,
      });
      window.dispatchEvent(upEvt);

      expect(contextMenuFired).toBe(true);
      expect(mouseUpFired).toBe(false);

      input.destroy();
      canvas.remove();
      vi.useRealTimers();
    });

    it("destroys cleanly and removes window event listeners", () => {
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      const eventBus = new EventBus();
      const input = new InputHandler(
        createMockGameView(),
        createMockUIState(),
        canvas,
        eventBus,
      );
      input.initialize();

      const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
      input.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalled();
      removeEventListenerSpy.mockRestore();
      canvas.remove();
    });
  });

  describe("GameRenderer lifecycle", () => {
    it("destroys and removes window resize listener", () => {
      const mockTransformHandler = {
        updateCanvasBoundingRect: vi.fn(),
        centerAll: vi.fn(),
      } as unknown as TransformHandler;
      const mockUIState = {} as UIState;
      const mockPerfOverlay = {} as PerformanceOverlay;

      const renderer = new GameRenderer(
        mockTransformHandler,
        mockUIState,
        [],
        mockPerfOverlay,
      );
      renderer.initialize();

      const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
      renderer.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );
      removeEventListenerSpy.mockRestore();
    });
  });

  describe("GameLeftSidebar persistence", () => {
    it("restores saved open leaderboard preference from localStorage on init", async () => {
      localStorage.setItem("openfront_leaderboard_open", "true");
      const game = {
        config: () => ({ gameConfig: () => ({ gameMode: GameMode.FFA }) }),
        gameID: () => "test-id",
        inSpawnPhase: () => true,
        myPlayer: () => null,
        playerViews: () => [],
      } as unknown as GameView;

      const sidebar = new GameLeftSidebar();
      sidebar.game = game;
      sidebar.eventBus = new EventBus();
      document.body.append(sidebar);
      sidebar.init();
      await sidebar.updateComplete;

      const playerStats = sidebar.querySelector("player-stats") as HTMLElement & {
        visible: boolean;
      };
      expect(playerStats.visible).toBe(true);
      sidebar.remove();
    });

    it("restores saved closed leaderboard preference from localStorage on init", async () => {
      localStorage.setItem("openfront_leaderboard_open", "false");
      const game = {
        config: () => ({ gameConfig: () => ({ gameMode: GameMode.FFA }) }),
        gameID: () => "test-id",
        inSpawnPhase: () => true,
        myPlayer: () => null,
        playerViews: () => [],
      } as unknown as GameView;

      const sidebar = new GameLeftSidebar();
      sidebar.game = game;
      sidebar.eventBus = new EventBus();
      document.body.append(sidebar);
      sidebar.init();
      await sidebar.updateComplete;

      const playerStats = sidebar.querySelector("player-stats") as HTMLElement & {
        visible: boolean;
      };
      expect(playerStats.visible).toBe(false);
      sidebar.remove();
    });
  });
});
