export interface AdmiralMeasureResult {
  /** True when the visitor has an adblocker active. */
  adblocking?: boolean;
  /**
   * Admiral's OWN ad-free pass (its paywall), NOT our tier. Intentionally
   * ignored: OpenFront ad-free is the server `adfree` flag (any shop purchase →
   * ad-free for life), which already zeroes `window.adsEnabled` so Admiral
   * never loads for those users. Only wire this if we ever sell via Admiral.
   */
  subscribed?: boolean;
  /** True when the visitor has whitelisted this site in their blocker (ads render). */
  whitelisted?: boolean;
}

type AdmiralFn = {
  (
    hook: "after",
    event: "measure.detected",
    cb: (res: AdmiralMeasureResult) => void,
  ): void;
  q?: unknown[];
  v?: number;
  s?: string;
};

interface GoogleTag {
  cmd: Array<() => void>;
  pubads?: () => { setTargeting: (key: string, value: string) => void };
}

declare global {
  interface Window {
    admiral?: AdmiralFn;
    googletag?: GoogleTag;
  }
}

/**
 * Injects the Admiral tag. Call for FREE (ad-eligible) users ONLY — gating
 * happens at the single call site so paid users never load Admiral at all
 * (its adblock popup fires autonomously once the payload runs).
 */
export function loadAdmiral(): void {
  // No-op: ads are permanently disabled.
}

export function onAdmiralMeasured(
  _cb: (res: AdmiralMeasureResult) => void,
): void {
  // No-op
}

