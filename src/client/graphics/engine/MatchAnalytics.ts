/**
 * OpenFront Post-Match Telemetry and Analytics System (MatchAnalytics)
 *
 * Implements real-time telemetry sampling into an in-memory ring buffer
 * and renders an endgame glassmorphism modal:
 * - Sampling: Captures territory control percentages and troop totals every 5 seconds.
 * - In-Memory Ring Buffer: Strictly bounded memory storage (300 samples) without GC pauses.
 * - Victor Banner: Winning player name, avatar portrait, and victory type (Domination / Timeout).
 * - Mini Canvas Line Graph: Draws multi-player territory control curves over match time.
 * - Match Medals: Most Crates Secured, Total Troops Marshalled, and Highest Territory Peak.
 * - Play Again Action: Cleanly resets state, clears telemetry arrays, and reloads lobby.
 */

import { AvatarColorConfig, AvatarSystem } from "./AvatarSystem";

export interface PlayerTelemetrySnapshot {
  playerId: number | string;
  name: string;
  color: string;
  territoryPercent: number; // 0 to 100
  troops: number;
}

export interface MatchTelemetrySample {
  timeSec: number;
  players: PlayerTelemetrySnapshot[];
}

export interface MatchMedalData {
  mostCrates: { playerName: string; playerColor: string; count: number };
  totalTroops: { playerName: string; playerColor: string; amount: number };
  peakTerritory: { playerName: string; playerColor: string; percent: number };
}

export interface VictoryModalOptions {
  winnerName: string;
  winnerColor: string;
  winnerId: number | string;
  victoryType: "Domination" | "Timeout";
  avatarConfig?: AvatarColorConfig;
  onPlayAgain?: () => void;
}

/**
 * Fixed-capacity circular ring buffer to prevent unbounded memory growth.
 */
export class TelemetryRingBuffer {
  private readonly buffer: MatchTelemetrySample[];
  private head = 0;
  private count = 0;

  constructor(public readonly capacity: number = 300) {
    this.buffer = new Array(capacity);
  }

  public push(sample: MatchTelemetrySample): void {
    const index = (this.head + this.count) % this.capacity;
    this.buffer[index] = sample;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  public getSamples(): MatchTelemetrySample[] {
    const result: MatchTelemetrySample[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.buffer[idx]);
    }
    return result;
  }

  public get size(): number {
    return this.count;
  }

  public clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

export class MatchAnalytics {
  public static readonly SAMPLING_INTERVAL_MS = 5000;
  private readonly ringBuffer = new TelemetryRingBuffer(300);
  private sampleTimerMs = 0;
  private matchTimeMs = 0;

  // Medal tracking aggregators
  private readonly cratesSecured = new Map<number | string, { name: string; color: string; count: number }>();
  private readonly peakTroops = new Map<number | string, { name: string; color: string; amount: number }>();
  private readonly peakTerritory = new Map<number | string, { name: string; color: string; percent: number }>();

  private modalContainer: HTMLElement | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private avatarSystem = new AvatarSystem();

  /**
   * Samples simulation telemetry every 5 seconds into the in-memory ring buffer.
   */
  public update(
    deltaMs: number,
    sampleProvider?: () => MatchTelemetrySample | null,
  ): void {
    this.matchTimeMs += deltaMs;
    this.sampleTimerMs += deltaMs;

    if (this.sampleTimerMs >= MatchAnalytics.SAMPLING_INTERVAL_MS) {
      this.sampleTimerMs -= MatchAnalytics.SAMPLING_INTERVAL_MS;

      if (sampleProvider) {
        const sample = sampleProvider();
        if (sample) {
          this.recordSample(sample);
        }
      }
    }
  }

  /**
   * Manually push a telemetry sample into the ring buffer and update aggregates.
   */
  public recordSample(sample: MatchTelemetrySample): void {
    if (!sample || !Array.isArray(sample.players)) return;
    this.ringBuffer.push(sample);

    // Update real-time medal metrics
    for (let i = 0; i < sample.players.length; i++) {
      const p = sample.players[i];
      // Peak territory
      const currentPeakTerritory = this.peakTerritory.get(p.playerId);
      if (!currentPeakTerritory || p.territoryPercent > currentPeakTerritory.percent) {
        this.peakTerritory.set(p.playerId, {
          name: p.name,
          color: p.color,
          percent: p.territoryPercent,
        });
      }

      // Peak / marshalled troops
      const currentPeakTroops = this.peakTroops.get(p.playerId);
      if (!currentPeakTroops || p.troops > currentPeakTroops.amount) {
        this.peakTroops.set(p.playerId, {
          name: p.name,
          color: p.color,
          amount: p.troops,
        });
      }
    }
  }

