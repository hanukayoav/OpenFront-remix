/**
 * OpenFront Avatar Customizer Component
 *
 * Provides a compact, responsive lobby UI for customizing the player's avatar
 * (skin tone, shirt colour, and hair colour) with real-time canvas preview.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  AVATAR_HAIR_PRESETS,
  AVATAR_SHIRT_PRESETS,
  AVATAR_SKIN_PRESETS,
  AvatarColorConfig,
  AvatarSystem,
  loadAvatarConfig,
  saveAvatarConfig,
} from "../graphics/engine/AvatarSystem";

@customElement("avatar-customizer")
export class AvatarCustomizer extends LitElement {
  @state() private config: AvatarColorConfig = loadAvatarConfig();
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewCtx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private previewTick = 0;
  private avatarSystem = new AvatarSystem();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.startPreviewLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  firstUpdated() {
    this.previewCanvas = this.querySelector<HTMLCanvasElement>("#avatar-preview-canvas");
    if (this.previewCanvas) {
      this.previewCtx = this.previewCanvas.getContext("2d");
    }
  }

  private startPreviewLoop() {
    const loop = () => {
      this.previewTick++;
      this.drawPreview();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private drawPreview() {
    if (!this.previewCanvas || !this.previewCtx) {
      this.previewCanvas = this.querySelector<HTMLCanvasElement>("#avatar-preview-canvas");
      if (this.previewCanvas) {
        this.previewCtx = this.previewCanvas.getContext("2d");
      }
      if (!this.previewCtx) return;
    }

    const ctx = this.previewCtx;
    const w = this.previewCanvas!.width;
    const h = this.previewCanvas!.height;

    ctx.clearRect(0, 0, w, h);

    // Subtle dark circular background for preview
    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Render interactive avatar using AvatarSystem drawing logic
    this.avatarSystem.drawAvatar(
      ctx,
      {
        id: "preview",
        playerId: 0,
        capitalX: w / 2,
        capitalY: h / 2 + 10,
        state: "idle",
        stateTimerMs: 0,
        targetX: w / 2,
        targetY: h / 2,
        config: this.config,
      },
      this.previewTick,
    );
  }

  private setSkin(color: string) {
    this.config = { ...this.config, skinTone: color };
    saveAvatarConfig(this.config);
    this.dispatchUpdate();
  }

  private setShirt(color: string) {
    this.config = { ...this.config, shirtColor: color };
    saveAvatarConfig(this.config);
    this.dispatchUpdate();
  }

  private setHair(color: string) {
    this.config = { ...this.config, hairColor: color };
    saveAvatarConfig(this.config);
    this.dispatchUpdate();
  }

  private dispatchUpdate() {
    this.dispatchEvent(
      new CustomEvent("avatar-customized", {
        detail: this.config,
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div
        id="avatar-customizer-root"
        class="bg-surface/90 border border-white/10 rounded-xl p-3 flex flex-col sm:flex-row items-center gap-4 text-white"
      >
        <!-- Character Live Preview -->
        <div class="flex flex-col items-center gap-1 shrink-0">
          <canvas
            id="avatar-preview-canvas"
            width="64"
            height="64"
            class="rounded-full shadow-md shadow-black/40"
          ></canvas>
          <span class="text-[10px] tracking-wide text-white/60 font-semibold uppercase">Capital Avatar</span>
        </div>

        <!-- Palette Swatch Selectors -->
        <div class="flex flex-col gap-2 flex-1 min-w-0 w-full">
          <!-- Skin Tone Row -->
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-white/70 w-12 shrink-0">Skin:</span>
            <div class="flex items-center gap-1.5 flex-wrap">
              ${AVATAR_SKIN_PRESETS.map(
                (color) => html`
                  <button
                    type="button"
                    title="${color}"
                    style="background-color: ${color};"
                    class="w-5 h-5 rounded-full cursor-pointer transition-transform hover:scale-110 active:scale-95 ${this.config.skinTone === color ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-900 scale-110' : 'opacity-80'}"
                    @click=${() => this.setSkin(color)}
                  ></button>
                `,
              )}
            </div>
          </div>

          <!-- Shirt Colour Row -->
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-white/70 w-12 shrink-0">Shirt:</span>
            <div class="flex items-center gap-1.5 flex-wrap">
              ${AVATAR_SHIRT_PRESETS.map(
                (color) => html`
                  <button
                    type="button"
                    title="${color}"
                    style="background-color: ${color};"
                    class="w-5 h-5 rounded-full cursor-pointer transition-transform hover:scale-110 active:scale-95 ${this.config.shirtColor === color ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-900 scale-110' : 'opacity-80'}"
                    @click=${() => this.setShirt(color)}
                  ></button>
                `,
              )}
            </div>
          </div>

          <!-- Hair Colour Row -->
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-white/70 w-12 shrink-0">Hair:</span>
            <div class="flex items-center gap-1.5 flex-wrap">
              ${AVATAR_HAIR_PRESETS.map(
                (color) => html`
                  <button
                    type="button"
                    title="${color}"
                    style="background-color: ${color};"
                    class="w-5 h-5 rounded-full cursor-pointer transition-transform hover:scale-110 active:scale-95 ${this.config.hairColor === color ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-900 scale-110' : 'opacity-80'}"
                    @click=${() => this.setHair(color)}
                  ></button>
                `,
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
