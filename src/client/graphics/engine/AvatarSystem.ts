/**
 * OpenFront Customisable Interactive Avatars and Screen Shake Architecture
 *
 * Implements player capital avatars with real-time state machines:
 * - Configuration: Persisted customisation for skin tone, shirt colour, and hair colour.
 * - Positioning: Rendered cleanly on the dynamic layer above the capital node so territory numbers remain visible.
 * - Action State Machine:
 *   - Idle State: Subtle vertical bobbing calculation using Math.sin on the tick variable.
 *   - Attacking State: Computes Math.atan2 to enemy target node; rotates arm primitive toward the target for troop deployment.
 *   - Victory State: Raises both arms in celebration upon capturing enemy capitals or securing supply drops.
 * - Visual Polish: 4-frame camera jitter screen shake between +2px and -2px.
 */

export interface AvatarColorConfig {
  skinTone: string;
  shirtColor: string;
  hairColor: string;
}

export const DEFAULT_AVATAR_CONFIG: AvatarColorConfig = {
  skinTone: "#fed7aa", // Warm fair tone
  shirtColor: "#3b82f6", // Vibrant electric blue
  hairColor: "#451a03", // Deep dark brown
};

export const AVATAR_SKIN_PRESETS = [
  "#fed7aa", // Light Peach
  "#fcd34d", // Golden Warm
  "#d97706", // Caramel Tan
  "#b45309", // Medium Bronze
  "#78350f", // Deep Umber
  "#451a03", // Rich Espresso
];

export const AVATAR_SHIRT_PRESETS = [
  "#ef4444", // Crimson Red
  "#3b82f6", // Azure Blue
  "#10b981", // Emerald Green
  "#8b5cf6", // Royal Purple
  "#f59e0b", // Amber Gold
  "#475569", // Stealth Slate
  "#ec4899", // Neon Rose
  "#06b6d4", // Electric Cyan
];

export const AVATAR_HAIR_PRESETS = [
  "#18181b", // Midnight Black
  "#451a03", // Dark Brown
  "#92400e", // Auburn Chestnut
  "#fde047", // Golden Blonde
  "#e2e8f0", // Platinum Silver
  "#06b6d4", // Cyber Cyan
  "#f43f5e", // Scarlet
];

const STORAGE_KEY = "openfront_avatar_customization";

export function loadAvatarConfig(): AvatarColorConfig {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.skinTone && parsed.shirtColor && parsed.hairColor) {
          return parsed;
        }
      }
    }
  } catch {
    // Fall back to default on parse/storage error
  }
  return { ...DEFAULT_AVATAR_CONFIG };
}

export function saveAvatarConfig(config: AvatarColorConfig): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }
  } catch {
    // Storage quota or restriction fallback
  }
}

export type AvatarActionState = "idle" | "attacking" | "victory";

export interface CapitalAvatar {
  id: string | number;
  playerId: number;
  capitalX: number;
  capitalY: number;
  state: AvatarActionState;
  stateTimerMs: number;
  targetX: number;
  targetY: number;
  config: AvatarColorConfig;
  isLocalPlayer?: boolean;
}

/**
 * ScreenShakeController manages a 4-frame camera jitter when capitals or supply drops are captured.
 */
export class ScreenShakeController {
  private framesRemaining = 0;
  public offsetX = 0;
  public offsetY = 0;

