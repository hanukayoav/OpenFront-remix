import { GameEnv } from "../core/configuration/Config";
import { ClientEnv } from "./ClientEnv";

export interface TurnstileTokenResult {
  token: string;
  createdAt: number;
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string;
          size?: string;
          appearance?: string;
          theme?: string;
        },
      ) => string;
      execute: (
        widgetId: string,
        options: {
          callback: (token: string) => void;
          "error-callback": (errorCode: string) => void;
        },
      ) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export function isTurnstileClientRequired(): boolean {
  return (
    ClientEnv.env() !== GameEnv.Dev && ClientEnv.instanceId() !== "desktop"
  );
}

function hasTurnstileScriptTag(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      'script[src*="turnstile"], script[src*="challenges.cloudflare.com"]',
    ),
  );
}

/**
 * Acquires a single-use Cloudflare Turnstile token in browser contexts.
 * Does not trigger `window.alert()`, allowing callers (UI modals, session
 * provisioning, lobby join) to surface or handle errors cleanly.
 */
export async function requestTurnstileToken(options?: {
  timeoutMs?: number;
}): Promise<TurnstileTokenResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Turnstile verification requires a browser window.");
  }

  if (typeof window.turnstile === "undefined") {
    if (!hasTurnstileScriptTag()) {
      throw new Error("Bot verification unavailable (Turnstile not loaded).");
    }
    const deadline = Date.now() + (options?.timeoutMs ?? 8000);
    while (typeof window.turnstile === "undefined" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const turnstile = window.turnstile;
  if (!turnstile) {
    throw new Error("Failed to load Turnstile script");
  }

  const host = document.getElementById("turnstile-container") ?? document.body;
  const mount = document.createElement("div");
  mount.style.position = "fixed";
  mount.style.left = "-9999px";
  mount.style.top = "-9999px";
  mount.style.width = "0";
  mount.style.height = "0";
  mount.style.overflow = "hidden";
  host.appendChild(mount);

  let widgetId: string;
  try {
    widgetId = turnstile.render(mount, {
      sitekey: ClientEnv.turnstileSiteKey(),
      size: "normal",
      appearance: "interaction-only",
      theme: "light",
    });
  } catch (error) {
    mount.remove();
    throw error instanceof Error ? error : new Error(String(error));
  }

  return await new Promise<TurnstileTokenResult>((resolve, reject) => {
    turnstile.execute(widgetId, {
      callback: (token: string) => {
        try {
          turnstile.remove(widgetId);
        } catch {
          // Ignore cleanup errors if widget was already removed.
        }
        mount.remove();
        resolve({ token, createdAt: Date.now() });
      },
      "error-callback": (errorCode: string) => {
        try {
          turnstile.remove(widgetId);
        } catch {
          // Ignore cleanup errors if widget was already removed.
        }
        mount.remove();
        reject(new Error(`Turnstile failed: ${errorCode}`));
      },
    });
  });
}
