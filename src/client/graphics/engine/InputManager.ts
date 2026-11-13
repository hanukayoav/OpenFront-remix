/**
 * OpenFront Responsive Touch and Mobile Control Layer (InputManager)
 *
 * Implements high-performance mobile and tablet gesture recognition for touch devices:
 * - Touch Traversal: Single-finger pan to drag the map, two-finger pinch to zoom smoothly.
 * - Tap to Target: Single tap on owned territory selects it; consecutive tap on adjacent/enemy node launches attack.
 * - Double Tap Capital: Centers the camera view instantly over player's home capital node.
 * - Prevent Default Gestures: Intercepts touchstart, touchmove, and touchend on canvas to stop pull-down refresh,
 *   page reload, and native mobile pinch zoom.
 * - Responsive Viewport Resizing: Syncs dual-layer canvases dynamically to mobile browser window dimensions,
 *   device pixel ratio (DPR), and orientation changes.
 */

import { EventBus } from "../../../core/EventBus";
import {
  SendAttackIntentEvent,
  SendClaimSupplyDropIntentEvent,
} from "../../Transport";
import { TransformHandler } from "../../TransformHandler";
import { GameView } from "../../view/GameView";
import { DualLayerEngine } from "./DualLayerEngine";
import { WebAudioEngine } from "./WebAudioEngine";

export interface InputManagerOptions {
  canvas: HTMLElement;
  engine: DualLayerEngine;
  transformHandler?: TransformHandler;
  gameView?: GameView;
  eventBus?: EventBus;
  audioEngine?: WebAudioEngine;
  onAttackOrder?: (sourceTile: number, targetTile: number) => void;
}

export class InputManager {
  private canvas: HTMLElement;
  private engine: DualLayerEngine;
  private transformHandler?: TransformHandler;
  private gameView?: GameView;
  private eventBus?: EventBus;
  private audioEngine?: WebAudioEngine;
  private onAttackOrder?: (sourceTile: number, targetTile: number) => void;

  // Touch tracking state
  private activeTouchIds: number[] = [];
  private lastTouchX = 0;
  private lastTouchY = 0;
  private startTouchX = 0;
  private startTouchY = 0;
  private touchStartTime = 0;
  private lastPinchDistance = 0;
  private isPinching = false;
  private isPanning = false;

  // Tap-to-target state
  private selectedTile: number | null = null;
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  public static readonly DOUBLE_TAP_MAX_DELAY_MS = 300;
  public static readonly TAP_MAX_DISTANCE_PX = 15;
  public static readonly TAP_MAX_DURATION_MS = 250;

  // Event listener references for clean teardown
  private touchStartBound: (e: TouchEvent) => void;
  private touchMoveBound: (e: TouchEvent) => void;
  private touchEndBound: (e: TouchEvent) => void;
  private touchCancelBound: (e: TouchEvent) => void;
  private resizeBound: () => void;
  private orientationBound: () => void;
  private visualViewportResizeBound?: () => void;

  constructor(options: InputManagerOptions) {
    this.canvas = options.canvas;
    this.engine = options.engine;
    this.transformHandler = options.transformHandler;
    this.gameView = options.gameView;
    this.eventBus = options.eventBus;
    this.audioEngine = options.audioEngine;
    this.onAttackOrder = options.onAttackOrder;

    this.touchStartBound = (e) => this.handleTouchStart(e);
    this.touchMoveBound = (e) => this.handleTouchMove(e);
    this.touchEndBound = (e) => this.handleTouchEnd(e);
    this.touchCancelBound = (e) => this.handleTouchEnd(e);
    this.resizeBound = () => this.handleResize();
    this.orientationBound = () => this.handleResize();

    this.attachEventListeners();
  }

  public getSelectedTile(): number | null {
    return this.selectedTile;
  }

  public clearSelection(): void {
    this.selectedTile = null;
  }

  /**
   * Attaches touch and viewport listeners with non-passive options to intercept
   * and prevent browser default touch gestures.
   */
  private attachEventListeners(): void {
    if (typeof window === "undefined" || !this.canvas) return;

    // Canvas touch listeners (non-passive to allow preventDefault)
    this.canvas.addEventListener("touchstart", this.touchStartBound, { passive: false });
    this.canvas.addEventListener("touchmove", this.touchMoveBound, { passive: false });
    this.canvas.addEventListener("touchend", this.touchEndBound, { passive: false });
    this.canvas.addEventListener("touchcancel", this.touchCancelBound, { passive: false });

    // Viewport and orientation listeners
    window.addEventListener("resize", this.resizeBound);
    window.addEventListener("orientationchange", this.orientationBound);

    if (window.visualViewport) {
      this.visualViewportResizeBound = () => this.handleResize();
      window.visualViewport.addEventListener("resize", this.visualViewportResizeBound);
    }
  }

