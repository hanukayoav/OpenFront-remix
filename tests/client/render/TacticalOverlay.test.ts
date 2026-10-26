import { describe, expect, it } from "vitest";
import { TacticalOverlayMode } from "../../../src/client/render/gl/passes/TacticalOverlayPass";
import { EventBus } from "../../../src/core/EventBus";
import {
  CycleTacticalOverlayEvent,
  SetTacticalOverlayModeEvent,
  TacticalOverlayModeChangedEvent,
} from "../../../src/client/InputHandler";
import { ViewModeController } from "../../../src/client/controllers/ViewModeController";

describe("TacticalOverlayMode and ViewModeController", () => {
  it("cycles through all tactical overlay modes sequentially", () => {
    const eventBus = new EventBus();
    let currentMode = TacticalOverlayMode.Off;
    const fakeView: any = {
      setAltView: () => {},
      setGridView: () => {},
      setTacticalOverlayMode: (m: TacticalOverlayMode) => {
        currentMode = m;
      },
      getTacticalOverlayMode: () => currentMode,
    };

    const controller = new ViewModeController(eventBus, fakeView);
    controller.init();

    let emittedMode: number | null = null;
    eventBus.on(TacticalOverlayModeChangedEvent, (e) => {
      emittedMode = e.mode;
    });

    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.Off);

    // Cycle 1 -> TroopDensity
    eventBus.emit(new CycleTacticalOverlayEvent());
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.TroopDensity);
    expect(emittedMode).toBe(TacticalOverlayMode.TroopDensity);

    // Cycle 2 -> SAMCoverage
    eventBus.emit(new CycleTacticalOverlayEvent());
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.SAMCoverage);
    expect(emittedMode).toBe(TacticalOverlayMode.SAMCoverage);

    // Cycle 3 -> TradeEfficiency
    eventBus.emit(new CycleTacticalOverlayEvent());
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.TradeEfficiency);
    expect(emittedMode).toBe(TacticalOverlayMode.TradeEfficiency);

    // Cycle 4 -> NavalThreat
    eventBus.emit(new CycleTacticalOverlayEvent());
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.NavalThreat);
    expect(emittedMode).toBe(TacticalOverlayMode.NavalThreat);

    // Cycle 5 -> Wraps back to Off
    eventBus.emit(new CycleTacticalOverlayEvent());
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.Off);
    expect(emittedMode).toBe(TacticalOverlayMode.Off);
  });

  it("sets tactical overlay mode directly via SetTacticalOverlayModeEvent", () => {
    const eventBus = new EventBus();
    let currentMode = TacticalOverlayMode.Off;
    const fakeView: any = {
      setAltView: () => {},
      setGridView: () => {},
      setTacticalOverlayMode: (m: TacticalOverlayMode) => {
        currentMode = m;
      },
      getTacticalOverlayMode: () => currentMode,
    };

    const controller = new ViewModeController(eventBus, fakeView);
    controller.init();

    eventBus.emit(new SetTacticalOverlayModeEvent(TacticalOverlayMode.SAMCoverage));
    expect(fakeView.getTacticalOverlayMode()).toBe(TacticalOverlayMode.SAMCoverage);
  });
});
