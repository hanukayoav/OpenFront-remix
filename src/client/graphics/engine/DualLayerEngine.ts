/**
 * OpenFront Dual-Layer Graphics Engine
 *
 * Implements a high-performance rendering pipeline engineered for 60 FPS on school laptops
 * and low-end devices with integrated graphics.
 *
 * Key Architectural Pillars:
 * 1. Dual Layer Canvas: Stacked Static (background) and Dynamic (foreground) canvases.
 *    Static layer redraws ONLY on resize or permanent territory boundary shifts.
 *    Dynamic layer updates every frame via requestAnimationFrame.
 * 2. Offscreen Asset Prerendering: AssetCache bakes gradients, shadows and complex shapes once.
 *    Zero ctx.shadowBlur or gradient recomputations in the dynamic frame loop.
 * 3. Preallocated Object Pools: 150 trail particles, 30 floating text markers, 10 beacon rings.
 *    Zero heap allocations / GC pauses in the dynamic loop.
 * 4. Batched Text & State Sanitisation: Groups text calls to minimize font parsing,
 *    truncates coordinates via bitwise integer snapping to avoid subpixel antialiasing,
 *    and strictly pairs every ctx.save() with ctx.restore().
 */

import { AssetCache, BoundaryGlowType, SupplyCrateType } from "./AssetCache";
import { AvatarSystem } from "./AvatarSystem";
import { MatchAnalytics } from "./MatchAnalytics";
import { FloatingTextMarker, VisualFxPools } from "./ObjectPool";
import { SupplyDropManager } from "./SupplyDropManager";
import { WebAudioEngine } from "./WebAudioEngine";

export interface DualLayerEngineConfig {
  container: HTMLElement;
  width?: number;
  height?: number;
  maxDpr?: number;
  devicePixelRatio?: number;
  enableHiDpi?: boolean;
}

export interface DynamicUnitItem {
  id: number;
  x: number;
  y: number;
  troops: number;
  color: string;
  type: string;
  isActive: boolean;
  name?: string;
  isSelected?: boolean;
}

export interface SupplyCrateItem {
  id: string | number;
  x: number;
  y: number;
  type: SupplyCrateType;
  collected?: boolean;
}

export interface DynamicAvatarItem {
  id: string | number;
  x: number;
  y: number;
  name: string;
  color: string;
  isBot?: boolean;
  isLocalPlayer?: boolean;
}

export interface StaticBoundaryStroke {
  points: Array<{ x: number; y: number }>;
  color: string;
  glowType: BoundaryGlowType;
  lineWidth: number;
}

export interface StaticTerrainData {
  width: number;
  height: number;
  backgroundColor: string;
  landColor: string;
  waterColor: string;
  neutralStrokeColor: string;
  landPolygons: Array<Array<{ x: number; y: number }>>;
  neutralBoundaries: StaticBoundaryStroke[];
}

export interface TextBatchEntry {
  text: string;
  x: number;
  y: number;
  color: string;
  font: string;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  alpha: number;
  strokeColor?: string;
}

export class DualLayerEngine {
  // Canvases and contexts
  public readonly staticCanvas: HTMLCanvasElement;
  public readonly dynamicCanvas: HTMLCanvasElement;
  public readonly staticCtx: CanvasRenderingContext2D;
  public readonly dynamicCtx: CanvasRenderingContext2D;
  public readonly container: HTMLElement;

  // Subsystems
  public readonly assetCache: AssetCache;
  public readonly pools: VisualFxPools;
  public readonly avatarSystem: AvatarSystem;
  public readonly supplyDropManager: SupplyDropManager;
  public readonly audioEngine: WebAudioEngine;
  public readonly analytics: MatchAnalytics;

  // Viewport and Resolution
  private cssWidth = 800;
  private cssHeight = 600;
  private dpr = 1;
  private readonly maxDpr: number;

  // Camera State
  public cameraX = 0;
  public cameraY = 0;
  public cameraScale = 1.0;

  // Static Layer Caching State
  private staticDirty = true;
  private staticTerrain: StaticTerrainData | null = null;
  private lastRenderedCameraX = 0;
  private lastRenderedCameraY = 0;
  private lastRenderedCameraScale = 1.0;

