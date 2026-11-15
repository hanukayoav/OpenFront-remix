export interface TurnstileVerificationResult {
  ok: boolean;
  reason?: string;
}

export type TurnstileVerifyFn = (args: {
  token: string;
  ip: string | null;
}) => Promise<TurnstileVerificationResult>;

export interface TurnstileVerifierOptions {
  /** Cloudflare Turnstile secret key (TURNSTILE_SECRET_KEY). */
  secretKey?: string;
  /** Only allow missing secret bypass in explicit GameEnv.Dev environments. */
  allowDevBypass?: boolean;
  /** Optional Cloudflare siteverify endpoint override (for tests). */
  siteverifyUrl?: string;
  /** Timeout for siteverify HTTP calls in ms. */
  timeoutMs?: number;
}

interface CloudflareSiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

export function createTurnstileVerifier(
  options: TurnstileVerifierOptions,
): TurnstileVerifyFn {
  const secretKey = options.secretKey?.trim();
  const siteverifyUrl =
    options.siteverifyUrl ??
    "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const timeoutMs = options.timeoutMs ?? 5000;

  return async ({ token, ip }) => {
    const trimmed = token.trim();
    if (!trimmed) {
      return { ok: false, reason: "turnstile_token_missing" };
    }

    if (!secretKey) {
      if (options.allowDevBypass) {
        return { ok: true };
      }
      return { ok: false, reason: "turnstile_not_configured" };
    }

    try {
      const form = new URLSearchParams();
      form.set("secret", secretKey);
      form.set("response", trimmed);
      if (ip) {
        form.set("remoteip", ip);
      }

      const response = await fetch(siteverifyUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return { ok: false, reason: `turnstile_http_${response.status}` };
      }

      const data = (await response.json()) as CloudflareSiteverifyResponse;
      if (data.success === true) {
        return { ok: true };
      }
      const codes = Array.isArray(data["error-codes"])
        ? data["error-codes"].join(",")
        : "turnstile_rejected";
      return { ok: false, reason: codes || "turnstile_rejected" };
    } catch (error) {
      return {
        ok: false,
        reason: `turnstile_error:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
