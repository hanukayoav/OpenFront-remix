import { GameEnv } from "../core/configuration/Config";
import { ClientEnv } from "./ClientEnv";

export const TURNSTILE_TOKEN_TTL_MS = 3 * 60 * 1000;
export const TURNSTILE_SCRIPT_TIMEOUT_MS = 8_000;
export const TURNSTILE_EXECUTE_TIMEOUT_MS = 20_000;
export const TURNSTILE_INTERACTIVE_TIMEOUT_MS = 60_000;

export interface TurnstileTokenResult {
  token: string;
  createdAt: number;
}

export interface TurnstileRenderOptions {
  sitekey: string;
  size?: "normal" | "flexible" | "compact" | "invisible";
  appearance?: "always" | "execute" | "interaction-only";
  execution?: "render" | "execute";
  theme?: "light" | "dark" | "auto";
  callback?: (token: string) => void;
  "error-callback"?: (errorCode?: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "unsupported-callback"?: () => void;
  "before-interactive-callback"?: () => void;
  "after-interactive-callback"?: () => void;
}

export interface TurnstileExecuteOptions {
  callback: (token: string) => void;
  "error-callback"?: (errorCode?: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "unsupported-callback"?: () => void;
  "before-interactive-callback"?: () => void;
  "after-interactive-callback"?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: TurnstileRenderOptions,
      ) => string;
      execute: (
        widgetId: string | HTMLElement,
        options: TurnstileExecuteOptions,
      ) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const consumedResults = new WeakSet<TurnstileTokenResult>();
let executionQueue: Promise<void> = Promise.resolve();

export function isTurnstileClientRequired(): boolean {
  return (
    ClientEnv.env() !== GameEnv.Dev && ClientEnv.instanceId() !== "desktop"
  );
}

/**
 * Checks whether a Turnstile token result is non-empty, unconsumed, and within
 * its client-side freshness window before single-use server submission.
 */
export function isTurnstileTokenValid(
  result: TurnstileTokenResult | null | undefined,
  now = Date.now(),
  ttlMs = TURNSTILE_TOKEN_TTL_MS,
): boolean {
  if (!result || typeof result.token !== "string") {
    return false;
  }
  if (result.token.trim().length === 0) {
    return false;
  }
  if (!Number.isFinite(result.createdAt) || consumedResults.has(result)) {
    return false;
  }
  return now < result.createdAt + ttlMs && now >= result.createdAt - 5_000;
}

/**
 * Validates and marks a Turnstile token result as consumed on the client so a
 * prefetched or temporary token cannot accidentally be re-submitted twice.
 */
export function consumeTurnstileToken(
  result: TurnstileTokenResult | null | undefined,
  now = Date.now(),
  ttlMs = TURNSTILE_TOKEN_TTL_MS,
): string | null {
  if (!isTurnstileTokenValid(result, now, ttlMs) || !result) {
    return null;
  }
  consumedResults.add(result);
  return result.token;
}

function hasTurnstileScriptTag(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      'script[src*="turnstile"], script[src*="challenges.cloudflare.com"]',
    ),
  );
}

function isElementHidden(el: HTMLElement): boolean {
  if (el.closest(".hidden, [hidden]")) {
    return true;
  }
  if (typeof getComputedStyle === "function") {
    let curr: HTMLElement | null = el;
    while (curr) {
      if (getComputedStyle(curr).display === "none") {
        return true;
      }
      curr = curr.parentElement;
    }
  }
  return false;
}

function resolveTurnstileHost(): HTMLElement {
  const container = document.getElementById("turnstile-container");
  if (container && !isElementHidden(container)) {
    return container;
  }
  return document.body;
}

export interface RequestTurnstileTokenOptions {
  timeoutMs?: number;
  executeTimeoutMs?: number;
  interactiveTimeoutMs?: number;
}

/**
 * Acquires a single-use Cloudflare Turnstile token in browser contexts.
 * Renders cleanly centered inside the viewport (never zero-sized or clipped)
 * so passive users face zero interruption while interactive challenges promote
 * into a responsive, keyboard-accessible dialog on desktop and mobile.
 */
