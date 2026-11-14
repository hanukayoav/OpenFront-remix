import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

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

export function getClientIp(req: Request): string {
  const cfIp = req.header("cf-connecting-ip");
  if (cfIp && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const candidate = req.ip ?? req.socket.remoteAddress ?? "";
  return candidate.length > 0 ? candidate : "unknown";
}

export function createIpRateLimitMiddleware(
  limiter: SlidingWindowLimiter,
  label: string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${label}:${getClientIp(req)}`;
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

/**
 * Checks whether a cookie-authenticated POST/DELETE/PUT request passes
 * CSRF Origin/Sec-Fetch-Site validation against the configured allowed origins.
 */
export function isAllowedCookieCsrfRequest(
  req: Request,
  allowedOrigins: Set<string>,
): boolean {
  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
    return false;
  }

  const origin = req.header("origin");
  if (origin) {
    return isOriginAllowed(origin, allowedOrigins);
  }

  const referer = req.header("referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return isOriginAllowed(refOrigin, allowedOrigins);
    } catch {
      return false;
    }
  }

  // Non-browser / same-origin clients without Origin or Referer headers are allowed
  // only when Sec-Fetch-Site isn't cross-site (checked above).
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
