import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MatchAnalytics,
  MatchTelemetrySample,
  TelemetryRingBuffer,
} from "../../../src/client/graphics/engine/MatchAnalytics";

describe("MatchAnalytics (Post-Match Telemetry and Stats Modal)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("TelemetryRingBuffer", () => {
    it("enforces fixed circular capacity and FIFO sample eviction", () => {
      const ring = new TelemetryRingBuffer(5);
      expect(ring.capacity).toBe(5);
      expect(ring.size).toBe(0);

      // Add 3 samples
      for (let i = 1; i <= 3; i++) {
        ring.push({ timeSec: i * 5, players: [] });
      }
      expect(ring.size).toBe(3);

      // Add 4 more samples (total 7 > capacity 5)
      for (let i = 4; i <= 7; i++) {
        ring.push({ timeSec: i * 5, players: [] });
      }
      expect(ring.size).toBe(5);

      const samples = ring.getSamples();
      expect(samples.length).toBe(5);
      // Oldest samples 1 & 2 evicted; earliest remaining is sample 3 (timeSec: 15)
      expect(samples[0].timeSec).toBe(15);
      expect(samples[4].timeSec).toBe(35);

      ring.clear();
      expect(ring.size).toBe(0);
      expect(ring.getSamples().length).toBe(0);
    });
  });

  describe("Sampling and Metrics Tracking", () => {
    it("samples simulation metrics into ring buffer at 5-second intervals", () => {
      const analytics = new MatchAnalytics();
      let sampleNumber = 0;

      const mockProvider = (): MatchTelemetrySample => ({
        timeSec: ++sampleNumber * 5,
        players: [
          { playerId: 1, name: "Alice", color: "#3b82f6", territoryPercent: 30, troops: 50000 },
          { playerId: 2, name: "Bob", color: "#ef4444", territoryPercent: 20, troops: 40000 },
        ],
      });

      // Advance by 3000ms (< 5000ms interval) -> no sample taken
      analytics.update(3000, mockProvider);
      expect(analytics.sampleCount).toBe(0);

      // Advance by another 2500ms (total 5500ms >= 5000ms) -> 1 sample recorded
      analytics.update(2500, mockProvider);
      expect(analytics.sampleCount).toBe(1);

      // Advance another 5000ms -> second sample recorded
      analytics.update(5000, mockProvider);
      expect(analytics.sampleCount).toBe(2);

      analytics.dispose();
    });

    it("correctly aggregates match medals for Crates, Troops, and Territory Peak", () => {
      const analytics = new MatchAnalytics();

      // Track crate captures
      analytics.recordCrateSecured(1, "Alice", "#3b82f6");
      analytics.recordCrateSecured(1, "Alice", "#3b82f6");
      analytics.recordCrateSecured(2, "Bob", "#ef4444");

      // Record telemetry snapshots
      analytics.recordSample({
        timeSec: 10,
        players: [
          { playerId: 1, name: "Alice", color: "#3b82f6", territoryPercent: 45.5, troops: 120000 },
          { playerId: 2, name: "Bob", color: "#ef4444", territoryPercent: 54.5, troops: 350000 },
        ],
      });

      analytics.recordSample({
        timeSec: 20,
        players: [
          { playerId: 1, name: "Alice", color: "#3b82f6", territoryPercent: 78.2, troops: 850000 },
          { playerId: 2, name: "Bob", color: "#ef4444", territoryPercent: 21.8, troops: 200000 },
        ],
      });

      const medals = analytics.computeMedals();

      // Most Crates: Alice (2 crates vs Bob 1)
      expect(medals.mostCrates.playerName).toBe("Alice");
      expect(medals.mostCrates.count).toBe(2);

      // Total Troops: Alice (850,000 peak army)
      expect(medals.totalTroops.playerName).toBe("Alice");
      expect(medals.totalTroops.amount).toBe(850000);

      // Highest Territory Peak: Alice (78.2% peak control)
      expect(medals.peakTerritory.playerName).toBe("Alice");
      expect(medals.peakTerritory.percent).toBeCloseTo(78.2, 1);

      analytics.dispose();
    });
  });

  describe("Endgame Glassmorphism Modal & Line Graph", () => {
    it("renders sleek dark glassmorphism modal with victor banner, medals, and line graph", () => {
      const analytics = new MatchAnalytics();

      // Populate telemetry points
      for (let i = 1; i <= 6; i++) {
        analytics.recordSample({
          timeSec: i * 5,
          players: [
            { playerId: 1, name: "General Caesar", color: "#3b82f6", territoryPercent: i * 15, troops: i * 20000 },
            { playerId: 2, name: "Warlord Khan", color: "#ef4444", territoryPercent: 100 - i * 15, troops: 100000 - i * 15000 },
          ],
        });
      }

      let playAgainTriggered = false;
      const modal = analytics.showVictoryModal(
        {
          winnerName: "General Caesar",
          winnerColor: "#3b82f6",
          winnerId: 1,
          victoryType: "Domination",
          onPlayAgain: () => {
            playAgainTriggered = true;
          },
        },
        container,
      );

      expect(modal).not.toBeNull();
      expect(container.contains(modal)).toBe(true);

      // Victor Header Banner verification
      expect(modal.innerHTML).toContain("General Caesar");
      expect(modal.innerHTML).toContain("Domination Victory");

      // Avatar Portrait canvas verification
      const portraitCanvas = modal.querySelector<HTMLCanvasElement>("#analytics-avatar-portrait");
      expect(portraitCanvas).not.toBeNull();

      // Mini Canvas Line Graph verification
      const graphCanvas = modal.querySelector<HTMLCanvasElement>("#analytics-timeline-graph");
      expect(graphCanvas).not.toBeNull();

      // Match Medals section verification
      expect(modal.innerHTML).toContain("Most Crates");
      expect(modal.innerHTML).toContain("Peak Army");
      expect(modal.innerHTML).toContain("Territory Peak");

      // Play Again Button click cleans state and invokes callback
      const playAgainBtn = modal.querySelector<HTMLButtonElement>("#analytics-play-again-btn");
      expect(playAgainBtn).not.toBeNull();
      playAgainBtn?.click();

      expect(playAgainTriggered).toBe(true);
      expect(analytics.sampleCount).toBe(0);
      expect(container.contains(modal)).toBe(false);

      analytics.dispose();
    });

    it("draws multi-player territory control curves on mini canvas without crashing", () => {
      const analytics = new MatchAnalytics();
      const canvas = document.createElement("canvas");
      canvas.width = 560;
      canvas.height = 160;

      const samples: MatchTelemetrySample[] = [
        {
          timeSec: 0,
          players: [
            { playerId: 1, name: "P1", color: "#3b82f6", territoryPercent: 50, troops: 1000 },
            { playerId: 2, name: "P2", color: "#ef4444", territoryPercent: 50, troops: 1000 },
          ],
        },
        {
          timeSec: 30,
          players: [
            { playerId: 1, name: "P1", color: "#3b82f6", territoryPercent: 85, troops: 8000 },
            { playerId: 2, name: "P2", color: "#ef4444", territoryPercent: 15, troops: 500 },
          ],
        },
      ];

      expect(() => {
        analytics.drawLineGraph(canvas, samples, 1);
      }).not.toThrow();

      analytics.dispose();
    });
  });
});