export async function requestTurnstileToken(
  options?: RequestTurnstileTokenOptions,
): Promise<TurnstileTokenResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Turnstile verification requires a browser window.");
  }

  const run = async (): Promise<TurnstileTokenResult> => {
    const scriptTimeoutMs = options?.timeoutMs ?? TURNSTILE_SCRIPT_TIMEOUT_MS;
    const executeTimeoutMs =
      options?.executeTimeoutMs ?? TURNSTILE_EXECUTE_TIMEOUT_MS;
    const interactiveTimeoutMs =
      options?.interactiveTimeoutMs ?? TURNSTILE_INTERACTIVE_TIMEOUT_MS;

    if (typeof window.turnstile === "undefined") {
      if (!hasTurnstileScriptTag()) {
        throw new Error("Bot verification unavailable (Turnstile not loaded).");
      }
      const deadline = Date.now() + scriptTimeoutMs;
      while (typeof window.turnstile === "undefined" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const turnstile = window.turnstile;
    if (!turnstile) {
      throw new Error("Failed to load Turnstile script");
    }

    const host = resolveTurnstileHost();

    const overlay = document.createElement("div");
    overlay.setAttribute("data-turnstile-overlay", "true");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.padding = "8px";
    overlay.style.boxSizing = "border-box";
    overlay.style.zIndex = "2147483000";
    overlay.style.backgroundColor = "transparent";
    overlay.style.pointerEvents = "none";

    const dialog = document.createElement("div");
    dialog.setAttribute("data-turnstile-dialog", "true");
    dialog.style.maxWidth = "min(400px, calc(100vw - 16px))";
    dialog.style.maxHeight = "calc(100dvh - 16px)";
    dialog.style.boxSizing = "border-box";
    dialog.style.overflow = "visible";
    dialog.style.display = "flex";
    dialog.style.flexDirection = "column";
    dialog.style.alignItems = "center";
    dialog.style.outline = "none";

    const titleId = `turnstile-title-${Math.random().toString(36).slice(2, 9)}`;
    const descId = `turnstile-desc-${Math.random().toString(36).slice(2, 9)}`;

    const heading = document.createElement("h2");
    heading.id = titleId;
    heading.textContent = "Security Verification";
    heading.hidden = true;
    heading.style.margin = "0";
    heading.style.fontSize = "16px";
    heading.style.fontWeight = "600";
    heading.style.color = "#f8fafc";
    heading.style.textAlign = "center";

    const description = document.createElement("p");
    description.id = descId;
    description.textContent =
      "Please complete the quick security check below to continue.";
    description.hidden = true;
    description.style.margin = "0";
    description.style.fontSize = "13px";
    description.style.lineHeight = "1.4";
    description.style.color = "#cbd5e1";
    description.style.textAlign = "center";

    const mount = document.createElement("div");
    mount.setAttribute("data-turnstile-mount", "true");
    mount.style.minWidth = "300px";
    mount.style.minHeight = "65px";
    mount.style.maxWidth = "100%";
    mount.style.display = "flex";
    mount.style.alignItems = "center";
    mount.style.justifyContent = "center";
    mount.style.overflow = "visible";
    mount.style.pointerEvents = "auto";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.hidden = true;
    cancelBtn.style.minHeight = "40px";
    cancelBtn.style.minWidth = "96px";
    cancelBtn.style.padding = "8px 16px";
    cancelBtn.style.borderRadius = "8px";
    cancelBtn.style.border = "1px solid rgba(148, 163, 184, 0.45)";
    cancelBtn.style.backgroundColor = "rgba(30, 41, 59, 0.9)";
    cancelBtn.style.color = "#f8fafc";
    cancelBtn.style.fontSize = "13px";
    cancelBtn.style.fontWeight = "500";
    cancelBtn.style.cursor = "pointer";

    dialog.append(heading, description, mount, cancelBtn);
    overlay.appendChild(dialog);
    host.appendChild(overlay);

    return await new Promise<TurnstileTokenResult>((resolve, reject) => {
      let widgetId: string | null = null;
      let settled = false;
      let interactiveActive = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      const setInteractiveUi = (visible: boolean): void => {
        interactiveActive = visible;
        if (visible) {
          overlay.style.backgroundColor = "rgba(15, 23, 42, 0.72)";
          overlay.style.pointerEvents = "auto";
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-modal", "true");
          dialog.setAttribute("aria-labelledby", titleId);
          dialog.setAttribute("aria-describedby", descId);
          dialog.tabIndex = -1;
          dialog.style.backgroundColor = "#0f172a";
          dialog.style.border = "1px solid rgba(148, 163, 184, 0.35)";
          dialog.style.borderRadius = "12px";
          dialog.style.padding = "16px";
          dialog.style.gap = "12px";
          dialog.style.overflowY = "auto";
          dialog.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.55)";
          heading.hidden = false;
          description.hidden = false;
          cancelBtn.hidden = false;
          if (!dialog.contains(document.activeElement)) {
            dialog.focus();
          }
        } else {
          overlay.style.backgroundColor = "transparent";
          overlay.style.pointerEvents = "none";
          dialog.removeAttribute("role");
          dialog.removeAttribute("aria-modal");
          dialog.removeAttribute("aria-labelledby");
          dialog.removeAttribute("aria-describedby");
          dialog.removeAttribute("tabindex");
          dialog.style.backgroundColor = "transparent";
          dialog.style.border = "";
          dialog.style.borderRadius = "";
          dialog.style.padding = "";
          dialog.style.gap = "";
          dialog.style.overflowY = "visible";
          dialog.style.boxShadow = "";
          heading.hidden = true;
          description.hidden = true;
          cancelBtn.hidden = true;
        }
      };

      const cleanup = (): void => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        document.removeEventListener("keydown", onKeyDown);
        cancelBtn.removeEventListener("click", onCancelClick);
        if (widgetId !== null) {
          try {
            turnstile.remove(widgetId);
          } catch {
            // Ignore cleanup errors if widget was already removed.
          }
          widgetId = null;
        }
        overlay.remove();
        if (
          interactiveActive &&
          previousFocus &&
          previousFocus.isConnected &&
          typeof previousFocus.focus === "function"
        ) {
          try {
            previousFocus.focus();
          } catch {
            // Ignore focus restoration errors.
          }
        }
        interactiveActive = false;
      };

      const settleResolve = (token: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (typeof token !== "string" || token.trim().length === 0) {
          reject(new Error("Turnstile returned an empty token."));
          return;
        }
        resolve({ token, createdAt: Date.now() });
      };

      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const armTimeout = (ms: number, message: string): void => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        timeoutHandle = setTimeout(() => {
          settleReject(new Error(message));
        }, ms);
      };

      const onCancelClick = (): void => {
        settleReject(new Error("Turnstile verification cancelled."));
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (!interactiveActive) return;
        if (event.key === "Escape") {
          event.preventDefault();
          settleReject(new Error("Turnstile verification cancelled."));
          return;
        }
        if (event.key === "Tab") {
          const focusables = [
            ...Array.from(
              dialog.querySelectorAll<HTMLElement>(
                'iframe, button:not([hidden]):not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ),
          ];
          if (focusables.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (!dialog.contains(active)) {
            event.preventDefault();
            first.focus();
          } else if (
            event.shiftKey &&
            (active === first || active === dialog)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      cancelBtn.addEventListener("click", onCancelClick);
      document.addEventListener("keydown", onKeyDown);

      const lifecycleCallbacks: TurnstileExecuteOptions = {
        callback: (token: string) => {
          settleResolve(token);
        },
        "error-callback": (errorCode?: string) => {
          settleReject(
            new Error(`Turnstile failed: ${errorCode ?? "unknown"}`),
          );
        },
        "expired-callback": () => {
          settleReject(new Error("Turnstile token expired before submission."));
        },
        "timeout-callback": () => {
          settleReject(new Error("Turnstile interactive challenge timed out."));
        },
        "unsupported-callback": () => {
          settleReject(new Error("Turnstile is unsupported in this browser."));
        },
        "before-interactive-callback": () => {
          if (settled) return;
          setInteractiveUi(true);
          armTimeout(
            interactiveTimeoutMs,
            "Turnstile interactive challenge timed out.",
          );
        },
        "after-interactive-callback": () => {
          if (settled) return;
          setInteractiveUi(false);
        },
      };

      armTimeout(executeTimeoutMs, "Turnstile verification timed out.");

      try {
        widgetId = turnstile.render(mount, {
          sitekey: ClientEnv.turnstileSiteKey(),
          size: "normal",
          appearance: "interaction-only",
          execution: "execute",
          theme: "dark",
          ...lifecycleCallbacks,
        });
        turnstile.execute(widgetId, lifecycleCallbacks);
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const resultPromise = executionQueue.then(run, run);
  executionQueue = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}

/**
 * Acquires, validates freshness, and marks a Turnstile token as consumed for
 * immediate single-use API submission.
 */
export async function requestSingleUseTurnstileToken(
  options?: RequestTurnstileTokenOptions,
): Promise<string> {
  const result = await requestTurnstileToken(options);
  const validToken = consumeTurnstileToken(result);
  if (!validToken) {
    throw new Error("Turnstile token expired or already used.");
  }
  return validToken;
}
