import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { Controller } from "../../Controller";
import {
  SetTacticalOverlayModeEvent,
  TacticalOverlayModeChangedEvent,
} from "../../InputHandler";
import { TacticalOverlayMode } from "../../render/gl";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

@customElement("tactical-overlay-selector")
export class TacticalOverlaySelector extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state()
  private currentMode: TacticalOverlayMode = TacticalOverlayMode.Off;

  @state()
  private isOpen: boolean = false;

  @state()
  private isVisible: boolean = false;

  createRenderRoot() {
    return this;
  }

  init() {
    this.isVisible = true;
    this.isOpen = false;
    this.currentMode = TacticalOverlayMode.Off;
    this.eventBus.on(TacticalOverlayModeChangedEvent, (e) => {
      this.currentMode = e.mode;
    });
    this.requestUpdate();
  }

  destroy() {
    this.isVisible = false;
    this.isOpen = false;
    this.currentMode = TacticalOverlayMode.Off;
    this.requestUpdate();
  }

  dispose() {
    this.destroy();
  }

  private getLabel(key: string, fallback: string): string {
    const translated = translateText(key);
    return translated === key ? fallback : translated;
  }

  private setMode(mode: TacticalOverlayMode) {
    this.currentMode = mode;
    this.eventBus.emit(new SetTacticalOverlayModeEvent(mode));
  }

  private toggleOpen() {
    this.isOpen = !this.isOpen;
  }

  render() {
    if (!this.isVisible) {
      return html``;
    }

    const modes = [
      {
        id: TacticalOverlayMode.Off,
        label: this.getLabel("tactical_overlay.off", "Off"),
        color: "bg-gray-700 hover:bg-gray-600",
      },
      {
        id: TacticalOverlayMode.TroopDensity,
        label: this.getLabel("tactical_overlay.troops", "Troop Density"),
        color: "bg-amber-600 hover:bg-amber-500 text-black font-bold",
      },
      {
        id: TacticalOverlayMode.SAMCoverage,
        label: this.getLabel("tactical_overlay.sams", "SAM Coverage"),
        color: "bg-emerald-600 hover:bg-emerald-500 font-bold",
      },
      {
        id: TacticalOverlayMode.TradeEfficiency,
        label: this.getLabel("tactical_overlay.trade", "Trade"),
        color: "bg-cyan-600 hover:bg-cyan-500 font-bold",
      },
      {
        id: TacticalOverlayMode.NavalThreat,
        label: this.getLabel("tactical_overlay.naval", "Naval"),
        color: "bg-pink-700 hover:bg-pink-600 font-bold",
      },
    ];

    const activeLabel =
      modes.find((m) => m.id === this.currentMode)?.label ?? "Tactical";

    return html`
      <div
        class="fixed bottom-24 lg:bottom-4 right-16 z-[900] pointer-events-auto select-none flex flex-col-reverse items-end gap-1.5"
      >
        <button
          @click=${this.toggleOpen}
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/90 hover:bg-gray-800/90 text-xs font-semibold text-white uppercase tracking-wider backdrop-blur-sm border border-white/10 shadow-lg transition-all"
          title="Toggle Tactical Map Overlays [O]"
        >
          <span
            class="w-2 h-2 rounded-full ${this.currentMode ===
            TacticalOverlayMode.Off
              ? "bg-gray-400"
              : "bg-emerald-400 animate-pulse"}"
          ></span>
          <span>Tactical: ${activeLabel}</span>
          <span
            class="text-[10px] text-gray-400 font-mono bg-white/10 px-1 py-0.5 rounded"
            >O</span
          >
        </button>

        ${this.isOpen
          ? html`
              <div
                class="flex items-center gap-1 p-1 rounded-xl bg-gray-900/95 backdrop-blur-md border border-white/15 shadow-2xl animate-fade-in"
              >
                ${modes.map(
                  (m) => html`
                    <button
                      @click=${() => this.setMode(m.id)}
                      class="px-2.5 py-1 text-xs rounded-lg uppercase tracking-wide transition-all ${this
                        .currentMode === m.id
                        ? `${m.color} ring-2 ring-white/60 shadow-md`
                        : "bg-white/5 hover:bg-white/15 text-gray-300"}"
                    >
                      ${m.label}
                    </button>
                  `,
                )}
              </div>
            `
          : ""}
      </div>
    `;
  }
}
