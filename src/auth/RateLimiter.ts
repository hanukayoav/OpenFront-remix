import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import net from "net";

export interface SlidingWindowLimiterOptions {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys?: number;
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxTrackedKeys: number;

  constructor(options: SlidingWindowLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 20_000;
  }

  consume(
    key: string,
    now = Date.now(),
  ): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const cutoff = now - this.windowMs;
    const existing = this.buckets.get(key) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      this.buckets.set(key, active);
      const oldest = active[0] ?? now;
      const retryAfterMs = Math.max(1000, oldest + this.windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    active.push(now);
    if (!this.buckets.has(key) && this.buckets.size >= this.maxTrackedKeys) {
      this.prune(cutoff);
      if (this.buckets.size >= this.maxTrackedKeys) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey !== undefined) {
          this.buckets.delete(firstKey);
        }
      }
    }
    this.buckets.set(key, active);

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  }

  private prune(cutoff: number): void {
    for (const [k, timestamps] of this.buckets.entries()) {
      const remaining = timestamps.filter((ts) => ts > cutoff);
      if (remaining.length === 0) {
        this.buckets.delete(k);
      } else {
        this.buckets.set(k, remaining);
      }
    }
  }
}

export interface ClientIpOptions {
  /**
   * Set ONLY when direct connections from the upstream reverse proxy are
   * cryptographically or network-restricted to Cloudflare IPs and Nginx strips
   * untrusted client CF-Connecting-IP headers.
   */
  trustCloudflareHeader?: boolean;
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

function isLoopbackIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

/**
 * Extracts the client IP strictly respecting Express's configured `trust proxy`
 * boundary (`req.ip`). Spoofable `X-Forwarded-For` leftmost entries and
 * untrusted `CF-Connecting-IP` headers are ignored by default.
 */
export function getClientIp(req: Request, options?: ClientIpOptions): string {
  const peerIp = normalizeIp(req.socket?.remoteAddress ?? "");
  if (options?.trustCloudflareHeader && peerIp && isLoopbackIp(peerIp)) {
    const cfIp = req.header("cf-connecting-ip")?.trim();
    if (cfIp && net.isIP(normalizeIp(cfIp)) !== 0) {
      return normalizeIp(cfIp);
    }
  }

  const resolved = normalizeIp(req.ip ?? peerIp);
  return resolved.length > 0 ? resolved : "unknown";
}

export function createIpRateLimitMiddleware(
  limiter: SlidingWindowLimiter,
  label: string,
  options?: ClientIpOptions,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${label}:${getClientIp(req, options)}`;
    const result = limiter.consume(key);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({
        error: "rate_limit_exceeded",
        message: "Too many requests, please try again shortly.",
      });
      return;
    }
    next();
  };
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export interface CookieCsrfOptions {
  /**
   * When true (default), requests carrying cookies with neither Origin,
   * Referer, nor an explicit `Sec-Fetch-Site: same-origin` / `none` header are
   * rejected.
   */
  requireOriginWhenCookiePresent?: boolean;
}

/**
 * Checks whether a cookie-authenticated POST/DELETE/PUT request passes
 * CSRF Origin/Referer/Sec-Fetch-Site validation against the configured allowed origins.
 */
export function isAllowedCookieCsrfRequest(
  req: Request,
  allowedOrigins: Set<string>,
  options?: CookieCsrfOptions,
): boolean {
  const fetchSite = req.header("sec-fetch-site")?.trim().toLowerCase();
  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    return false;
  }

  const origin = req.header("origin");
  if (origin !== undefined) {
    return isOriginAllowed(origin.trim(), allowedOrigins);
  }

  const referer = req.header("referer");
  if (referer !== undefined) {
    try {
      const refOrigin = new URL(referer).origin;
      return isOriginAllowed(refOrigin, allowedOrigins);
    } catch {
      return false;
    }
  }

  if (fetchSite === "same-origin" || fetchSite === "none") {
    return true;
  }

  if (fetchSite === "same-site") {
    return false;
  }

  const hasCookie = Boolean(req.header("cookie")?.trim());
  const requireOrigin = options?.requireOriginWhenCookiePresent ?? true;
  if (requireOrigin && hasCookie) {
    return false;
  }

  return true;
}

export function isOriginAllowed(
  origin: string,
  allowedOrigins: Set<string>,
): boolean {
  if (allowedOrigins.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      allowedOrigins.has("http://localhost:*")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