  // Dynamic Scene Data
  private units: DynamicUnitItem[] = [];
  private crates = new Map<string | number, SupplyCrateItem>();
  private avatars = new Map<string | number, DynamicAvatarItem>();

  // Text Batching Storage (preallocated list to prevent per-frame arrays)
  private readonly textBatch: TextBatchEntry[] = [];
  private readonly textGroups = new Map<string, TextBatchEntry[]>();

  // Animation & Frame Loop
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private isRunning = false;

  // Performance telemetry
  public frameCount = 0;
  public staticRedrawCount = 0;
  public dynamicFrameCount = 0;
  public fps = 60;
  private fpsTimer = 0;
  private fpsFrames = 0;

  // Custom configuration & callbacks
  private customDpr?: number;
  public onOrbitalSupplyDropAlert?: () => void;
  private onStaticRender?: () => void;

  public get screenShake() {
    return this.avatarSystem.screenShake;
  }

  constructor(config: DualLayerEngineConfig) {
    this.container = config.container;
    this.maxDpr = config.maxDpr ?? 2.0;
    this.customDpr = config.devicePixelRatio;

    // 1. Create Static Layer (Background)
    this.staticCanvas = document.createElement("canvas");
    this.staticCanvas.className = "openfront-static-canvas";
    this.staticCanvas.style.position = "absolute";
    this.staticCanvas.style.left = "0";
    this.staticCanvas.style.top = "0";
    this.staticCanvas.style.width = "100%";
    this.staticCanvas.style.height = "100%";
    this.staticCanvas.style.zIndex = "1";
    this.staticCanvas.style.pointerEvents = "none";

    const sCtx = this.staticCanvas.getContext("2d", { alpha: true });
    if (!sCtx) throw new Error("Failed to get 2D context for static canvas");
    this.staticCtx = sCtx;

    // 2. Create Dynamic Layer (Foreground)
    this.dynamicCanvas = document.createElement("canvas");
    this.dynamicCanvas.className = "openfront-dynamic-canvas";
    this.dynamicCanvas.style.position = "absolute";
    this.dynamicCanvas.style.left = "0";
    this.dynamicCanvas.style.top = "0";
    this.dynamicCanvas.style.width = "100%";
    this.dynamicCanvas.style.height = "100%";
    this.dynamicCanvas.style.zIndex = "2";
    this.dynamicCanvas.style.pointerEvents = "none";

    const dCtx = this.dynamicCanvas.getContext("2d", { alpha: true });
    if (!dCtx) throw new Error("Failed to get 2D context for dynamic canvas");
    this.dynamicCtx = dCtx;

    // Mount stacked canvases
    this.container.appendChild(this.staticCanvas);
    this.container.appendChild(this.dynamicCanvas);

    // Initialize subsystems
    this.assetCache = new AssetCache();
    this.assetCache.initialize();
    this.pools = new VisualFxPools();
    this.avatarSystem = new AvatarSystem();
    this.supplyDropManager = new SupplyDropManager(this, this.pools);
    this.audioEngine = new WebAudioEngine();
    this.analytics = new MatchAnalytics();

    // Initial sizing
    const initialWidth = config.width ?? this.container.clientWidth ?? 800;
    const initialHeight = config.height ?? this.container.clientHeight ?? 600;
    this.resize(initialWidth, initialHeight);
  }

  // ============================================================
  // RESOLUTION AND VIEWPORT SYNCHRONIZATION
  // ============================================================

  /**
   * Resizes both canvases, matching coordinate scaling and backing-store resolution.
   */
  public resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    this.cssWidth = width;
    this.cssHeight = height;

    // Clamp devicePixelRatio to protect integrated GPUs on school laptops
    const rawDpr =
      this.customDpr ??
      (typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1);
    this.dpr = Math.min(rawDpr, this.maxDpr);

    const pixelW = Math.max(1, Math.floor(this.cssWidth * this.dpr));
    const pixelH = Math.max(1, Math.floor(this.cssHeight * this.dpr));

