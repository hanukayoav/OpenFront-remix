// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  consumeTurnstileToken,
  isTurnstileTokenValid,
  requestSingleUseTurnstileToken,
  requestTurnstileToken,
  TURNSTILE_TOKEN_TTL_MS,
  type TurnstileRenderOptions,
} from "../../src/client/Turnstile";

function setupProdBootstrap(): void {
  (
    window as unknown as { BOOTSTRAP_CONFIG?: Record<string, unknown> }
  ).BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 2,
    turnstileSiteKey: "0x4AAAAAAA-test-sitekey",
    jwtAudience: "openfront-2.duckdns.org",
    instanceId: "web-01",
    gitCommit: "test-commit",
  };
  ClientEnv.reset();
}

describe("Cloudflare Turnstile UX, accessibility, cleanup, and single-use guarantees", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete window.turnstile;
    setupProdBootstrap();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete window.turnstile;
    ClientEnv.reset();
  });

  it("renders centered, unclipped, non-zero container even when passive and avoids hidden .in-game parents", async () => {
    const hiddenParent = document.createElement("div");
    hiddenParent.className = "hidden";
    const hiddenContainer = document.createElement("div");
    hiddenContainer.id = "turnstile-container";
    hiddenParent.appendChild(hiddenContainer);
    document.body.appendChild(hiddenParent);

    let capturedMount: HTMLElement | null = null;
    let capturedOptions: TurnstileRenderOptions | null = null;
    const removeSpy = vi.fn();

    window.turnstile = {
      render: (container, options) => {
        capturedMount = container as HTMLElement;
        capturedOptions = options;
        return "w-passive";
      },
      execute: (_id, opts) => {
        // Verify passive state does NOT interrupt normal users with a modal dialog
        const overlay = document.querySelector<HTMLElement>(
          "[data-turnstile-overlay]",
        );
        const dialog = document.querySelector<HTMLElement>(
          "[data-turnstile-dialog]",
        );
        expect(overlay).not.toBeNull();
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.pointerEvents).toBe("none");
        expect(overlay?.style.backgroundColor).toBe("transparent");
        expect(dialog?.getAttribute("aria-modal")).toBeNull();
        expect(capturedMount?.style.minWidth).toBe("300px");
        expect(capturedMount?.style.minHeight).toBe("65px");
        expect(capturedMount?.style.overflow).toBe("visible");
        expect(capturedMount?.style.left).not.toBe("-9999px");
        opts?.callback?.("cf-token-passive-1");
      },
      remove: removeSpy,
    };

    const result = await requestTurnstileToken();
    expect(result.token).toBe("cf-token-passive-1");
    expect(capturedOptions).toMatchObject({
      sitekey: "0x4AAAAAAA-test-sitekey",
      size: "normal",
      appearance: "interaction-only",
      execution: "execute",
    });
    expect(removeSpy).toHaveBeenCalledWith("w-passive");
    expect(document.querySelector("[data-turnstile-overlay]")).toBeNull();
  });

  it("promotes into a responsive accessible dialog on before-interactive-callback and supports keyboard Escape cancel + focus restore", async () => {
    const triggerBtn = document.createElement("button");
    triggerBtn.textContent = "Join Match";
    document.body.appendChild(triggerBtn);
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    const removeSpy = vi.fn();
    const renderedOptionsRef: { current: TurnstileRenderOptions | null } = {
      current: null,
    };
    let resolveExecuted!: () => void;
    const executed = new Promise<void>((resolve) => {
      resolveExecuted = resolve;
    });
    window.turnstile = {
      render: (_container, options) => {
        renderedOptionsRef.current = options;
        return "w-interactive-cancel";
      },
      execute: () => {
        resolveExecuted();
      },
      remove: removeSpy,
    };

    const pending = requestTurnstileToken({ interactiveTimeoutMs: 10_000 });
    await executed;
    renderedOptionsRef.current?.["before-interactive-callback"]?.();

    const overlay = document.querySelector<HTMLElement>(
      "[data-turnstile-overlay]",
    );
    const dialog = document.querySelector<HTMLElement>(
      "[data-turnstile-dialog]",
    );
    expect(overlay?.style.pointerEvents).toBe("auto");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.style.maxWidth).toBe("min(400px, calc(100vw - 16px))");
    expect(dialog?.style.maxHeight).toBe("calc(100dvh - 16px)");
    expect(document.activeElement).toBe(dialog);

    const cancelBtn = dialog?.querySelector("button");
    expect(cancelBtn?.hidden).toBe(false);

    // Keyboard Escape cancels cleanly and restores previous focus
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(removeSpy).toHaveBeenCalledWith("w-interactive-cancel");
    expect(document.querySelector("[data-turnstile-overlay]")).toBeNull();
    expect(document.activeElement).toBe(triggerBtn);
  });

  it("completes interactive flow via before/after-interactive-callback and cleans up properly on expired/timeout/hang", async () => {
    const removeSpy = vi.fn();
    const activeOptionsRef: { current: TurnstileRenderOptions | null } = {
      current: null,
    };
    let resolveInteractiveExecuted!: () => void;
    const interactiveExecuted = new Promise<void>((resolve) => {
      resolveInteractiveExecuted = resolve;
    });
    window.turnstile = {
      render: (_c, opts) => {
        activeOptionsRef.current = opts;
        return "w-interactive-ok";
      },
      execute: () => {
        resolveInteractiveExecuted();
      },
      remove: removeSpy,
    };

    const pOk = requestTurnstileToken();
    await interactiveExecuted;
    activeOptionsRef.current?.["before-interactive-callback"]?.();
    const dialog = document.querySelector<HTMLElement>(
      "[data-turnstile-dialog]",
    );
    expect(dialog?.getAttribute("aria-modal")).toBe("true");

    activeOptionsRef.current?.["after-interactive-callback"]?.();
    expect(dialog?.getAttribute("aria-modal")).toBeNull();

    activeOptionsRef.current?.callback?.("cf-token-interactive-2");
    await expect(pOk).resolves.toMatchObject({
      token: "cf-token-interactive-2",
    });
    expect(removeSpy).toHaveBeenCalledWith("w-interactive-ok");

    // Expired callback & timeout rejection cleanup
    const expiredOptionsRef: { current: TurnstileRenderOptions | null } = {
      current: null,
    };
    let resolveExpiredExecuted!: () => void;
    const expiredExecuted = new Promise<void>((resolve) => {
      resolveExpiredExecuted = resolve;
    });
    window.turnstile = {
      render: (_c, opts) => {
        expiredOptionsRef.current = opts;
        return "w-expired";
      },
      execute: () => {
        resolveExpiredExecuted();
      },
      remove: removeSpy,
    };
    const pExpired = requestTurnstileToken();
    await expiredExecuted;
    expiredOptionsRef.current?.["expired-callback"]?.();
    await expect(pExpired).rejects.toThrow(/expired/i);
    expect(removeSpy).toHaveBeenCalledWith("w-expired");
    expect(document.querySelector("[data-turnstile-overlay]")).toBeNull();

    // Bounded timeout when widget hangs silently
    vi.useFakeTimers();
    let resolveHangExecuted!: () => void;
    const hangExecuted = new Promise<void>((resolve) => {
      resolveHangExecuted = resolve;
    });
    window.turnstile = {
      render: () => "w-hang",
      execute: () => {
        resolveHangExecuted();
      },
      remove: removeSpy,
    };
    const pHang = requestTurnstileToken({ executeTimeoutMs: 500 });
    await hangExecuted;
    const assertion = expect(pHang).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(removeSpy).toHaveBeenCalledWith("w-hang");
    expect(document.querySelector("[data-turnstile-overlay]")).toBeNull();
  });

  it("validates token expiry, enforces single-use consumption, and serializes concurrent requests", async () => {
    const now = Date.now();
    expect(isTurnstileTokenValid(null, now)).toBe(false);
    expect(isTurnstileTokenValid({ token: "   ", createdAt: now }, now)).toBe(
      false,
    );

    const expiredResult = {
      token: "cf-old",
      createdAt: now - TURNSTILE_TOKEN_TTL_MS - 1,
    };
    expect(isTurnstileTokenValid(expiredResult, now)).toBe(false);
    expect(consumeTurnstileToken(expiredResult, now)).toBeNull();

    const freshResult = { token: "cf-once", createdAt: now };
    expect(consumeTurnstileToken(freshResult, now)).toBe("cf-once");
    // Second consumption attempt of same TurnstileTokenResult MUST fail
    expect(isTurnstileTokenValid(freshResult, now)).toBe(false);
    expect(consumeTurnstileToken(freshResult, now)).toBeNull();

    let seq = 0;
    let concurrentActive = 0;
    let maxConcurrent = 0;
    window.turnstile = {
      render: () => `w-${++seq}`,
      execute: (_id, opts) => {
        concurrentActive++;
        maxConcurrent = Math.max(maxConcurrent, concurrentActive);
        const mySeq = seq;
        setTimeout(() => {
          concurrentActive--;
          opts?.callback?.(`cf-serial-${mySeq}`);
        }, 15);
      },
      remove: () => {},
    };

    const [t1, t2] = await Promise.all([
      requestSingleUseTurnstileToken(),
      requestSingleUseTurnstileToken(),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(t1).toBe("cf-serial-1");
    expect(t2).toBe("cf-serial-2");
  });
});