  /**
   * Record a supply crate secured by a player.
   */
  public recordCrateSecured(
    playerId: number | string,
    playerName = "Player",
    playerColor = "#3b82f6",
  ): void {
    const entry = this.cratesSecured.get(playerId) ?? {
      name: playerName,
      color: playerColor,
      count: 0,
    };
    entry.count++;
    this.cratesSecured.set(playerId, entry);
  }

  /**
   * Compute medal winners across all tracked metrics.
   */
  public computeMedals(): MatchMedalData {
    let mostCrates = { playerName: "None", playerColor: "#64748b", count: 0 };
    for (const data of this.cratesSecured.values()) {
      if (data.count > mostCrates.count) {
        mostCrates = { playerName: data.name, playerColor: data.color, count: data.count };
      }
    }

    let totalTroops = { playerName: "None", playerColor: "#64748b", amount: 0 };
    for (const data of this.peakTroops.values()) {
      if (data.amount > totalTroops.amount) {
        totalTroops = { playerName: data.name, playerColor: data.color, amount: data.amount };
      }
    }

    let peakTerritory = { playerName: "None", playerColor: "#64748b", percent: 0 };
    for (const data of this.peakTerritory.values()) {
      if (data.percent > peakTerritory.percent) {
        peakTerritory = { playerName: data.name, playerColor: data.color, percent: data.percent };
      }
    }

    return { mostCrates, totalTroops, peakTerritory };
  }

  public getSamples(): MatchTelemetrySample[] {
    return this.ringBuffer.getSamples();
  }

  public get sampleCount(): number {
    return this.ringBuffer.size;
  }

  // ============================================================
  // POST-MATCH GLASSMORPHISM ANALYTICS MODAL
  // ============================================================

