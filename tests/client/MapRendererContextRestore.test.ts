import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MapRenderer,
  TacticalOverlayMode,
} from "../../src/client/render/gl/MapRenderer";
import type { RenderSettings } from "../../src/client/render/gl/RenderSettings";
import type { RendererConfig } from "../../src/client/render/types";
import type { Config } from "../../src/core/configuration/Config";

const mockInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

vi.mock("../../src/client/render/gl/Renderer", () => ({
  GPURenderer: class MockGPURenderer {
    glLimited = null;
    resize = vi.fn();
    setCameraState = vi.fn();
    setMapLayers = vi.fn();
    setLayerVisible = vi.fn();
    setLayerDestroyedMask = vi.fn();
    setLocalPlayerID = vi.fn();
    setLocalRailColor = vi.fn();
    setAltView = vi.fn();
    setGridView = vi.fn();
    setShowPatterns = vi.fn();
    setHighlightOwner = vi.fn();
    setTacticalOverlayMode = vi.fn();
    getTacticalOverlayMode = vi.fn(() => TacticalOverlayMode.Off);
    setHighlightStructureTypes = vi.fn();
    getSettings = vi.fn(() => ({}) as RenderSettings);
    dispose = vi.fn();

    constructor() {
      mockInstances.push(
        this as unknown as Record<string, ReturnType<typeof vi.fn>>,
      );
    }
  },
}));

describe("MapRenderer WebGL context restore regression", () => {
  afterEach(() => {
    mockInstances.length = 0;
    vi.unstubAllGlobals();
  });

  it("re-applies view toggles, tactical mode, and player state after webglcontextrestored", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );

    const canvas = document.createElement("canvas");
    const renderer = new MapRenderer(
      canvas,
      {} as RendererConfig,
      () => new Uint8Array(0),
      new Float32Array(0),
      {} as Config,
      {} as RenderSettings,
    );

    expect(mockInstances).toHaveLength(1);
    const first = mockInstances[0];

    renderer.setLocalPlayerID(42);
    renderer.setLocalRailColor(0.2, 0.4, 0.8);
    renderer.setAltView(true);
    renderer.setGridView(true);
    renderer.setShowPatterns(false);
    renderer.setHighlightOwner(7);
    renderer.setTacticalOverlayMode(TacticalOverlayMode.SAMCoverage);
    renderer.setHighlightStructureTypes(["City"]);

    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(first.dispose).toHaveBeenCalledTimes(1);

    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(mockInstances).toHaveLength(2);
    const restored = mockInstances[1];

    expect(restored.setLocalPlayerID).toHaveBeenCalledWith(42);
    expect(restored.setLocalRailColor).toHaveBeenCalledWith(0.2, 0.4, 0.8);
    expect(restored.setAltView).toHaveBeenCalledWith(true);
    expect(restored.setGridView).toHaveBeenCalledWith(true);
    expect(restored.setShowPatterns).toHaveBeenCalledWith(false);
    expect(restored.setHighlightOwner).toHaveBeenCalledWith(7);
    expect(restored.setTacticalOverlayMode).toHaveBeenCalledWith(
      TacticalOverlayMode.SAMCoverage,
    );
    expect(restored.setHighlightStructureTypes).toHaveBeenCalledWith(["City"]);

    renderer.dispose();
  });
});
