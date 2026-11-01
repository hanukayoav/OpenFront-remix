/**
 * OpenFront Dual-Layer Graphics Engine - Offscreen Asset Prerendering and Caching
 *
 * Prerenders expensive visual features (glow filters, radial gradients, shadow blurs,
 * multi-path vector icons) onto hidden offscreen canvas surfaces during initialisation.
 * Eliminates native shadow blur (ctx.shadowBlur) calls and gradient recomputations
 * inside the 60 FPS dynamic frame loop to maintain solid performance on integrated GPUs.
 */

export type BoundaryGlowType = "neutral" | "friendly" | "enemy" | "self" | "gold";

export type SupplyCrateType = "standard" | "gold" | "troops" | "early" | "mid" | "late";

export type AvatarPartType = "baseDisc" | "haloRing" | "crestShield" | "starBadge" | "botIcon";

export interface BoundaryStampOptions {
  color?: string;
  size?: number;
  glowRadius?: number;
  coreRadius?: number;
}

export class AssetCache {
  private readonly boundaryStamps = new Map<string, HTMLCanvasElement>();
  private readonly supplyCrates = new Map<SupplyCrateType, HTMLCanvasElement>();
  private readonly avatarParts = new Map<string, HTMLCanvasElement>();
  private readonly genericStamps = new Map<string, HTMLCanvasElement>();

  private isInitialised = false;

  constructor() {
    // Canvas cache is empty until initialize() is invoked
  }