  /**
   * Displays the sleek dark glassmorphism post-match modal over the canvas.
   */
  public showVictoryModal(
    options: VictoryModalOptions,
    container: HTMLElement = document.body,
  ): HTMLElement {
    this.hideVictoryModal();

    const medals = this.computeMedals();
    const samples = this.ringBuffer.getSamples();

    // 1. Fullscreen overlay with dark blur
    const overlay = document.createElement("div");
    overlay.id = "openfront-match-analytics-modal";
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center p-4 " +
      "bg-black/60 backdrop-blur-xl transition-opacity duration-300 animate-fadeIn";

    // 2. Glassmorphism Card
    const card = document.createElement("div");
    card.className =
      "relative w-full max-w-2xl bg-slate-900/90 border border-white/15 " +
      "rounded-2xl p-6 shadow-2xl text-white flex flex-col gap-6 max-h-[92vh] overflow-y-auto";

    // Header Victor Banner with Close Button
    const isDomination = options.victoryType === "Domination";
    const headerHtml = `
      <div class="flex items-center justify-between border-b border-white/10 pb-5">
        <div class="flex items-center gap-4">
          <!-- Victor Avatar Portrait Canvas -->
          <div class="relative shrink-0">
            <canvas id="analytics-avatar-portrait" width="72" height="72" class="rounded-2xl border border-white/20 shadow-lg bg-slate-950/60"></canvas>
            <div class="absolute -top-2 -right-1 text-base">👑</div>
          </div>

          <div class="flex flex-col gap-1 min-w-0">
            <div class="flex items-center gap-2.5 flex-wrap">
              <span class="text-xs uppercase font-extrabold tracking-widest px-2.5 py-0.5 rounded-full ${
                isDomination ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
              }">
                ${options.victoryType} Victory
              </span>
              <span class="text-xs text-white/50 font-medium">Match Completed</span>
            </div>
            <h2 class="text-2xl font-black tracking-tight text-white flex items-center gap-2 truncate">
              <span style="color: ${options.winnerColor};">${options.winnerName}</span>
              <span class="text-white/80 font-semibold text-lg">Claims the Realm</span>
            </h2>
          </div>
        </div>

        <button
          id="analytics-close-btn"
          type="button"
          class="shrink-0 p-2.5 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer text-lg font-bold leading-none"
          title="Close / Dismiss (Esc)"
          aria-label="Close modal"
        >
          ✕
        </button>
      </div>
    `;

    // Medals Section
    const formattedTroops =
      medals.totalTroops.amount >= 1000000
        ? `${(medals.totalTroops.amount / 1000000).toFixed(1)}M`
        : medals.totalTroops.amount >= 1000
          ? `${(medals.totalTroops.amount / 1000).toFixed(1)}k`
          : medals.totalTroops.amount.toString();

    const medalsHtml = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <!-- Most Crates Secured -->
        <div class="bg-surface/80 border border-white/10 rounded-xl p-3 flex flex-col gap-1">
          <div class="flex items-center gap-1.5 text-xs text-white/60 font-semibold uppercase tracking-wider">
            <span>📦</span> Most Crates
          </div>
          <div class="text-lg font-black text-amber-400">
            ${medals.mostCrates.count} <span class="text-xs text-white/50 font-normal">Crates</span>
          </div>
          <div class="text-xs truncate font-medium" style="color: ${medals.mostCrates.playerColor};">
            ${medals.mostCrates.playerName}
          </div>
        </div>

        <!-- Total Troops Marshalled -->
        <div class="bg-surface/80 border border-white/10 rounded-xl p-3 flex flex-col gap-1">
          <div class="flex items-center gap-1.5 text-xs text-white/60 font-semibold uppercase tracking-wider">
            <span>⚔️</span> Peak Army
          </div>
          <div class="text-lg font-black text-blue-400">
            ${formattedTroops} <span class="text-xs text-white/50 font-normal">Troops</span>
          </div>
          <div class="text-xs truncate font-medium" style="color: ${medals.totalTroops.playerColor};">
            ${medals.totalTroops.playerName}
          </div>
        </div>

        <!-- Highest Territory Peak -->
        <div class="bg-surface/80 border border-white/10 rounded-xl p-3 flex flex-col gap-1">
          <div class="flex items-center gap-1.5 text-xs text-white/60 font-semibold uppercase tracking-wider">
            <span>🚩</span> Territory Peak
          </div>
          <div class="text-lg font-black text-emerald-400">
            ${medals.peakTerritory.percent.toFixed(1)}%
          </div>
          <div class="text-xs truncate font-medium" style="color: ${medals.peakTerritory.playerColor};">
            ${medals.peakTerritory.playerName}
          </div>
        </div>
      </div>
    `;

    // Mini Canvas Line Graph Container
    const graphHtml = `
      <div class="flex flex-col gap-2 bg-surface/50 border border-white/10 rounded-xl p-4">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-white/80 uppercase tracking-wider">Territory Control Timeline</span>
          <span class="text-[11px] text-white/50 font-mono">5s Interval Sampling</span>
        </div>
        <div class="w-full flex justify-center">
          <canvas id="analytics-timeline-graph" width="560" height="160" class="w-full h-auto rounded-lg bg-slate-950/40 border border-white/5"></canvas>
        </div>
      </div>
    `;

    // Footer with Spectate / Dismiss and Play Again Buttons
    const footerHtml = `
      <div class="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-2">
        <button
          id="analytics-spectate-btn"
          type="button"
          class="w-full sm:w-auto px-6 py-3 rounded-xl font-bold text-sm tracking-wide text-white/80 hover:text-white bg-white/10 hover:bg-white/15 border border-white/15 transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
        >
          <span>👁</span> Spectate Battlefield
        </button>
        <button
          id="analytics-play-again-btn"
          type="button"
          class="w-full sm:w-auto px-8 py-3 rounded-xl font-bold text-sm tracking-wide text-white cursor-pointer bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shadow-lg shadow-blue-500/25 transition-all duration-200 active:scale-95 flex items-center justify-center gap-2"
        >
          <span>↺</span> Play Again
        </button>
      </div>
    `;

    card.innerHTML = headerHtml + medalsHtml + graphHtml + footerHtml;
    overlay.appendChild(card);
    container.appendChild(overlay);
    this.modalContainer = overlay;

    // Draw Victor Portrait Avatar onto canvas
    const portraitCanvas = card.querySelector<HTMLCanvasElement>("#analytics-avatar-portrait");
    if (portraitCanvas) {
      const pCtx = portraitCanvas.getContext("2d");
      if (pCtx) {
        this.avatarSystem.drawAvatar(
          pCtx,
          {
            id: "modal_victor",
            playerId: typeof options.winnerId === "number" ? options.winnerId : 1,
            capitalX: 36,
            capitalY: 48,
            state: "victory",
            stateTimerMs: 99999,
            targetX: 36,
            targetY: 20,
            config: options.avatarConfig ?? this.avatarSystem.getConfig(),
          },
          30,
        );
      }
    }

    // Draw Territory Control Timeline Line Graph onto mini canvas
    const graphCanvas = card.querySelector<HTMLCanvasElement>("#analytics-timeline-graph");
    if (graphCanvas) {
      this.drawLineGraph(graphCanvas, samples, options.winnerId);
    }

    // Wire Close & Spectate Buttons
    const closeBtn = card.querySelector<HTMLButtonElement>("#analytics-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.hideVictoryModal());
    }

    const spectateBtn = card.querySelector<HTMLButtonElement>("#analytics-spectate-btn");
    if (spectateBtn) {
      spectateBtn.addEventListener("click", () => this.hideVictoryModal());
    }

    // Wire backdrop click to dismiss
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this.hideVictoryModal();
      }
    });

    // Wire Escape key listener to dismiss
    if (typeof window !== "undefined") {
      this.keydownHandler = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          this.hideVictoryModal();
        }
      };
      window.addEventListener("keydown", this.keydownHandler);
    }

    // Wire Play Again Button
    const playAgainBtn = card.querySelector<HTMLButtonElement>("#analytics-play-again-btn");
    if (playAgainBtn) {
      playAgainBtn.addEventListener("click", () => {
        this.hideVictoryModal();
        this.reset();
        if (options.onPlayAgain) {
          options.onPlayAgain();
        } else {
          // Default clean reset & return to lobby
          if (typeof window !== "undefined") {
            window.location.href = "/";
          }
        }
      });
    }

    return overlay;
  }

  /**
   * Draws territory control curves over time for each player in their faction colors.
   */
  public drawLineGraph(
    canvas: HTMLCanvasElement,
    samples: MatchTelemetrySample[],
    winnerId?: number | string,
  ): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const padLeft = 36;
    const padRight = 16;
    const padTop = 16;
    const padBottom = 26;
    const graphW = w - padLeft - padRight;
    const graphH = h - padTop - padBottom;

    // Faint grid lines (0%, 25%, 50%, 75%, 100%)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let pct = 0; pct <= 100; pct += 25) {
      const y = (padTop + graphH - (pct / 100) * graphH) | 0;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + graphW, y);
      ctx.stroke();
      ctx.fillText(`${pct}%`, padLeft - 6, y);
    }

    if (samples.length < 2) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.textAlign = "center";
      ctx.fillText("Insufficient match timeline data", w / 2, h / 2);
      return;
    }

    const minTime = samples[0].timeSec;
    const maxTime = Math.max(samples[samples.length - 1].timeSec, minTime + 1);
    const timeSpan = maxTime - minTime;

    // Time Axis Labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${Math.round(minTime)}s`, padLeft, padTop + graphH + 6);
    ctx.fillText(`${Math.round(maxTime)}s`, padLeft + graphW, padTop + graphH + 6);

