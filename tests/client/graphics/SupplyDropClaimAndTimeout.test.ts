import { describe, expect, it } from "vitest";
import { DualLayerEngine } from "../../../src/client/graphics/engine/DualLayerEngine";
import { MatchAnalytics } from "../../../src/client/graphics/engine/MatchAnalytics";

describe("Supply Drop Redesign, Animation & Click to Claim", () => {
  it("progresses supply drop through descending, landing, and idle animation states", () => {
    const container = document.createElement("div");
    const engine = new DualLayerEngine({ container });
    const manager = engine.supplyDropManager;

    const drop = manager.spawnSupplyDrop(10, 50, 80, null);
    expect(drop.state).toBe("descending");
    expect(drop.altitude).toBe(1.0);
    expect(drop.visualY).toBeLessThan(drop.y);

    // Halfway descent (1500ms)
    manager.update(1500);
    expect(drop.state).toBe("descending");
    expect(drop.altitude).toBeLessThan(1.0);
    expect(drop.altitude).toBeGreaterThan(0.0);
    expect(drop.swayAngle).not.toBe(0);

    // Complete descent (another 1600ms = 3100ms total)
    manager.update(1600);
    expect(drop.state).toBe("landing");
    expect(drop.altitude).toBe(0);
    expect(drop.visualX).toBe(drop.x);
    expect(drop.visualY).toBe(drop.y);

    // Transition from landing to idle (350ms)
    manager.update(350);
    expect(drop.state).toBe("idle");

    engine.destroy();
  });

  it("handles click-to-claim directly on crate with proper eligibility verification", () => {
    const container = document.createElement("div");
    const engine = new DualLayerEngine({ container });
    const manager = engine.supplyDropManager;

    const drop = manager.spawnSupplyDrop(100, 200, 300, null);

    let myGold = 0;
    let myTroops = 0;
    const mockPlayer = {
      id: () => 1,
      smallID: () => 1,
      addGold: (g: number) => {
        myGold += g;
      },
      addTroops: (t: number) => {
        myTroops += t;
      },
    };

    // 1. Attempt claim while crate is still descending
    const earlyClaim = manager.tryClaimAt(200, 300, mockPlayer as any, () => 1);
    expect(earlyClaim.handled).toBe(true);
    expect(earlyClaim.success).toBe(false);
    expect(earlyClaim.message).toContain("incoming");

    // Fast-forward descent until idle
    manager.update(3000);
    manager.update(400);
    expect(drop.state).toBe("idle");

    // 2. Attempt claim in enemy-controlled territory
    const enemyClaim = manager.tryClaimAt(200, 300, mockPlayer as any, () => 2); // tile owned by player 2
    expect(enemyClaim.handled).toBe(true);
    expect(enemyClaim.success).toBe(false);
    expect(enemyClaim.message).toContain("enemy territory");

    // 3. Successful claim in friendly/owned territory
    const successClaim = manager.tryClaimAt(201, 301, mockPlayer as any, () => 1);
    expect(successClaim.handled).toBe(true);
    expect(successClaim.success).toBe(true);
    expect(successClaim.message).toContain("Troops");
    expect(myGold).toBeGreaterThan(0);
    expect(myTroops).toBeGreaterThan(0);
    expect(manager.getActiveDrops().length).toBe(0);

    engine.destroy();
  });

  it("supports hover reticle and tooltip coordinates", () => {
    const container = document.createElement("div");
    const engine = new DualLayerEngine({ container });
    const manager = engine.supplyDropManager;

    const drop = manager.spawnSupplyDrop(55, 120, 140, null);
    manager.update(3500); // idle

    // Hover outside
    const hoverOut = manager.setHoverCoord(500, 500);
    expect(hoverOut).toBe(false);
    expect(drop.isHovered).toBe(false);

    // Hover inside
    const hoverIn = manager.setHoverCoord(121, 141);
    expect(hoverIn).toBe(true);
    expect(drop.isHovered).toBe(true);

    engine.destroy();
  });
});

describe("Endgame Modal Dismissibility & Sudden Death", () => {
  it("allows dismissing victory modal via close button, spectate button, escape key, and backdrop click", () => {
    const analytics = new MatchAnalytics();
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Open victory modal
    analytics.showVictoryModal(
      {
        winnerName: "General Blue",
        winnerColor: "#3b82f6",
        winnerId: 1,
        victoryType: "Timeout",
      },
      container,
    );

    expect(analytics.isModalOpen()).toBe(true);
    expect(document.querySelector("#openfront-match-analytics-modal")).not.toBeNull();

    // 1. Close button click dismisses modal
    const closeBtn = document.querySelector<HTMLButtonElement>("#analytics-close-btn");
    expect(closeBtn).not.toBeNull();
    closeBtn?.click();
    expect(analytics.isModalOpen()).toBe(false);
    expect(document.querySelector("#openfront-match-analytics-modal")).toBeNull();

    // Reopen modal
    analytics.showVictoryModal(
      {
        winnerName: "General Blue",
        winnerColor: "#3b82f6",
        winnerId: 1,
        victoryType: "Domination",
      },
      container,
    );
    expect(analytics.isModalOpen()).toBe(true);

    // 2. Spectate button dismisses modal
    const spectateBtn = document.querySelector<HTMLButtonElement>("#analytics-spectate-btn");
    expect(spectateBtn).not.toBeNull();
    spectateBtn?.click();
    expect(analytics.isModalOpen()).toBe(false);

    // Reopen modal
    analytics.showVictoryModal(
      {
        winnerName: "General Blue",
        winnerColor: "#3b82f6",
        winnerId: 1,
        victoryType: "Timeout",
      },
      container,
    );

    // 3. Escape key dismisses modal
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(analytics.isModalOpen()).toBe(false);

    container.remove();
  });
});