  /**
   * Handles touchstart: tracks starting points and intercepts browser defaults.
   */
  public handleTouchStart(e: TouchEvent): void {
    // Intercept touchstart to prevent browser pull-to-refresh & zoom
    if (e.cancelable) {
      e.preventDefault();
    }

    const touches = e.touches;
    this.activeTouchIds = Array.from(touches).map((t) => t.identifier);

    if (touches.length === 1) {
      const t = touches[0];
      this.startTouchX = t.clientX;
      this.startTouchY = t.clientY;
      this.lastTouchX = t.clientX;
      this.lastTouchY = t.clientY;
      this.touchStartTime = performance.now();
      this.isPanning = true;
      this.isPinching = false;
    } else if (touches.length === 2) {
      const t1 = touches[0];
      const t2 = touches[1];
      this.lastPinchDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      this.lastTouchX = (t1.clientX + t2.clientX) / 2;
      this.lastTouchY = (t1.clientY + t2.clientY) / 2;
      this.isPinching = true;
      this.isPanning = false;
    }
  }

  /**
   * Handles touchmove: implements 1-finger pan and 2-finger pinch-to-zoom.
   */
  public handleTouchMove(e: TouchEvent): void {
    if (e.cancelable) {
      e.preventDefault();
    }

    const touches = e.touches;

    if (touches.length === 1 && this.isPanning && this.transformHandler) {
      // 1-finger pan: Drag map view
      const t = touches[0];
      const deltaX = t.clientX - this.lastTouchX;
      const deltaY = t.clientY - this.lastTouchY;

      this.lastTouchX = t.clientX;
      this.lastTouchY = t.clientY;

      // Map drag translation to transformHandler
      const scale = this.transformHandler.scale || 1.0;
      this.transformHandler.offsetX -= deltaX / scale;
      this.transformHandler.offsetY -= deltaY / scale;
      this.transformHandler.updateCanvasBoundingRect();
    } else if (touches.length === 2 && this.transformHandler) {
      // 2-finger pinch: Smooth zoom camera
      const t1 = touches[0];
      const t2 = touches[1];
      const currentDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;

      if (this.lastPinchDistance > 0 && currentDistance > 0) {
        const pinchDelta = currentDistance - this.lastPinchDistance;
        // Apply smooth zoom scaling
        const zoomSpeed = 0.005;
        const newScale = Math.max(0.4, Math.min(5.0, this.transformHandler.scale * (1 + pinchDelta * zoomSpeed)));
        this.transformHandler.scale = newScale;
        this.transformHandler.updateCanvasBoundingRect();
      }

      this.lastPinchDistance = currentDistance;
      this.lastTouchX = midX;
      this.lastTouchY = midY;
      this.isPinching = true;
    }
  }

  /**
   * Handles touchend: detects taps, double taps on capital, and tap-to-target attacks.
   */
  public handleTouchEnd(e: TouchEvent): void {
    if (e.cancelable) {
      e.preventDefault();
    }

    const now = performance.now();
    const duration = now - this.touchStartTime;
    const moveDist = Math.hypot(this.lastTouchX - this.startTouchX, this.lastTouchY - this.startTouchY);

    // If movement was small and short, process as a tap
    if (duration <= InputManager.TAP_MAX_DURATION_MS && moveDist <= InputManager.TAP_MAX_DISTANCE_PX) {
      this.processTap(this.startTouchX, this.startTouchY, now);
    }

    if (e.touches.length === 0) {
      this.isPanning = false;
      this.isPinching = false;
      this.lastPinchDistance = 0;
    } else if (e.touches.length === 1) {
      this.isPinching = false;
      this.isPanning = true;
      const t = e.touches[0];
      this.lastTouchX = t.clientX;
      this.lastTouchY = t.clientY;
    }
  }

  /**
   * Processes a single or double tap on coordinates.
   */
  private processTap(screenX: number, screenY: number, timestamp: number): void {
    // If a territory is already selected, process consecutive target tap first
    if (this.selectedTile !== null) {
      const handled = this.processTapToTarget(screenX, screenY);
      if (handled) {
        this.lastTapTime = timestamp;
        this.lastTapX = screenX;
        this.lastTapY = screenY;
        return;
      }
    }

    // 1. Check Double Tap Capital
    const tapInterval = timestamp - this.lastTapTime;
    const tapDistance = Math.hypot(screenX - this.lastTapX, screenY - this.lastTapY);

    if (tapInterval <= InputManager.DOUBLE_TAP_MAX_DELAY_MS && tapDistance <= InputManager.TAP_MAX_DISTANCE_PX * 2) {
      this.triggerDoubleTapCapital();
      this.lastTapTime = 0;
      return;
    }

    this.lastTapTime = timestamp;
    this.lastTapX = screenX;
    this.lastTapY = screenY;

    // 2. Check Tap-to-Target (selection)
    this.processTapToTarget(screenX, screenY);
  }

