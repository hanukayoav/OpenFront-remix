import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../core/AssetUrls";
import { DISPLAY_APP_VERSION } from "./AppVersion";
import { translateText } from "./Utils";

@customElement("game-starting-modal")
export class GameStartingModal extends LitElement {
  @state()
  isVisible = false;

  createRenderRoot() {
    return this;
  }

  render() {
    const isVisible = this.isVisible;
    return html`
      <div
        class="fixed inset-0 bg-black/60 backdrop-blur-[6px] z-[9998] transition-all duration-300 ${isVisible
          ? "opacity-100 visible"
          : "opacity-0 invisible pointer-events-none"}"
      ></div>
      <div
        class="fixed top-1/2 left-1/2 bg-zinc-900/95 backdrop-blur-xl border border-white/10 p-7 rounded-2xl z-[9999] shadow-2xl text-white w-[92vw] max-w-[460px] text-center transition-all duration-300 -translate-x-1/2 ${isVisible
          ? "opacity-100 visible -translate-y-1/2"
          : "opacity-0 invisible -translate-y-[48%] pointer-events-none"}"
      >
        <!-- Concept A Shield Emblem -->
        <div class="flex justify-center mb-4">
          <div
            class="w-24 h-24 relative drop-shadow-[0_0_20px_rgba(0,132,209,0.5)]"
          >
            <img
              src=${assetUrl("images/FrontierXEmblem.svg")}
              alt="FrontierX Emblem"
              class="w-full h-full object-contain"
            />
          </div>
        </div>

        <!-- Title & Version -->
        <div class="flex items-center justify-center gap-2 mb-1">
          <span class="text-2xl font-black tracking-wider uppercase text-white">
            Frontier<span
              class="text-transparent bg-clip-text bg-gradient-to-r from-hex-cyan to-malibu-blue drop-shadow-[0_0_8px_rgba(0,200,255,0.6)]"
              >X</span
            >
          </span>
          <span
            class="text-[10px] font-extrabold px-2 py-0.5 rounded bg-malibu-blue/20 border border-hex-cyan/40 text-hex-cyan tracking-widest"
          >
            ${DISPLAY_APP_VERSION}
          </span>
        </div>
        <div
          class="text-[11px] font-bold tracking-[0.25em] uppercase text-white/50 mb-5"
        >
          Tactical Command Shield
        </div>

        <!-- Loading Progress Bar & Status -->
        <div
          class="w-full bg-white/10 rounded-full h-2 overflow-hidden mb-3 relative"
        >
          <div
            class="bg-gradient-to-r from-malibu-blue via-aquarius to-white h-full rounded-full w-full animate-pulse shadow-[0_0_12px_rgba(0,200,255,0.8)]"
          ></div>
        </div>
        <div
          class="flex items-center justify-center gap-2 text-sm font-semibold text-aquarius mb-5"
        >
          <span
            class="w-2 h-2 rounded-full bg-hex-cyan shadow-[0_0_8px_#00c8ff] animate-ping"
          ></span>
          <span>${translateText("game_starting_modal.title")}</span>
        </div>

        <!-- Licensing, Open-Source & Contributor Attribution (Section 7 Safeguard) -->
        <div class="border-t border-white/10 pt-4 mt-2">
          <div
            class="text-[11px] font-medium tracking-wider uppercase text-white/40 mb-1"
          >
            © OpenFront and Contributors
          </div>
          <p class="text-xs text-white/35 mb-2 leading-relaxed">
            FrontierX is an independent game based on OpenFront.
            ${translateText("game_starting_modal.code_license")}
          </p>
          <a
            href="https://github.com/openfrontio/OpenFrontIO/blob/main/CREDITS.md"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-block text-xs font-semibold tracking-wider uppercase text-malibu-blue no-underline transition-colors duration-200 hover:text-aquarius"
          >
            ${translateText("game_starting_modal.credits")}
          </a>
        </div>
      </div>
    `;
  }

  show() {
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }
}
