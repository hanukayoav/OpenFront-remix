export interface RenderStats {
  webglFrames: number;
  lastWebglDrawTime: number;
  webglIntervals: number[];
  maxIntervalHistory: number;
}

export interface FramePacerOptions {
  getMaxFps: () => number;
  isHidden?: () => boolean;
  now?: () => number;
  onFrame: (deltaMs: number, time: number) => void;
  initialTime?: number;
}

export interface FramePacer {
  tick: (time: number) => boolean;
  stop: () => void;
  isStopped: () => boolean;
  renderStats: RenderStats;
}

/**
 * Deterministic, drift-corrected frame pacer for the WebGL/DualLayer render loop.
 * - Skips rendering when hidden and resets telemetry/accumulator clocks on resume
 *   so background pauses do not spike interval stats or burst-catch frames.
 * - Syncs 1:1 with VSync when maxFps === 0 (default), or paces via remainder-carrying
 *   accumulator with 1.0ms RAF jitter slack when maxFps > 0.
 */
export function createFramePacer(options: FramePacerOptions): FramePacer {
  const nowFn = options.now ?? (() => performance.now());
  const isHiddenFn =
    options.isHidden ??
    (() => typeof document !== "undefined" && document.hidden);

  let stopped = false;
  let wasHidden = false;
  const startTime = options.initialTime ?? nowFn();
  let lastDriveTime = startTime;
  let lastPaceCheckTime = startTime;
  let frameAccumulator = 0;

  const renderStats: RenderStats = {
    webglFrames: 0,
    lastWebglDrawTime: startTime,
    webglIntervals: [],
    maxIntervalHistory: 300,
  };

  const tick = (time: number): boolean => {
    if (stopped) {
      return false;
    }

    if (isHiddenFn()) {
      wasHidden = true;
      return false;
    }

    const now = nowFn();
    if (wasHidden) {
      // Reset clocks on tab resume so background pauses never spike intervals,
      // accumulate stale pacing credit, or distort animation delta.
      wasHidden = false;
      lastPaceCheckTime = time;
      lastDriveTime = time;
      frameAccumulator = 0;
      renderStats.lastWebglDrawTime = now;
    }

    const rawMaxFps = options.getMaxFps();
    const maxFps = Number.isFinite(rawMaxFps) && rawMaxFps > 0 ? rawMaxFps : 0;

    if (maxFps > 0) {
      const targetInterval = 1000 / maxFps;
      const deltaSinceLastCheck = Math.max(
        0,
        Math.min(time - lastPaceCheckTime, 100),
      );
      lastPaceCheckTime = time;
      frameAccumulator += deltaSinceLastCheck;

      // 1.0ms slack prevents browser RAF timer jitter from dropping frames
      if (frameAccumulator < targetInterval - 1.0) {
        return false;
      }

      // Carry forward remainder to prevent cadence aliasing (e.g. 144Hz -> 48fps drop)
      frameAccumulator -= targetInterval;
      if (frameAccumulator > targetInterval) {
        frameAccumulator = 0; // Prevent burst catches after lag spikes
      }
    } else {
      lastPaceCheckTime = time;
      frameAccumulator = 0;
    }

    const deltaMs = Math.max(0, Math.min(time - lastDriveTime, 100));
    lastDriveTime = time;

    const dt = Math.max(0, now - renderStats.lastWebglDrawTime);
    renderStats.lastWebglDrawTime = now;
    renderStats.webglFrames++;
    renderStats.webglIntervals.push(dt);
    if (renderStats.webglIntervals.length > renderStats.maxIntervalHistory) {
      renderStats.webglIntervals.shift();
    }

    options.onFrame(deltaMs, time);
    return true;
  };

  return {
    tick,
    stop: () => {
      stopped = true;
    },
    isStopped: () => stopped,
    renderStats,
  };
}