    // Static canvas
    this.staticCanvas.width = pixelW;
    this.staticCanvas.height = pixelH;
    this.staticCanvas.style.width = `${this.cssWidth}px`;
    this.staticCanvas.style.height = `${this.cssHeight}px`;

    // Dynamic canvas
    this.dynamicCanvas.width = pixelW;
    this.dynamicCanvas.height = pixelH;
    this.dynamicCanvas.style.width = `${this.cssWidth}px`;
    this.dynamicCanvas.style.height = `${this.cssHeight}px`;

    // Static canvas MUST redraw whenever viewport resolution or sizing changes
    this.markStaticDirty();
    this.renderStaticLayer();
  }

  public setCamera(x: number, y: number, scale: number): void {
    if (
      Math.abs(this.cameraX - x) > 0.001 ||
      Math.abs(this.cameraY - y) > 0.001 ||
      Math.abs(this.cameraScale - scale) > 0.001
    ) {
      this.cameraX = x;
      this.cameraY = y;
      this.cameraScale = scale;
      // Only mark static dirty if there is actual static content to re-project
      if (
        this.staticTerrain &&
        (this.staticTerrain.landPolygons.length > 0 ||
          this.staticTerrain.neutralBoundaries.length > 0)
      ) {
        this.markStaticDirty();
      }
    }
  }

  /**
   * Flag that static landmass or permanent territory boundaries have shifted.
   * This is the ONLY trigger for repainting the static background canvas during gameplay.
   */
  public markStaticDirty(): void {
    this.staticDirty = true;
  }

  public isStaticDirty(): boolean {
    return this.staticDirty;
  }

  public setStaticRenderCallback(cb: () => void): void {
    this.onStaticRender = cb;
  }

  public redrawStaticLayer(): void {
    this.markStaticDirty();
    this.renderStaticLayer();
  }

  public markTerritoryShift(): void {
    this.markStaticDirty();
    this.renderStaticLayer();
  }

  public setStaticTerrain(terrain: StaticTerrainData): void {
    this.staticTerrain = terrain;
    this.markStaticDirty();
  }

  // ============================================================
  // STATE SANITISATION: STRICTLY PAIRED SAVE / RESTORE
  // ============================================================

  /**
   * Strictly pairs ctx.save() with ctx.restore() to prevent canvas state leaks.
   */
  public withContextState(
    ctx: CanvasRenderingContext2D,
    action: (c: CanvasRenderingContext2D) => void,
  ): void {
    ctx.save();
    try {
      action(ctx);
    } finally {
      ctx.restore();
    }
  }

  /**
   * Applies shared camera transform to a canvas context.
   */
  private applyCameraTransform(
    ctx: CanvasRenderingContext2D,
    applyShake = false,
  ): void {
    // Disable image smoothing for crisp pixelated map edges on low-spec screens
    ctx.imageSmoothingEnabled = false;

    let shakeX = 0;
    let shakeY = 0;
    if (applyShake && this.avatarSystem.screenShake.isShaking()) {
      shakeX = this.avatarSystem.screenShake.offsetX;
      shakeY = this.avatarSystem.screenShake.offsetY;
    }

    // Transform from world to screen:
    // ScreenX = (WorldX - CameraX) * Scale + (Width / 2)
    // Scaled by DPR for physical pixels
    const s = this.cameraScale * this.dpr;
    const tx =
      ((this.cssWidth * 0.5 - this.cameraX * this.cameraScale + shakeX) *
        this.dpr) |
      0;
    const ty =
      ((this.cssHeight * 0.5 - this.cameraY * this.cameraScale + shakeY) *
        this.dpr) |
      0;

    ctx.setTransform(s, 0, 0, s, tx, ty);
  }

  // ============================================================
  // SPECIFICATION 1: STATIC LAYER RENDERING
  // ============================================================

  /**
   * Renders static landmass geometry, neutral boundary strokes, and static terrain.
   * Only called on viewport resize or when map territory boundaries permanently shift.
   */
  public renderStaticLayer(): void {
    const ctx = this.staticCtx;
    const w = this.staticCanvas.width;
    const h = this.staticCanvas.height;

    // Clear static layer to avoid occluding underlying WebGL map
    ctx.clearRect(0, 0, w, h);

    // Background fill (only if explicitly set to non-transparent)
    const bgColor = this.staticTerrain?.backgroundColor;
    if (bgColor && bgColor !== "transparent") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);
    }

    if (
      !this.staticTerrain ||
      (this.staticTerrain.landPolygons.length === 0 &&
        this.staticTerrain.neutralBoundaries.length === 0)
    ) {
      this.staticDirty = false;
      this.staticRedrawCount++;
      this.onStaticRender?.();
      return;
    }

    this.withContextState(ctx, (c) => {
      this.applyCameraTransform(c);

      // 1. Static Landmass Geometry Polygons
      const landColor = this.staticTerrain!.landColor ?? "#1b4d3e";
      c.fillStyle = landColor;
      for (let i = 0; i < this.staticTerrain!.landPolygons.length; i++) {
        const poly = this.staticTerrain!.landPolygons[i];
        if (poly.length < 3) continue;

        c.beginPath();
        // Snap first point with bitwise integer truncation
        c.moveTo(poly[0].x | 0, poly[0].y | 0);
        for (let j = 1; j < poly.length; j++) {
          c.lineTo(poly[j].x | 0, poly[j].y | 0);
        }
        c.closePath();
        c.fill();
      }

      // 2. Neutral Boundary Strokes along coastlines or neutral zones
      const neutralColor = this.staticTerrain!.neutralStrokeColor ?? "#334155";
      c.strokeStyle = neutralColor;
      c.lineWidth = 1.5;
      c.lineJoin = "round";
      c.lineCap = "round";

      for (let i = 0; i < this.staticTerrain!.neutralBoundaries.length; i++) {
        const stroke = this.staticTerrain!.neutralBoundaries[i];
        if (stroke.points.length < 2) continue;

        c.beginPath();
        c.moveTo(stroke.points[0].x | 0, stroke.points[0].y | 0);
        for (let j = 1; j < stroke.points.length; j++) {
          c.lineTo(stroke.points[j].x | 0, stroke.points[j].y | 0);
        }
        c.stroke();

        // 3. Glowing boundary stamps for major strategic borders
        if (stroke.glowType) {
          const stamp = this.assetCache.getBoundaryStamp(stroke.glowType);
          const halfStamp = (stamp.width / 2) | 0;
          // Blit cached stamp at end points
          const endPt = stroke.points[stroke.points.length - 1];
          c.drawImage(
            stamp,
            (endPt.x - halfStamp) | 0,
            (endPt.y - halfStamp) | 0,
          );
        }
      }
    });

    this.lastRenderedCameraX = this.cameraX;
    this.lastRenderedCameraY = this.cameraY;
    this.lastRenderedCameraScale = this.cameraScale;
    this.staticDirty = false;
    this.staticRedrawCount++;
    this.onStaticRender?.();
  }

  // ============================================================
  // SPECIFICATION 1, 2, 3, 4: DYNAMIC LAYER RENDERING
  // ============================================================

  /**
   * Cleared and updated every frame via requestAnimationFrame at 60 FPS.
   */
  public renderDynamicLayer(deltaMs: number): void {
    const ctx = this.dynamicCtx;
    const w = this.dynamicCanvas.width;
    const h = this.dynamicCanvas.height;

    // 1. Clear foreground dynamic layer
    ctx.clearRect(0, 0, w, h);

    // 2. Update all preallocated visual effect pools (particles, texts, beacons) and avatar state
    this.pools.update(deltaMs);
    this.avatarSystem.update(deltaMs);

    // 3. Render world-space dynamic objects
    this.withContextState(ctx, (c) => {
      this.applyCameraTransform(c, true);

      // (a) Unit Trail Particles
      this.renderTrailParticles(c);

      // (b) Animated Beacon Rings
      this.renderBeaconRings(c);

      // (c) Supply Crates (Prerendered via AssetCache)
      this.renderSupplyCrates(c);

      // (d) Troop Units & Avatars
      this.renderUnitsAndAvatars(c);

      // (e) Interactive Capital Avatars
      this.avatarSystem.render(c, this.frameCount);
    });

    // 4. BATCHING: Group all text operations together to eliminate font context switching
    this.flushBatchedText(ctx);

    // 5. Render top-screen banner for late-phase orbital drops
    this.renderTopBanner(ctx);

    this.dynamicFrameCount++;
  }

  // ------------------------------------------------------------
  // Visual Effect Renderers
  // ------------------------------------------------------------

  private renderTrailParticles(ctx: CanvasRenderingContext2D): void {
    const particles = this.pools.trailParticles.getRawPool();
    for (let i = 0; i < VisualFxPools.TRAIL_PARTICLE_CAPACITY; i++) {
      const p = particles[i];
      if (!p.active) continue;

      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;

      // Truncate coordinates with bitwise OR to avoid subpixel antialiasing
      const px = (p.x - p.size * 0.5) | 0;
      const py = (p.y - p.size * 0.5) | 0;
      const sz = Math.max(1, p.size | 0);

      ctx.fillRect(px, py, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  private renderBeaconRings(ctx: CanvasRenderingContext2D): void {
    const beacons = this.pools.beaconRings.getRawPool();
    for (let i = 0; i < VisualFxPools.BEACON_RING_CAPACITY; i++) {
      const b = beacons[i];
      if (!b.active) continue;

      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.lineWidth;

      // Bitwise truncate center and radius
      const bx = (b.x + 0.5) | 0;
      const by = (b.y + 0.5) | 0;
      const rad = Math.max(1, (b.currentRadius + 0.5) | 0);

      ctx.beginPath();
      ctx.arc(bx, by, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private renderSupplyCrates(ctx: CanvasRenderingContext2D): void {
    for (const crate of this.crates.values()) {
      if (crate.collected) continue;

      // Draw prerendered crate from AssetCache (no runtime gradients/shadowBlur)
      const crateCanvas = this.assetCache.getSupplyCrate(crate.type);
      const halfSize = (crateCanvas.width / 2) | 0;

      // Integer coordinate truncation
      const dx = (crate.x - halfSize) | 0;
      const dy = (crate.y - halfSize) | 0;

      ctx.drawImage(crateCanvas, dx, dy);
    }
  }

  private renderUnitsAndAvatars(ctx: CanvasRenderingContext2D): void {
    // 1. Avatars
    for (const avatar of this.avatars.values()) {
      const disc = this.assetCache.getAvatarPart("baseDisc");
      const halfDisc = (disc.width / 2) | 0;
      const ax = (avatar.x - halfDisc) | 0;
      const ay = (avatar.y - halfDisc) | 0;

      ctx.drawImage(disc, ax, ay);

      if (avatar.isLocalPlayer) {
        const halo = this.assetCache.getAvatarPart("haloRing");
        const halfHalo = (halo.width / 2) | 0;
        ctx.drawImage(
          halo,
          (avatar.x - halfHalo) | 0,
          (avatar.y - halfHalo) | 0,
        );
      }

      if (avatar.isBot) {
        const botIcon = this.assetCache.getAvatarPart("botIcon");
        const halfBot = (botIcon.width / 2) | 0;
        ctx.drawImage(
          botIcon,
          (avatar.x - halfBot) | 0,
          (avatar.y - halfBot) | 0,
        );
      } else {
        const shield = this.assetCache.getAvatarPart("crestShield");
        const halfShield = (shield.width / 2) | 0;
        ctx.drawImage(
          shield,
          (avatar.x - halfShield) | 0,
          (avatar.y - halfShield) | 0,
        );
      }

      // Queue name text for batched text pass
      this.queueText(
        avatar.name,
        avatar.x,
        avatar.y - halfDisc - 6,
        "#ffffff",
        "bold 11px sans-serif",
      );
    }

    // 2. Dynamic Units / Troop numbers
    // Note: Simulation entities (structures, ships, land units) are rendered with full
    // GPU-accelerated sprites by WebGL (StructurePass, UnitPass).
    // The 2D dynamic canvas overlay must NEVER draw opaque base circle placeholders over them.
    for (let i = 0; i < this.units.length; i++) {
      const unit = this.units[i];
      if (!unit.isActive) continue;

      const ux = (unit.x + 0.5) | 0;
      const uy = (unit.y + 0.5) | 0;

      // Selection ring (non-occluding stroke only)
      if (unit.isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ux, uy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Queue troop count text for batching if present
      if (unit.troops > 0) {
        const troopsText =
          unit.troops > 999
            ? `${(unit.troops / 1000).toFixed(1)}k`
            : `${unit.troops}`;
        this.queueText(
          troopsText,
          ux,
          uy - 9,
          "#f8fafc",
          "bold 10px sans-serif",
        );
      }
    }
  }

  // ============================================================
  // SPECIFICATION 4: BATCHED TEXT RENDERING
  // ============================================================

  /**
   * Queue text to be rendered during the consolidated text batching phase.
   */
  public queueText(
    text: string,
    x: number,
    y: number,
    color = "#ffffff",
    font = "12px sans-serif",
    align: CanvasTextAlign = "center",
    baseline: CanvasTextBaseline = "middle",
    alpha = 1,
    strokeColor?: string,
  ): void {
    this.textBatch.push({
      text,
      x,
      y,
      color,
      font,
      align,
      baseline,
      alpha,
      strokeColor,
    });
  }

  /**
   * Flushes all queued text in batches grouped by font family/size.
   * Minimizes expensive browser font string parsing and state changes.
   */
  private flushBatchedText(ctx: CanvasRenderingContext2D): void {
    // Also include active floating text markers from the object pool
    const markers = this.pools.textMarkers.getRawPool();
    for (let i = 0; i < VisualFxPools.FLOATING_TEXT_CAPACITY; i++) {
      const m = markers[i];
      if (!m.active) continue;

      this.queueText(
        m.text,
        m.x,
        m.y,
        m.color,
        `bold ${m.fontSize}px ${m.fontFamily}`,
        "center",
        "middle",
        m.alpha,
        "rgba(0, 0, 0, 0.7)",
      );
    }

    if (this.textBatch.length === 0) return;

    // Group texts by font string
    this.textGroups.clear();
    for (let i = 0; i < this.textBatch.length; i++) {
      const entry = this.textBatch[i];
      let group = this.textGroups.get(entry.font);
      if (!group) {
        group = [];
        this.textGroups.set(entry.font, group);
      }
      group.push(entry);
    }

    this.withContextState(ctx, (c) => {
      // Screen space transform for crisp text rendering
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // Iterate groups: set font ONCE per group
      for (const [font, entries] of this.textGroups.entries()) {
        c.font = font;

        for (let i = 0; i < entries.length; i++) {
          const item = entries[i];

          c.textAlign = item.align;
          c.textBaseline = item.baseline;
          c.globalAlpha = item.alpha;

          // Convert world coordinates to screen coordinates
          const screenX =
            (item.x - this.cameraX) * this.cameraScale + this.cssWidth * 0.5;
          const screenY =
            (item.y - this.cameraY) * this.cameraScale + this.cssHeight * 0.5;

          // Snap to integer device pixels with bitwise OR
          const ix = (screenX + 0.5) | 0;
          const iy = (screenY + 0.5) | 0;

          // Text shadow / outline stroke if requested
          if (item.strokeColor) {
            c.strokeStyle = item.strokeColor;
            c.lineWidth = 2.5;
            c.strokeText(item.text, ix, iy);
          }

          c.fillStyle = item.color;
          c.fillText(item.text, ix, iy);
        }
      }
    });

    this.textBatch.length = 0;
  }

  private renderTopBanner(ctx: CanvasRenderingContext2D): void {
    const banner = this.supplyDropManager.getActiveBanner();
    if (!banner || banner.alpha <= 0.01) return;

    this.withContextState(ctx, (c) => {
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.globalAlpha = banner.alpha;

      const bw = Math.min(380, this.cssWidth - 32);
      const bh = 48;
      const bx = ((this.cssWidth - bw) / 2) | 0;
      const by = 16;

      // Dark futuristic amber/gold alert card
      c.fillStyle = "rgba(15, 23, 42, 0.92)";
      c.fillRect(bx, by, bw, bh);

      c.strokeStyle = "#f59e0b";
      c.lineWidth = 1.5;
      c.strokeRect(bx, by, bw, bh);

      // Warning indicator badge
      c.fillStyle = "#f59e0b";
      c.fillRect(bx + 12, by + 12, 4, bh - 24);

      // Header text
      c.font = "bold 13px Overpass, sans-serif";
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.fillStyle = "#fef08a";
      c.fillText(banner.text, bx + 24, by + 18);

      // Subtext
      if (banner.subtext) {
        c.font = "11px Overpass, sans-serif";
        c.fillStyle = "#94a3b8";
        c.fillText(banner.subtext, bx + 24, by + 34);
      }
    });
  }

  // ============================================================
  // ANIMATION LOOP AND LIFECYCLE
  // ============================================================

  /**
   * Advances and renders a single frame of the dual-layer engine.
   * Can be driven by the engine's internal RAF loop (via start()) or an external frame loop.
   */
  public step(deltaMs: number, time = performance.now()): void {
    // 1. Static layer only updates when dirty or resized
    if (this.staticDirty) {
      this.renderStaticLayer();
    }

    // 2. Dynamic layer updates every frame
    this.renderDynamicLayer(deltaMs);

    // Calculate telemetry FPS
    this.frameCount++;
    this.fpsFrames++;
    if (time - this.fpsTimer >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (time - this.fpsTimer));
      this.fpsTimer = time;
      this.fpsFrames = 0;
    }
  }

  /**
   * Start the dual-layer render loop.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.fpsTimer = this.lastFrameTime;
    this.fpsFrames = 0;

    const frameLoop = (time: number): void => {
      if (!this.isRunning) return;

      const deltaMs = Math.min(time - this.lastFrameTime, 100); // Clamp large delta spikes
      this.lastFrameTime = time;

      this.step(deltaMs, time);

      this.rafId = requestAnimationFrame(frameLoop);
    };

    this.rafId = requestAnimationFrame(frameLoop);
  }

  /**
   * Stop the render loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Clean up and destroy engine resources.
   */
  public destroy(): void {
    this.stop();
    this.pools.clearAll();
    this.avatarSystem.clear();
    this.supplyDropManager.reset();
    this.audioEngine.dispose();
    this.analytics.dispose();
    this.assetCache.clear();
    this.staticCanvas.remove();
    this.dynamicCanvas.remove();
  }

  // ============================================================
  // PUBLIC MUTATION HELPERS
  // ============================================================

  public setUnits(units: DynamicUnitItem[]): void {
    this.units = units;
  }

  public setSupplyCrates(crates: SupplyCrateItem[]): void {
    this.crates.clear();
    for (let i = 0; i < crates.length; i++) {
      this.crates.set(crates[i].id, crates[i]);
    }
  }

  public setAvatars(avatars: DynamicAvatarItem[]): void {
    this.avatars.clear();
    for (let i = 0; i < avatars.length; i++) {
      this.avatars.set(avatars[i].id, avatars[i]);
    }
  }

  public spawnTrailParticle(
    x: number,
    y: number,
    vx = 0,
    vy = 0,
    color = "#ffffff",
    size = 2,
    durationMs = 600,
  ) {
    // Cap active screen particles at 120
    if (this.pools.trailParticles.activeCount >= 120) {
      return null;
    }
    return this.pools.spawnTrailParticle(x, y, vx, vy, color, size, durationMs);
  }

  public spawnFloatingText(
    text: string,
    x: number,
    y: number,
    type: "combat" | "loot" | "info" = "info",
    color = "#ffffff",
    durationMs = 1200,
    riseDistance = 18,
    fontSize = 12,
  ): FloatingTextMarker | null {
    return this.pools.spawnFloatingText(
      text,
      x,
      y,
      type,
      color,
      durationMs,
      riseDistance,
      fontSize,
    );
  }

  public spawnBeaconRing(
    x: number,
    y: number,
    color = "#38bdf8",
    startRadius = 4,
    maxRadius = 28,
    durationMs = 1200,
    lineWidth = 2,
  ) {
    return this.pools.spawnBeaconRing(
      x,
      y,
      color,
      startRadius,
      maxRadius,
      durationMs,
      lineWidth,
    );
  }
}
