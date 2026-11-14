/**
 * OpenFront Custom Match Mutator Panel (LobbySettings)
 *
 * Provides a sleek, collapsible mutators panel in the pregame lobby screen:
 * - Match Pace: 1x (Standard), 1.5x (Tactical Sprint), 2x (Turbo Chaos).
 *   Multiplies global troop generation rates and unit movement speeds.
 * - Drop Frequency: Normal (45s intervals), Rapid (20s intervals), Extreme (3 crates active simultaneously).
 * - Sudden Death Timer: 3 Minutes, 5 Minutes, or Unlimited Domination.
 * - LocalStorage Persistence: Keeps preferred modifier selections saved across sessions.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  resolveSupplyDropConfig,
  SupplyDropFrequency,
} from "../../core/Schemas";

export type MatchPace = 1.0 | 1.5 | 2.0;
export type DropFrequency = SupplyDropFrequency;
export type SuddenDeathTimer = 180 | 300 | 0; // seconds, 0 = unlimited

export interface MatchMutators {
  matchPace: MatchPace;
  dropFrequency: DropFrequency;
  suddenDeathTimer: SuddenDeathTimer;
}

export const DEFAULT_MUTATORS: MatchMutators = {
  matchPace: 1.0,
  dropFrequency: "normal",
  suddenDeathTimer: 0,
};

export const MUTATORS_STORAGE_KEY = "openfront_match_mutators";

/**
 * Loads persistent mutator settings from localStorage.
 */
export function loadMutators(): MatchMutators {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(MUTATORS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          matchPace: [1.0, 1.5, 2.0].includes(parsed.matchPace) ? parsed.matchPace : 1.0,
          dropFrequency: ["normal", "rapid", "extreme"].includes(parsed.dropFrequency)
            ? parsed.dropFrequency
            : "normal",
          suddenDeathTimer: [180, 300, 0].includes(parsed.suddenDeathTimer)
            ? parsed.suddenDeathTimer
            : 0,
        };
      }
    }
  } catch {
    // Fall back to defaults
  }
  return { ...DEFAULT_MUTATORS };
}

/**
 * Persists mutator settings to localStorage.
 */
export function saveMutators(mutators: MatchMutators): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MUTATORS_STORAGE_KEY, JSON.stringify(mutators));
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

/**
 * Helper to obtain the drop evaluation interval in seconds.
 */
export function getDropIntervalSec(freq: DropFrequency): number {
  return resolveSupplyDropConfig(freq).intervalSec;
}

/**
 * Helper to obtain the max active crates simultaneously.
 */
export function getMaxActiveDrops(freq: DropFrequency): number {
  return resolveSupplyDropConfig(freq).maxActiveCrates;
}

/**
 * Helper to obtain the match pace multiplier (1.0, 1.5, 2.0).
 */
export function getPaceMultiplier(pace: MatchPace): number {
  return pace;
}

@customElement("lobby-mutators-panel")
export class LobbyMutatorsPanel extends LitElement {
  @state() private mutators: MatchMutators = loadMutators();
  @state() private isExpanded = false;

  createRenderRoot() {
    return this;
  }

  public getMutators(): MatchMutators {
    return this.mutators;
  }

  private updateMutator<K extends keyof MatchMutators>(key: K, value: MatchMutators[K]): void {
    this.mutators = {
      ...this.mutators,
      [key]: value,
    };
    saveMutators(this.mutators);
    this.dispatchEvent(
      new CustomEvent("mutators-changed", {
        detail: this.mutators,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
  }

  render() {
    const { matchPace, dropFrequency, suddenDeathTimer } = this.mutators;

    return html`
      <div
        class="w-full bg-slate-900/90 border border-white/15 rounded-xl shadow-xl backdrop-blur-md overflow-hidden transition-all duration-200 text-white font-sans text-xs"
      >
        <!-- Collapsible Header -->
        <button
          type="button"
          @click=${this.toggleExpanded}
          class="w-full flex items-center justify-between p-3 bg-surface/60 hover:bg-surface/90 transition-colors text-left cursor-pointer border-b border-white/10"
          aria-expanded=${this.isExpanded}
        >
          <div class="flex items-center gap-2">
            <span class="text-amber-400 text-sm">⚡</span>
            <span class="font-extrabold uppercase tracking-wider text-[11px] text-white/90">
              Match Mutators & Modifiers
            </span>
            <span class="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-white/60">
              ${matchPace}x Pace • ${dropFrequency} • ${suddenDeathTimer > 0 ? `${suddenDeathTimer / 60}m` : "Unlimited"}
            </span>
          </div>

          <div class="flex items-center gap-1.5 text-white/50 text-[11px]">
            <span>${this.isExpanded ? "Collapse" : "Customize"}</span>
            <span class="transform transition-transform duration-200 ${this.isExpanded ? "rotate-180" : ""}">▼</span>
          </div>
        </button>

        <!-- Collapsible Body -->
        <div class="${this.isExpanded ? "flex" : "hidden"} flex-col gap-3.5 p-3.5 bg-slate-950/40">
          <!-- 1. Match Pace -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-white/80 uppercase tracking-wide text-[10px]">
                Match Pace (Troop Rate & Speed)
              </span>
              <span class="text-white/40 text-[10px]">Affects production & march speed</span>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                @click=${() => this.updateMutator("matchPace", 1.0)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  matchPace === 1.0
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                1x Standard
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("matchPace", 1.5)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  matchPace === 1.5
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                1.5x Sprint
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("matchPace", 2.0)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  matchPace === 2.0
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                2x Turbo Chaos
              </button>
            </div>
          </div>

          <!-- 2. Drop Frequency -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-white/80 uppercase tracking-wide text-[10px]">
                Supply Drop Frequency
              </span>
              <span class="text-white/40 text-[10px]">Crate spawn cadence & cap</span>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                @click=${() => this.updateMutator("dropFrequency", "normal")}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  dropFrequency === "normal"
                    ? "bg-blue-500/20 text-blue-300 border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                Normal (45s)
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("dropFrequency", "rapid")}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  dropFrequency === "rapid"
                    ? "bg-purple-500/20 text-purple-300 border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                Rapid (20s)
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("dropFrequency", "extreme")}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  dropFrequency === "extreme"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                Extreme (3 Crates)
              </button>
            </div>
          </div>

          <!-- 3. Sudden Death Timer -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-white/80 uppercase tracking-wide text-[10px]">
                Sudden Death Limit
              </span>
              <span class="text-white/40 text-[10px]">Match duration cap</span>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                @click=${() => this.updateMutator("suddenDeathTimer", 0)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  suddenDeathTimer === 0
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                Unlimited
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("suddenDeathTimer", 180)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  suddenDeathTimer === 180
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                3 Minutes
              </button>
              <button
                type="button"
                @click=${() => this.updateMutator("suddenDeathTimer", 300)}
                class="py-1.5 px-2 rounded-lg font-bold border transition-all text-center cursor-pointer ${
                  suddenDeathTimer === 300
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.2)]"
                    : "bg-surface/40 hover:bg-surface/70 text-white/70 border-white/10"
                }"
              >
                5 Minutes
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