    // Group player trajectories
    const playerSeries = new Map<number | string, Array<{ x: number; y: number; color: string }>>();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!s || !s.players || !Array.isArray(s.players)) continue;
      const normX = (s.timeSec - minTime) / timeSpan;
      const px = padLeft + normX * graphW;

      for (let j = 0; j < s.players.length; j++) {
        const p = s.players[j];
        const normY = Math.min(100, Math.max(0, p.territoryPercent)) / 100;
        const py = padTop + graphH - normY * graphH;

        let series = playerSeries.get(p.playerId);
        if (!series) {
          series = [];
          playerSeries.set(p.playerId, series);
        }
        series.push({ x: px, y: py, color: p.color });
      }
    }

    // Draw each trajectory curve
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const [id, points] of playerSeries.entries()) {
      if (points.length < 2) continue;

      const isWinner = winnerId !== undefined && id === winnerId;
      ctx.strokeStyle = points[0].color || "#94a3b8";
      ctx.lineWidth = isWinner ? 3.0 : 1.75;

      // Filled gradient area beneath the winner's curve
      if (isWinner) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, padTop + graphH);
        for (let i = 0; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.lineTo(points[points.length - 1].x, padTop + graphH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + graphH);
        grad.addColorStop(0, "rgba(59, 130, 246, 0.25)");
        grad.addColorStop(1, "rgba(59, 130, 246, 0.0)");
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      // Stroke curve
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }
  }

  /**
   * Hide the victory modal if currently visible.
   */
  public hideVictoryModal(): void {
    if (this.keydownHandler && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.modalContainer) {
      this.modalContainer.remove();
      this.modalContainer = null;
    }
  }

  /**
   * Checks whether the victory modal is actively open and visible.
   */
  public isModalOpen(): boolean {
    return this.modalContainer !== null;
  }

  /**
   * Cleanly reset state and clear telemetry ring buffer.
   */
  public reset(): void {
    this.ringBuffer.clear();
    this.sampleTimerMs = 0;
    this.matchTimeMs = 0;
    this.cratesSecured.clear();
    this.peakTroops.clear();
    this.peakTerritory.clear();
    this.hideVictoryModal();
  }

  public dispose(): void {
    this.reset();
  }
}