  /**
   * Helper to create an offscreen canvas.
   */
  public static createOffscreenCanvas(width: number, height: number): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) {
      throw new Error(`Failed to acquire 2D context for offscreen canvas ${width}x${height}`);
    }
    return { canvas, ctx };
  }

  /**
   * Initialize and bake all required offscreen assets once during startup.
   */
  public initialize(): void {
    if (this.isInitialised) return;

    this.prerenderBoundaryStamps();
    this.prerenderSupplyCrates();
    this.prerenderAvatarParts();

    this.isInitialised = true;
  }

  public isReady(): boolean {
    return this.isInitialised;
  }

  // ============================================================
  // 1. GLOWING BOUNDARY STAMPS (Prerendered once with shadow blur)
  // ============================================================

  private prerenderBoundaryStamps(): void {
    const presets: Record<BoundaryGlowType, { color: string; glow: string; size: number }> = {
      neutral: { color: "#e2e8f0", glow: "rgba(226, 232, 240, 0.75)", size: 48 },
      friendly: { color: "#22c55e", glow: "rgba(34, 197, 94, 0.8)", size: 48 },
      enemy: { color: "#ef4444", glow: "rgba(239, 68, 68, 0.85)", size: 48 },
      self: { color: "#38bdf8", glow: "rgba(56, 189, 248, 0.85)", size: 48 },
      gold: { color: "#facc15", glow: "rgba(250, 204, 21, 0.85)", size: 48 },
    };

    for (const [key, preset] of Object.entries(presets)) {
      const stamp = this.bakeGlowingStamp(preset.color, preset.glow, preset.size);
      this.boundaryStamps.set(key, stamp);
    }
  }

  /**
   * Bakes a glowing boundary stamp onto an offscreen canvas using radial gradients
   * and native shadowBlur ONCE during cache initialization.
   */
  private bakeGlowingStamp(coreColor: string, glowColor: string, size: number): HTMLCanvasElement {
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);
    const center = size / 2;
    const outerRadius = size / 2;
    const innerRadius = size * 0.18;

    ctx.save();
    try {
      // 1. Outer soft diffused glow using radial gradient
      const radGrad = ctx.createRadialGradient(center, center, innerRadius, center, center, outerRadius);
      radGrad.addColorStop(0, glowColor);
      radGrad.addColorStop(0.35, glowColor);
      radGrad.addColorStop(0.7, glowColor.replace(/[\d.]+\)$/, "0.2)"));
      radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.fillStyle = radGrad;
      ctx.beginPath();
      ctx.arc(center, center, outerRadius, 0, Math.PI * 2);
      ctx.fill();

      // 2. High-intensity bloom layer using native shadowBlur (baked once)
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = Math.round(size * 0.28);
      ctx.fillStyle = coreColor;
      ctx.beginPath();
      ctx.arc(center, center, innerRadius, 0, Math.PI * 2);
      ctx.fill();

      // 3. Bright core center
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(center, center, innerRadius * 0.45, 0, Math.PI * 2);
      ctx.fill();
    } finally {
      ctx.restore();
    }

    return canvas;
  }

  /**
   * Retrieve a prerendered boundary stamp canvas.
   */
  public getBoundaryStamp(type: BoundaryGlowType = "neutral"): HTMLCanvasElement {
    const cached = this.boundaryStamps.get(type);
    if (cached) return cached;
    return this.boundaryStamps.get("neutral")!;
  }

  /**
   * Dynamically bake and cache an arbitrary colored stamp on first demand.
   */
  public getCustomStamp(colorHex: string, size = 48): HTMLCanvasElement {
    const key = `${colorHex}_${size}`;
    let cached = this.genericStamps.get(key);
    if (!cached) {
      cached = this.bakeGlowingStamp(colorHex, colorHex, size);
      this.genericStamps.set(key, cached);
    }
    return cached;
  }

  // ============================================================
  // 2. SUPPLY CRATE ICONS (Pre-rendered multi-part vector assets)
  // ============================================================

  private prerenderSupplyCrates(): void {
    this.supplyCrates.set("standard", this.bakeSupplyCrate("standard"));
    this.supplyCrates.set("gold", this.bakeSupplyCrate("gold"));
    this.supplyCrates.set("troops", this.bakeSupplyCrate("troops"));
    this.supplyCrates.set("early", this.bakeSupplyCrate("early"));
    this.supplyCrates.set("mid", this.bakeSupplyCrate("mid"));
    this.supplyCrates.set("late", this.bakeSupplyCrate("late"));
  }

  /**
   * Bakes a crisp supply crate with drop shadow, wooden planks, metallic bands,
   * reinforcement rivets, and type emblems onto an offscreen canvas surface.
   */
  private bakeSupplyCrate(type: SupplyCrateType): HTMLCanvasElement {
    const size = 40;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);

    const pad = 4;
    const boxSize = size - pad * 2;
    const bx = pad;
    const by = pad;

    ctx.save();
    try {
      // 1. Baked drop shadow (no shadowBlur at runtime)
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.ellipse(size / 2, size - 2, boxSize * 0.46, 3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Palette configuration per crate type
      let woodBase = "#854d0e";
      let woodHighlight = "#a16207";
      let metalColor = "#475569";
      let metalHighlight = "#94a3b8";
      let emblemColor = "#fef08a";

      if (type === "gold" || type === "late") {
        // Radiant gold crate (#f59e0b)
        woodBase = "#92400e";
        woodHighlight = "#b45309";
        metalColor = "#d97706";
        metalHighlight = "#f59e0b";
        emblemColor = "#fde047";
      } else if (type === "troops" || type === "early") {
        // Electric blue crate (#3b82f6)
        woodBase = "#1e293b";
        woodHighlight = "#334155";
        metalColor = "#2563eb";
        metalHighlight = "#3b82f6";
        emblemColor = "#60a5fa";
      } else if (type === "mid") {
        // Vibrant purple crate (#a855f7)
        woodBase = "#3b0764";
        woodHighlight = "#581c87";
        metalColor = "#7e22ce";
        metalHighlight = "#a855f7";
        emblemColor = "#e9d5ff";
      }

      // 2. Wooden box body with horizontal planks
      const woodGrad = ctx.createLinearGradient(bx, by, bx, by + boxSize);
      woodGrad.addColorStop(0, woodHighlight);
      woodGrad.addColorStop(1, woodBase);

      ctx.fillStyle = woodGrad;
      ctx.fillRect(bx, by, boxSize, boxSize);

      // Plank separation grooves
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(bx, by + Math.floor(boxSize * 0.33), boxSize, 1.5);
      ctx.fillRect(bx, by + Math.floor(boxSize * 0.66), boxSize, 1.5);

      // 3. Diagonal wooden cross-bracing
      ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(bx + 2, by + 2);
      ctx.lineTo(bx + boxSize - 2, by + boxSize - 2);
      ctx.moveTo(bx + boxSize - 2, by + 2);
      ctx.lineTo(bx + 2, by + boxSize - 2);
      ctx.stroke();

      // 4. Outer metallic reinforced border
      ctx.strokeStyle = metalColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, boxSize, boxSize);

      // 5. Corner reinforcement brackets
      const corner = 7;
      ctx.fillStyle = metalHighlight;
      // Top-left
      ctx.fillRect(bx, by, corner, 2);
      ctx.fillRect(bx, by, 2, corner);
      // Top-right
      ctx.fillRect(bx + boxSize - corner, by, corner, 2);
      ctx.fillRect(bx + boxSize - 2, by, 2, corner);
      // Bottom-left
      ctx.fillRect(bx, by + boxSize - 2, corner, 2);
      ctx.fillRect(bx, by + boxSize - corner, 2, corner);
      // Bottom-right
      ctx.fillRect(bx + boxSize - corner, by + boxSize - 2, corner, 2);
      ctx.fillRect(bx + boxSize - 2, by + boxSize - corner, 2, corner);

      // 6. Corner rivets (little 1px dots)
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(bx + 2, by + 2, 1, 1);
      ctx.fillRect(bx + boxSize - 3, by + 2, 1, 1);
      ctx.fillRect(bx + 2, by + boxSize - 3, 1, 1);
      ctx.fillRect(bx + boxSize - 3, by + boxSize - 3, 1, 1);

      // 7. Center emblem badge
      const cx = size / 2;
      const cy = size / 2;
      ctx.fillStyle = emblemColor;
      if (type === "gold" || type === "late") {
        // Star emblem
        this.drawStar(ctx, cx, cy, 5, 5, 2.5);
      } else if (type === "troops" || type === "early") {
        // Cross / Chevron emblem
        ctx.fillRect(cx - 1.5, cy - 4.5, 3, 9);
        ctx.fillRect(cx - 4.5, cy - 1.5, 9, 3);
      } else {
        // Diamond emblem for mid/standard
        ctx.beginPath();
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx + 4, cy);
        ctx.lineTo(cx, cy + 4);
        ctx.lineTo(cx - 4, cy);
        ctx.closePath();
        ctx.fill();
      }
    } finally {
      ctx.restore();
    }

    return canvas;
  }

  private drawStar(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    spikes: number,
    outerRadius: number,
    innerRadius: number,
  ): void {
    let rot = (Math.PI / 2) * 3;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
      const x1 = cx + Math.cos(rot) * outerRadius;
      const y1 = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x1, y1);
      rot += step;

      const x2 = cx + Math.cos(rot) * innerRadius;
      const y2 = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x2, y2);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Retrieve a prerendered supply crate canvas.
   */
  public getSupplyCrate(type: SupplyCrateType = "standard"): HTMLCanvasElement {
    const cached = this.supplyCrates.get(type);
    if (cached) return cached;
    return this.supplyCrates.get("standard")!;
  }

  // ============================================================
  // 3. BASE AVATAR PARTS (Pre-rendered avatar discs, halos, badges)
  // ============================================================

  private prerenderAvatarParts(): void {
    // Standard avatar parts at 48x48
    this.avatarParts.set("baseDisc", this.bakeAvatarBaseDisc());
    this.avatarParts.set("haloRing", this.bakeAvatarHaloRing());
    this.avatarParts.set("crestShield", this.bakeAvatarCrestShield());
    this.avatarParts.set("starBadge", this.bakeAvatarStarBadge());
    this.avatarParts.set("botIcon", this.bakeAvatarBotIcon());
  }

  private bakeAvatarBaseDisc(): HTMLCanvasElement {
    const size = 36;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);
    const center = size / 2;
    const radius = size * 0.44;

    ctx.save();
    try {
      // Outer drop shadow
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.arc(center, center + 1.5, radius, 0, Math.PI * 2);
      ctx.fill();

      // Disc fill with soft gradient
      const grad = ctx.createLinearGradient(center, center - radius, center, center + radius);
      grad.addColorStop(0, "#1e293b");
      grad.addColorStop(1, "#0f172a");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.fill();

      // Inner stroke
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } finally {
      ctx.restore();
    }
    return canvas;
  }

  private bakeAvatarHaloRing(): HTMLCanvasElement {
    const size = 48;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);
    const center = size / 2;
    const radius = size * 0.38;

    ctx.save();
    try {
      ctx.shadowColor = "#38bdf8";
      ctx.shadowBlur = 8;
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.stroke();
    } finally {
      ctx.restore();
    }
    return canvas;
  }

  private bakeAvatarCrestShield(): HTMLCanvasElement {
    const size = 32;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);

    ctx.save();
    try {
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath();
      // Shield path
      ctx.moveTo(16, 6);
      ctx.lineTo(24, 9);
      ctx.lineTo(24, 18);
      ctx.bezierCurveTo(24, 23, 16, 26, 16, 27);
      ctx.bezierCurveTo(16, 26, 8, 23, 8, 18);
      ctx.lineTo(8, 9);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1;
      ctx.stroke();
    } finally {
      ctx.restore();
    }
    return canvas;
  }

  private bakeAvatarStarBadge(): HTMLCanvasElement {
    const size = 24;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);

    ctx.save();
    try {
      ctx.fillStyle = "#facc15";
      this.drawStar(ctx, 12, 12, 5, 9, 4.5);
      ctx.strokeStyle = "#ca8a04";
      ctx.lineWidth = 1;
      ctx.stroke();
    } finally {
      ctx.restore();
    }
    return canvas;
  }

  private bakeAvatarBotIcon(): HTMLCanvasElement {
    const size = 32;
    const { canvas, ctx } = AssetCache.createOffscreenCanvas(size, size);

    ctx.save();
    try {
      ctx.fillStyle = "#94a3b8";
      // Robot head outline
      ctx.fillRect(8, 10, 16, 14);
      // Antenna
      ctx.fillRect(15, 6, 2, 4);
      ctx.beginPath();
      ctx.arc(16, 5, 2, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(11, 14, 3, 3);
      ctx.fillRect(18, 14, 3, 3);
    } finally {
      ctx.restore();
    }
    return canvas;
  }

  /**
   * Retrieve a prerendered avatar part canvas.
   */
  public getAvatarPart(part: AvatarPartType): HTMLCanvasElement {
    const cached = this.avatarParts.get(part);
    if (!cached) {
      throw new Error(`Avatar part ${part} not found in AssetCache`);
    }
    return cached;
  }

  /**
   * Purge and release all cached canvas surfaces.
   */
  public clear(): void {
    this.boundaryStamps.clear();
    this.supplyCrates.clear();
    this.avatarParts.clear();
    this.genericStamps.clear();
    this.isInitialised = false;
  }
}
