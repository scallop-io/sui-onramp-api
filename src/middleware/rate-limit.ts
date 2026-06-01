import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../lib/logger.ts';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /// Label for logs (e.g. 'global', 'write').
  name?: string;
}

/// Dependency-free fixed-window per-IP rate limiter. State is in-process, so in
/// a multi-instance deployment the effective limit is `max * instances` — fine
/// as a first line of defense against the signing-oracle abuse and the
/// /sell/crypto-list fan-out; move to a shared store (Redis) if you need a hard
/// global cap. `max <= 0` disables the limiter (pass-through).
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, name } = opts;
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodically drop expired buckets so memory can't grow unbounded under an
  // IP-rotating attacker. Unref'd so it never keeps the process alive.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    if (max <= 0) {
      next();
      return;
    }
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      logger.warn('rate limited', {
        ip: key,
        limiter: name,
        path: req.originalUrl.split('?')[0],
      });
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Please retry later.',
      });
      return;
    }
    next();
  };
}