  public trigger(frames = 4, _magnitude = 2): void {
    this.framesRemaining = frames;
    if (frames > 0) {
      this.offsetX = Math.floor(Math.random() * 5) - 2;
      this.offsetY = Math.floor(Math.random() * 5) - 2;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }

  public isShaking(): boolean {
    return this.framesRemaining > 0;
  }

  public isActive(): boolean {
    return this.isShaking();
  }

  public get remainingFrames(): number {
    return this.framesRemaining;
  }

  public getOffset(): { x: number; y: number } {
    return { x: this.offsetX, y: this.offsetY };
  }

  public advanceFrame(): void {
    this.update();
  }

  public update(): void {
    if (this.framesRemaining > 1) {
      this.framesRemaining--;
      // Random jitter offset strictly between +2 and -2 pixels
      this.offsetX = Math.floor(Math.random() * 5) - 2;
      this.offsetY = Math.floor(Math.random() * 5) - 2;
    } else {
      this.framesRemaining = 0;
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }
}

export class AvatarSystem {
  private readonly avatars = new Map<string | number, CapitalAvatar>();
  public readonly screenShake = new ScreenShakeController();
  private localConfig: AvatarColorConfig = loadAvatarConfig();

  public getConfig(): AvatarColorConfig {
    return { ...this.localConfig };
  }

  public setConfig(config: Partial<AvatarColorConfig> & { skin?: string; shirt?: string; hair?: string }): void {
    if (config.skinTone || config.skin) this.localConfig.skinTone = config.skinTone ?? config.skin!;
    if (config.shirtColor || config.shirt) this.localConfig.shirtColor = config.shirtColor ?? config.shirt!;
    if (config.hairColor || config.hair) this.localConfig.hairColor = config.hairColor ?? config.hair!;
    saveAvatarConfig(this.localConfig);
    const local = this.getLocalAvatar();
    if (local) {
      local.config = { ...this.localConfig };
    }
  }

  public setCapitalPosition(x: number, y: number): void {
    let local = this.getLocalAvatar();
    if (!local) {
      local = this.registerAvatar("local_capital", 1, x, y, this.localConfig, true);
    } else {
      local.capitalX = x;
      local.capitalY = y;
      local.targetX = x;
      local.targetY = y;
    }
  }

  public getState(): AvatarActionState {
    return this.getLocalAvatar()?.state ?? "idle";
  }

  public getTargetAngle(): number {
    const local = this.getLocalAvatar();
    if (!local) return 0;
    return Math.atan2(local.targetY - local.capitalY, local.targetX - local.capitalX);
  }

  public registerAvatar(
    id: string | number,
    playerId: number,
    capitalX: number,
    capitalY: number,
    config: AvatarColorConfig = loadAvatarConfig(),
    isLocalPlayer = false,
  ): CapitalAvatar {
    const avatar: CapitalAvatar = {
      id,
      playerId,
      capitalX,
      capitalY,
      state: "idle",
      stateTimerMs: 0,
      targetX: capitalX,
      targetY: capitalY,
      config,
      isLocalPlayer,
    };
    this.avatars.set(id, avatar);
    return avatar;
  }

  public getAvatar(id: string | number): CapitalAvatar | undefined {
    return this.avatars.get(id);
  }

  public getLocalAvatar(): CapitalAvatar | undefined {
    for (const avatar of this.avatars.values()) {
      if (avatar.isLocalPlayer) return avatar;
    }
    return undefined;
  }

  public triggerAttack(
    avatarIdOrTargetX: string | number,
    targetXOrY?: number,
    targetYOrDuration?: number,
    durationMs = 1500,
  ): void {
    let targetAvatar: CapitalAvatar | undefined;
    let tx = 0;
    let ty = 0;
    let dur = durationMs;

    if (typeof avatarIdOrTargetX === "string") {
      targetAvatar = this.avatars.get(avatarIdOrTargetX);
      tx = targetXOrY ?? 0;
      ty = targetYOrDuration ?? 0;
      dur = durationMs;
    } else if (typeof avatarIdOrTargetX === "number") {
      if (this.avatars.has(avatarIdOrTargetX)) {
        targetAvatar = this.avatars.get(avatarIdOrTargetX);
        tx = targetXOrY ?? 0;
        ty = targetYOrDuration ?? 0;
        dur = durationMs;
      } else {
        targetAvatar = this.getLocalAvatar();
        tx = avatarIdOrTargetX;
        ty = targetXOrY ?? 0;
        dur = targetYOrDuration ?? durationMs;
      }
    }

    if (!targetAvatar) return;
    targetAvatar.state = "attacking";
    targetAvatar.targetX = tx;
    targetAvatar.targetY = ty;
    targetAvatar.stateTimerMs = dur;
  }

  public triggerVictory(avatarIdOrDuration: string | number = 2500, durationMs = 2500): void {
    let targetAvatar: CapitalAvatar | undefined;
    let dur = durationMs;

    if (typeof avatarIdOrDuration === "string") {
      targetAvatar = this.avatars.get(avatarIdOrDuration);
      dur = durationMs;
    } else if (typeof avatarIdOrDuration === "number") {
      if (this.avatars.has(avatarIdOrDuration)) {
        targetAvatar = this.avatars.get(avatarIdOrDuration);
        dur = durationMs;
      } else {
        targetAvatar = this.getLocalAvatar();
        dur = avatarIdOrDuration;
      }
    }

    if (!targetAvatar) return;
    targetAvatar.state = "victory";
    targetAvatar.stateTimerMs = dur;
    this.screenShake.trigger(4);
  }

  public update(deltaMs: number): void {
    this.screenShake.update();

    for (const avatar of this.avatars.values()) {
      if (avatar.state !== "idle") {
        avatar.stateTimerMs -= deltaMs;
        if (avatar.stateTimerMs <= 0) {
          avatar.state = "idle";
          avatar.stateTimerMs = 0;
        }
      }
    }
  }

  /**
   * Render all capital avatars onto the dynamic layer canvas context.
   */
  public render(ctx: CanvasRenderingContext2D, tick: number): void {
    for (const avatar of this.avatars.values()) {
      this.drawAvatar(ctx, avatar, tick);
    }
  }

  /**
   * Draw an interactive avatar with real-time states (idle, attacking, victory).
   */
  public drawAvatar(ctx: CanvasRenderingContext2D, avatar: CapitalAvatar, tick: number): void {
    const { capitalX, capitalY, config, state } = avatar;

    // Positioned directly above the capital node so territory numbers remain visible below
    const baseY = capitalY - 22;

    // 1. Idle state: Subtle vertical bobbing calculation using Math.sin on tick
    let bobY = 0;
    if (state === "idle") {
      bobY = Math.sin(tick * 0.08) * 1.5;
    } else if (state === "victory") {
      // Fast excited bouncing in victory state
      bobY = Math.sin(tick * 0.25) * 2.5;
    }

    const ax = (capitalX + 0.5) | 0;
    const ay = ((baseY + bobY) + 0.5) | 0;

    ctx.save();
    try {
      // Contact shadow below feet
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.ellipse(ax, capitalY - 7, 7, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Mini golden capital crown above head
      ctx.fillStyle = "#facc15";
      ctx.strokeStyle = "#ca8a04";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax - 5, ay - 11);
      ctx.lineTo(ax - 5, ay - 8);
      ctx.lineTo(ax + 5, ay - 8);
      ctx.lineTo(ax + 5, ay - 11);
      ctx.lineTo(ax + 2.5, ay - 9);
      ctx.lineTo(ax, ay - 12);
      ctx.lineTo(ax - 2.5, ay - 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Torso / Shirt primitive
      ctx.fillStyle = config.shirtColor;
      ctx.fillRect(ax - 4, ay - 2, 8, 7);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = 1;
      ctx.strokeRect(ax - 4, ay - 2, 8, 7);

      // Head primitive
      ctx.fillStyle = config.skinTone;
      ctx.beginPath();
      ctx.arc(ax, ay - 5, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Eyes (2 small dark pixels)
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(ax - 2, ay - 5.5, 1, 1.5);
      ctx.fillRect(ax + 1, ay - 5.5, 1, 1.5);

      // Hair primitive
      ctx.fillStyle = config.hairColor;
      ctx.beginPath();
      ctx.arc(ax, ay - 6.5, 4.6, Math.PI, Math.PI * 2);
      ctx.fill();
      // Bangs / side hair
      ctx.fillRect(ax - 4.5, ay - 6.5, 2, 3);
      ctx.fillRect(ax + 2.5, ay - 6.5, 2, 3);

      // ARMS & ACTIONS
      if (state === "attacking") {
        // Attacking State: Calculate angle to enemy target node using Math.atan2
        const attackAngle = Math.atan2(avatar.targetY - capitalY, avatar.targetX - capitalX);

        // Pointing arm rotated towards the target angle
        ctx.save();
        ctx.translate(ax + 3, ay);
        ctx.rotate(attackAngle);
        ctx.fillStyle = config.shirtColor;
        ctx.fillRect(0, -1.5, 8, 3);
        ctx.fillStyle = config.skinTone;
        ctx.fillRect(7, -1.5, 2.5, 3); // Hand
        ctx.restore();

        // Left arm tucked back
        ctx.fillStyle = config.shirtColor;
        ctx.fillRect(ax - 6, ay - 1, 2.5, 5);
      } else if (state === "victory") {
        // Victory State: Raise both arms in celebration
        ctx.save();
        ctx.translate(ax - 3, ay - 1);
        ctx.rotate(-Math.PI * 0.7); // Left arm raised high
        ctx.fillStyle = config.shirtColor;
        ctx.fillRect(0, -1.5, 7, 3);
        ctx.fillStyle = config.skinTone;
        ctx.fillRect(6, -1.5, 2.5, 3);
        ctx.restore();

        ctx.save();
        ctx.translate(ax + 3, ay - 1);
        ctx.rotate(-Math.PI * 0.3); // Right arm raised high
        ctx.fillStyle = config.shirtColor;
        ctx.fillRect(0, -1.5, 7, 3);
        ctx.fillStyle = config.skinTone;
        ctx.fillRect(6, -1.5, 2.5, 3);
        ctx.restore();
      } else {
        // Idle State: Arms relaxed at sides
        ctx.fillStyle = config.shirtColor;
        ctx.fillRect(ax - 6, ay - 1, 2.5, 6);
        ctx.fillRect(ax + 3.5, ay - 1, 2.5, 6);
        ctx.fillStyle = config.skinTone;
        ctx.fillRect(ax - 6, ay + 4.5, 2.5, 2);
        ctx.fillRect(ax + 3.5, ay + 4.5, 2.5, 2);
      }
    } finally {
      ctx.restore();
    }
  }

  public clear(): void {
    this.avatars.clear();
  }
}
