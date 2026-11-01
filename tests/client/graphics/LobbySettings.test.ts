import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MUTATORS,
  getDropIntervalSec,
  getMaxActiveDrops,
  getPaceMultiplier,
  LobbyMutatorsPanel,
  loadMutators,
  MUTATORS_STORAGE_KEY,
  saveMutators,
} from "../../../src/client/components/LobbySettings";

describe("Custom Match Mutator Panel (LobbySettings)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("Mutator Configuration & Persistence", () => {
    it("returns default mutator values when no preference is stored", () => {
      const mutators = loadMutators();
      expect(mutators).toEqual(DEFAULT_MUTATORS);
      expect(mutators.matchPace).toBe(1.0);
      expect(mutators.dropFrequency).toBe("normal");
      expect(mutators.suddenDeathTimer).toBe(0);
    });

    it("saves and loads custom mutators to/from localStorage", () => {
      saveMutators({
        matchPace: 2.0,
        dropFrequency: "extreme",
        suddenDeathTimer: 180,
      });

      const loaded = loadMutators();
      expect(loaded.matchPace).toBe(2.0);
      expect(loaded.dropFrequency).toBe("extreme");
      expect(loaded.suddenDeathTimer).toBe(180);
      expect(localStorage.getItem(MUTATORS_STORAGE_KEY)).not.toBeNull();
    });

    it("sanitizes invalid or corrupted JSON gracefully", () => {
      localStorage.setItem(MUTATORS_STORAGE_KEY, "{ broken json }");
      const loaded = loadMutators();
      expect(loaded).toEqual(DEFAULT_MUTATORS);
    });
  });

  describe("Modifier Calculations & Multipliers", () => {
    it("getPaceMultiplier returns expected multipliers for standard, sprint, and chaos", () => {
      expect(getPaceMultiplier(1.0)).toBe(1.0);
      expect(getPaceMultiplier(1.5)).toBe(1.5);
      expect(getPaceMultiplier(2.0)).toBe(2.0);
    });

    it("getDropIntervalSec returns 45s for normal and 20s for rapid/extreme", () => {
      expect(getDropIntervalSec("normal")).toBe(45);
      expect(getDropIntervalSec("rapid")).toBe(20);
      expect(getDropIntervalSec("extreme")).toBe(20);
    });

    it("getMaxActiveDrops returns 2 for normal/rapid and 3 for extreme", () => {
      expect(getMaxActiveDrops("normal")).toBe(2);
      expect(getMaxActiveDrops("rapid")).toBe(2);
      expect(getMaxActiveDrops("extreme")).toBe(3);
    });
  });

  describe("LobbyMutatorsPanel Component", () => {
    let panel: LobbyMutatorsPanel;

    beforeEach(async () => {
      panel = new LobbyMutatorsPanel();
      document.body.appendChild(panel);
      await panel.updateComplete;
    });

    afterEach(() => {
      panel.remove();
    });

    it("renders collapsible header and expands upon click", async () => {
      const headerBtn = panel.querySelector<HTMLButtonElement>("button");
      expect(headerBtn).not.toBeNull();
      expect(headerBtn?.textContent).toContain("Match Mutators");

      // Click to expand
      headerBtn?.click();
      await panel.updateComplete;

      const body = panel.querySelector(".flex.flex-col.gap-3\\.5");
      expect(body).not.toBeNull();
    });

    it("dispatches mutators-changed event and saves to localStorage when button clicked", async () => {
      // Expand panel
      const headerBtn = panel.querySelector<HTMLButtonElement>("button");
      headerBtn?.click();
      await panel.updateComplete;

      let eventReceived: any = null;
      panel.addEventListener("mutators-changed", (e: any) => {
        eventReceived = e.detail;
      });

      // Find 2x Turbo Chaos button
      const buttons = Array.from(panel.querySelectorAll("button"));
      const turboBtn = buttons.find((b) => b.textContent?.includes("2x Turbo Chaos"));
      expect(turboBtn).not.toBeNull();

      turboBtn?.click();
      await panel.updateComplete;

      expect(panel.getMutators().matchPace).toBe(2.0);
      expect(eventReceived).not.toBeNull();
      expect(eventReceived.matchPace).toBe(2.0);

      const stored = loadMutators();
      expect(stored.matchPace).toBe(2.0);
    });
  });
});
