import { EventBus } from "../../core/EventBus";
import { Controller } from "../Controller";
import {
  AlternateViewEvent,
  CycleTacticalOverlayEvent,
  SetTacticalOverlayModeEvent,
  TacticalOverlayModeChangedEvent,
  ToggleCoordinateGridEvent,
} from "../InputHandler";
import { MapRenderer } from "../render/gl";
import { TacticalOverlayMode } from "../render/gl/passes/TacticalOverlayPass";

export class ViewModeController implements Controller {
  constructor(
    private eventBus: EventBus,
    private view: MapRenderer,
  ) {}

  init() {
    this.eventBus.on(AlternateViewEvent, (e) =>
      this.view.setAltView(e.alternateView),
    );
    this.eventBus.on(ToggleCoordinateGridEvent, (e) =>
      this.view.setGridView(e.enabled),
    );
    this.eventBus.on(SetTacticalOverlayModeEvent, (e) => {
      this.view.setTacticalOverlayMode(e.mode);
      this.eventBus.emit(new TacticalOverlayModeChangedEvent(e.mode));
    });
    this.eventBus.on(CycleTacticalOverlayEvent, () => {
      const current = this.view.getTacticalOverlayMode();
      // Cycle: Off(0) -> TroopDensity(1) -> SAMCoverage(2) -> TradeEfficiency(3) -> NavalThreat(4) -> Off(0)
      const next = (current + 1) % (TacticalOverlayMode.NavalThreat + 1);
      this.view.setTacticalOverlayMode(next);
      this.eventBus.emit(new TacticalOverlayModeChangedEvent(next));
    });
  }
}

