import { describe, expect, test } from "vitest";
import { createFramePacer } from "../../src/client/FramePacer";
import { MAX_FPS_KEY, UserSettings } from "../../src/core/game/UserSettings";

function simulateDisplay(options: {
  displayHz: number;
  maxFps: number;
  durationMs: number;
  jitterPatternMs?: number[];
}): { renderedFrames: number; deltas: number[]; intervals: number[] } {
  const stepMs = 1000 / options.displayHz;
  let currentNow = 0;
  const deltas: number[] = [];

  const pacer = createFramePacer({
    getMaxFps: () => options.maxFps,
    isHidden: () => false,
    now: () => currentNow,
    initialTime: 0,
    onFrame: (deltaMs) => {
      deltas.push(deltaMs);
    },
  });

  const totalTicks = Math.round(options.durationMs / stepMs);
  for (let i = 1; i <= totalTicks; i++) {
    const jitter =
      options.jitterPatternMs && options.jitterPatternMs.length > 0
        ? options.jitterPatternMs[i % options.jitterPatternMs.length]
        : 0;
    const t = i * stepMs + jitter;
    currentNow = t;
    pacer.tick(t);
  }

  return {
    renderedFrames: pacer.renderStats.webglFrames,
    deltas,
    intervals: pacer.renderStats.webglIntervals,
  };
}

describe("createFramePacer — multi-refresh-rate & custom FPS cap verification", () => {
  test.each([60, 90, 120, 144, 165])(
    "uncapped (maxFps = 0) renders 1:1 with VSync on %iHz display over 2s",
    (hz) => {
      const result = simulateDisplay({
        displayHz: hz,
        maxFps: 0,
        durationMs: 2000,
      });

      const expectedFrames = Math.round(2 * hz);
      expect(result.renderedFrames).toBe(expectedFrames);
      const expectedStep = 1000 / hz;
      for (const dt of result.deltas) {
        expect(dt).toBeCloseTo(expectedStep, 2);
      }
    },
  );

  test("60Hz cap with up to -0.8ms RAF early jitter does not skip frames", () => {
    const result = simulateDisplay({
      displayHz: 60,
      maxFps: 60,
      durationMs: 2000,
      jitterPatternMs: [0, -0.8, 0.4, -0.5, 0.2],
    });
    expect(result.renderedFrames).toBeGreaterThanOrEqual(119);
    expect(result.renderedFrames).toBeLessThanOrEqual(121);
  });

  test("60fps cap on 144Hz avoids integer-divisor 48fps aliasing via remainder carry", () => {
    const result = simulateDisplay({
      displayHz: 144,
      maxFps: 60,
      durationMs: 5000,
    });
    const avgFps = result.renderedFrames / 5;
    expect(avgFps).toBeGreaterThanOrEqual(59);
    expect(avgFps).toBeLessThanOrEqual(61);
  });

  test("custom caps (30, 90, 120) pace accurately on higher-refresh displays", () => {
    const cap30On60 = simulateDisplay({
      displayHz: 60,
      maxFps: 30,
      durationMs: 4000,
    });
    expect(cap30On60.renderedFrames / 4).toBeCloseTo(30, 0);

    const cap90On144 = simulateDisplay({
      displayHz: 144,
      maxFps: 90,
      durationMs: 4000,
    });
    expect(cap90On144.renderedFrames / 4).toBeGreaterThanOrEqual(89);
    expect(cap90On144.renderedFrames / 4).toBeLessThanOrEqual(91);

    const cap120On165 = simulateDisplay({
      displayHz: 165,
      maxFps: 120,
      durationMs: 4000,
    });
    expect(cap120On165.renderedFrames / 4).toBeGreaterThanOrEqual(119);
    expect(cap120On165.renderedFrames / 4).toBeLessThanOrEqual(121);
  });

  test("lag spike clamps deltaMs to 100ms and clears burst accumulator credit", () => {
    let now = 0;
    const frames: number[] = [];
    const pacer = createFramePacer({
      getMaxFps: () => 60,
      isHidden: () => false,
      now: () => now,
      initialTime: 0,
      onFrame: (deltaMs) => frames.push(deltaMs),
    });

    // Normal frame at 16.7ms
    now = 16.7;
    expect(pacer.tick(16.7)).toBe(true);

    // 400ms stall on next tick -> single clamped catchup frame, no burst on subsequent small steps
    now = 416.7;
    expect(pacer.tick(416.7)).toBe(true);
    expect(frames[1]).toBe(100);

    // Subsequent 5ms tick (< 16.67ms target) must NOT render a burst frame
    now = 421.7;
    expect(pacer.tick(421.7)).toBe(false);
  });

  test("document.hidden suppresses rendering and resets telemetry clocks on resume", () => {
    let hidden = false;
    let now = 0;
    const deltas: number[] = [];

    const pacer = createFramePacer({
      getMaxFps: () => 60,
      isHidden: () => hidden,
      now: () => now,
      initialTime: 0,
      onFrame: (dt) => deltas.push(dt),
    });

    now = 16.7;
    expect(pacer.tick(16.7)).toBe(true);

    // Switch tab to hidden for 30 seconds
    hidden = true;
    for (let t = 33.4; t <= 30000; t += 1000) {
      now = t;
      expect(pacer.tick(t)).toBe(false);
    }
    expect(deltas).toHaveLength(1);

    // Resume visible -> first tick resets clocks (no 30,000ms interval spike in renderStats)
    hidden = false;
    now = 30016.7;
    pacer.tick(30016.7);
    now = 30033.4;
    expect(pacer.tick(30033.4)).toBe(true);
    expect(Math.max(...pacer.renderStats.webglIntervals)).toBeLessThanOrEqual(
      50,
    );
  });

  test("stop() permanently halts frame execution", () => {
    let count = 0;
    let now = 0;
    const pacer = createFramePacer({
      getMaxFps: () => 0,
      isHidden: () => false,
      now: () => now,
      initialTime: 0,
      onFrame: () => {
        count++;
      },
    });

    now = 16.7;
    expect(pacer.tick(16.7)).toBe(true);
    pacer.stop();
    expect(pacer.isStopped()).toBe(true);
    now = 33.4;
    expect(pacer.tick(33.4)).toBe(false);
    expect(count).toBe(1);
  });

  test("renderStats caps webglIntervals history at maxIntervalHistory (300)", () => {
    const result = simulateDisplay({
      displayHz: 144,
      maxFps: 0,
      durationMs: 3000,
    });
    expect(result.renderedFrames).toBe(432);
    expect(result.intervals).toHaveLength(300);
  });

  test("UserSettings.maxFps defaults to 0 and sanitizes invalid values", () => {
    const store = new Map<string, string>();
    const prevStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });

    try {
      const settings = new UserSettings();
      expect(settings.maxFps()).toBe(0);

      settings.setMaxFps(144);
      expect(settings.maxFps()).toBe(144);
      expect(store.get(MAX_FPS_KEY)).toBe("144");

      settings.setMaxFps(-20);
      expect(settings.maxFps()).toBe(0);

      settings.setMaxFps(Number.NaN);
      expect(settings.maxFps()).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: prevStorage,
      });
    }
  });
});