  /**
   * Centers the camera view instantly over player's home capital on double tap.
   */
  public triggerDoubleTapCapital(): boolean {
    if (!this.gameView || !this.transformHandler) return false;

    const myPlayer = this.gameView.myPlayer();
    if (!myPlayer) return false;

    const capTile = myPlayer.state?.spawnTile;
    if (capTile === undefined || capTile === null) return false;

    const capX = this.gameView.x(capTile);
    const capY = this.gameView.y(capTile);

    // Center camera instantly over player capital
    this.transformHandler.offsetX = capX;
    this.transformHandler.offsetY = capY;
    this.transformHandler.updateCanvasBoundingRect();

    // Pulse beacon ring at capital node
    this.engine.spawnBeaconRing(capX, capY, "#38bdf8", 4, 32, 800, 2);
    if (this.audioEngine) {
      this.audioEngine.playDropClaim();
    }

    return true;
  }

  /**
   * Tap to Target logic:
   * First tap on owned territory selects it.
   * Consecutive tap on an enemy/neutral node launches an attack wave.
   */
  private processTapToTarget(screenX: number, screenY: number): boolean {
    if (!this.gameView || !this.transformHandler) return false;

    const cell = this.transformHandler.screenToWorldCoordinates(screenX, screenY);
    if (!cell || !this.gameView.isValidCoord(cell.x, cell.y)) return false;

    // Check direct tap to claim active supply drop
    if (this.engine.supplyDropManager?.tryClaimAt) {
      const claimResult = this.engine.supplyDropManager.tryClaimAt(
        cell.x,
        cell.y,
        this.gameView.myPlayer(),
        (t) => this.gameView!.ownerID(t),
      );
      if (claimResult?.handled) {
        if (claimResult.success && claimResult.dropId !== undefined) {
          this.eventBus?.emit(
            new SendClaimSupplyDropIntentEvent(
              claimResult.dropId,
              claimResult.tile,
            ),
          );
        } else if (!claimResult.success && claimResult.message) {
          this.engine.pools.spawnFloatingText(
            claimResult.message,
            cell.x,
            cell.y,
            "combat",
            "#f87171",
            1600,
            20,
            12,
          );
        }
        return true;
      }
    }

    const tile = this.gameView.ref(cell.x, cell.y);
    if (this.gameView.isWater(tile)) return false;

    const myPlayer = this.gameView.myPlayer();
    if (!myPlayer) return false;

    const mySmallId = myPlayer.smallID();
    const ownerId = this.gameView.ownerID(tile);

    if (ownerId === mySmallId) {
      // Tap on owned territory: select this node
      this.selectedTile = tile;
      const wx = this.gameView.x(tile);
      const wy = this.gameView.y(tile);
      this.engine.spawnBeaconRing(wx, wy, "#10b981", 4, 24, 600, 2);
      return true;
    } else if (this.selectedTile !== null) {
      // Consecutive tap on enemy or neutral territory: launch attack wave!
      const targetTile = tile;
      const sourceTile = this.selectedTile;

      this.executeAttack(sourceTile, targetTile);
      this.selectedTile = null;
      return true;
    }

    return false;
  }

  /**
   * Executes an attack order from selected tile to target tile.
   */
  private executeAttack(sourceTile: number, targetTile: number): void {
    if (this.onAttackOrder) {
      this.onAttackOrder(sourceTile, targetTile);
    }

    if (this.eventBus) {
      this.eventBus.emit(new SendAttackIntentEvent(null, 0, targetTile));
    }

    if (this.audioEngine) {
      this.audioEngine.playTroopLaunch();
    }

    if (this.gameView) {
      const tx = this.gameView.x(targetTile);
      const ty = this.gameView.y(targetTile);
      this.engine.spawnBeaconRing(tx, ty, "#ef4444", 4, 28, 700, 2);
    }
  }

  /**
   * Responsive Viewport Resizing: Syncs dual-layer canvases dynamically
   * to mobile browser dimensions and orientation changes.
   */
  public handleResize(): void {
    if (typeof window === "undefined") return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // Resize dual layer canvases and update DPI scaling
    this.engine.resize(width, height);

    if (this.transformHandler) {
      this.transformHandler.updateCanvasBoundingRect();
    }

    // Force redraw of static landmass layer
    this.engine.markStaticDirty();
  }

  /**
   * Clean lifecycle disposal: removes all DOM and window event listeners.
   */
  public dispose(): void {
    if (typeof window === "undefined") return;

    this.canvas.removeEventListener("touchstart", this.touchStartBound);
    this.canvas.removeEventListener("touchmove", this.touchMoveBound);
    this.canvas.removeEventListener("touchend", this.touchEndBound);
    this.canvas.removeEventListener("touchcancel", this.touchCancelBound);

    window.removeEventListener("resize", this.resizeBound);
    window.removeEventListener("orientationchange", this.orientationBound);

    if (this.visualViewportResizeBound && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.visualViewportResizeBound);
    }

    this.selectedTile = null;
  }
}
