import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../../src/core/EventBus";
import { SendAttackIntentEvent } from "../../../src/client/Transport";
import { Cell } from "../../../src/core/game/Game";
import { DualLayerEngine } from "../../../src/client/graphics/engine/DualLayerEngine";
import { InputManager } from "../../../src/client/graphics/engine/InputManager";

describe("Responsive Touch and Mobile Control Layer (InputManager)", () => {
  let container: HTMLElement;
  let mockEngine: DualLayerEngine;
  let mockTransformHandler: {
    scale: number;
    offsetX: number;
    offsetY: number;
    updateCanvasBoundingRect: ReturnType<typeof vi.fn>;
    screenToWorldCoordinates: ReturnType<typeof vi.fn>;
  };
  let mockGameView: {
    width: () => number;
    height: () => number;
    x: (tile: number) => number;
    y: (tile: number) => number;
    ref: (x: number, y: number) => number;
    isWater: (tile: number) => boolean;
    isValidCoord: (x: number, y: number) => boolean;
    ownerID: (tile: number) => number;
    myPlayer: () => {
      smallID: () => number;
      id: () => string;
      state?: { spawnTile?: number };
    } | null;
  };
  let eventBus: EventBus;
  let mockAudioEngine: {
    playTroopLaunch: ReturnType<typeof vi.fn>;
    playDropClaim: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockEngine = {
      resize: vi.fn(),
      markStaticDirty: vi.fn(),
      spawnBeaconRing: vi.fn(),
    } as unknown as DualLayerEngine;

    mockTransformHandler = {
      scale: 1.5,
      offsetX: 100,
      offsetY: 100,
      updateCanvasBoundingRect: vi.fn(),
      screenToWorldCoordinates: vi.fn((x: number, y: number) => new Cell(Math.floor(x / 10), Math.floor(y / 10))),
    };

    mockGameView = {
      width: () => 100,
      height: () => 100,
      x: (tile: number) => tile % 100,
      y: (tile: number) => Math.floor(tile / 100),
      ref: (x: number, y: number) => y * 100 + x,
      isWater: () => false,
      isValidCoord: () => true,
      ownerID: (tile: number) => (tile === 42 ? 1 : 2),
      myPlayer: () => ({
        smallID: () => 1,
        id: () => "player_me",
        state: { spawnTile: 42 },
      }),
    };

    eventBus = new EventBus();
    mockAudioEngine = {
      playTroopLaunch: vi.fn(),
      playDropClaim: vi.fn(),
    };
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("Touch Traversal (Pan & Pinch-to-Zoom)", () => {
    it("drags the map view via single-finger pan", () => {
      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
      });

      // 1. Touch start at (100, 100)
      const touchStart = new Event("touchstart", { cancelable: true }) as any;
      touchStart.touches = [{ identifier: 1, clientX: 100, clientY: 100 }];
      container.dispatchEvent(touchStart);

      // 2. Touch move to (130, 160) -> deltaX = 30, deltaY = 60
      const touchMove = new Event("touchmove", { cancelable: true }) as any;
      touchMove.touches = [{ identifier: 1, clientX: 130, clientY: 160 }];
      container.dispatchEvent(touchMove);

      // Scale is 1.5 -> deltaX / 1.5 = 20, deltaY / 1.5 = 40
      expect(mockTransformHandler.offsetX).toBeCloseTo(80, 1);
      expect(mockTransformHandler.offsetY).toBeCloseTo(60, 1);
      expect(mockTransformHandler.updateCanvasBoundingRect).toHaveBeenCalled();

      inputManager.dispose();
    });

    it("zooms the camera smoothly via two-finger pinch gesture", () => {
      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
      });

      // 1. Touch start with 2 fingers 50px apart
      const touchStart = new Event("touchstart", { cancelable: true }) as any;
      touchStart.touches = [
        { identifier: 1, clientX: 100, clientY: 100 },
        { identifier: 2, clientX: 150, clientY: 100 },
      ];
      container.dispatchEvent(touchStart);

      // 2. Pinch spread out to 100px apart (+50px spread)
      const touchMove = new Event("touchmove", { cancelable: true }) as any;
      touchMove.touches = [
        { identifier: 1, clientX: 75, clientY: 100 },
        { identifier: 2, clientX: 175, clientY: 100 },
      ];
      container.dispatchEvent(touchMove);

      // Scale should have increased from initial 1.5
      expect(mockTransformHandler.scale).toBeGreaterThan(1.5);
      expect(mockTransformHandler.updateCanvasBoundingRect).toHaveBeenCalled();

      inputManager.dispose();
    });
  });

  describe("Prevent Default Touch Gestures", () => {
    it("intercepts touchstart, touchmove, and touchend with preventDefault to eliminate page refresh and native zoom", () => {
      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
      });

      const touchStart = new Event("touchstart", { cancelable: true }) as any;
      touchStart.touches = [{ identifier: 1, clientX: 50, clientY: 50 }];
      const preventDefaultSpy = vi.spyOn(touchStart, "preventDefault");

      container.dispatchEvent(touchStart);
      expect(preventDefaultSpy).toHaveBeenCalled();

      inputManager.dispose();
    });
  });

  describe("Tap to Target Attack Waves", () => {
    it("first tap selects owned territory; second tap on enemy node launches attack wave", () => {
      let attackDispatched: { source: number; target: number } | null = null;

      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
        gameView: mockGameView as any,
        eventBus,
        audioEngine: mockAudioEngine as any,
        onAttackOrder: (s, t) => {
          attackDispatched = { source: s, target: t };
        },
      });

      // Mock screen to world: tap on tile 42 (owned)
      mockTransformHandler.screenToWorldCoordinates.mockReturnValueOnce(new Cell(42, 0));

      // Tap 1: Select owned territory (tile 42)
      const tap1Start = new Event("touchstart", { cancelable: true }) as any;
      tap1Start.touches = [{ identifier: 1, clientX: 100, clientY: 100 }];
      container.dispatchEvent(tap1Start);

      const tap1End = new Event("touchend", { cancelable: true }) as any;
      tap1End.touches = [];
      container.dispatchEvent(tap1End);

      expect(inputManager.getSelectedTile()).toBe(42);
      expect(mockEngine.spawnBeaconRing).toHaveBeenCalledWith(42, 0, "#10b981", 4, 24, 600, 2);

      // Mock screen to world: tap on enemy tile 88 (owner 2)
      mockTransformHandler.screenToWorldCoordinates.mockReturnValueOnce(new Cell(88, 0));

      const attackIntentSpy = vi.fn();
      eventBus.on(SendAttackIntentEvent, attackIntentSpy);

      // Tap 2: Target enemy territory (tile 88)
      const tap2Start = new Event("touchstart", { cancelable: true }) as any;
      tap2Start.touches = [{ identifier: 1, clientX: 105, clientY: 105 }];
      container.dispatchEvent(tap2Start);

      const tap2End = new Event("touchend", { cancelable: true }) as any;
      tap2End.touches = [];
      container.dispatchEvent(tap2End);

      expect(attackDispatched).toEqual({ source: 42, target: 88 });
      expect(attackIntentSpy).toHaveBeenCalled();
      expect(mockAudioEngine.playTroopLaunch).toHaveBeenCalled();
      expect(inputManager.getSelectedTile()).toBeNull(); // Cleared after launch

      inputManager.dispose();
    });
  });

  describe("Double Tap Capital", () => {
    it("instantly centers camera view over player capital node on rapid double tap", () => {
      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
        gameView: mockGameView as any,
        audioEngine: mockAudioEngine as any,
      });

      const triggered = inputManager.triggerDoubleTapCapital();
      expect(triggered).toBe(true);

      // Player capital is tile 42 -> x: 42, y: 0
      expect(mockTransformHandler.offsetX).toBe(42);
      expect(mockTransformHandler.offsetY).toBe(0);
      expect(mockEngine.spawnBeaconRing).toHaveBeenCalledWith(42, 0, "#38bdf8", 4, 32, 800, 2);
      expect(mockAudioEngine.playDropClaim).toHaveBeenCalled();

      inputManager.dispose();
    });
  });

  describe("Responsive Viewport Resizing", () => {
    it("resizes dual layer canvases and marks static layer dirty on window resize / orientation change", () => {
      const inputManager = new InputManager({
        canvas: container,
        engine: mockEngine,
        transformHandler: mockTransformHandler as any,
      });

      inputManager.handleResize();

      expect(mockEngine.resize).toHaveBeenCalled();
      expect(mockTransformHandler.updateCanvasBoundingRect).toHaveBeenCalled();
      expect(mockEngine.markStaticDirty).toHaveBeenCalled();

      inputManager.dispose();
    });
  });
});
