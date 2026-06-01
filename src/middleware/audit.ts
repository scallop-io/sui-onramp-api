import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.ts';

/// Per-request audit logger. Assigns a correlation id, echoes it back as
/// `x-request-id` (so a support ticket maps to exact log lines), and writes one
/// structured line per request once the response is flushed — including the
/// final status and latency.
///
/// Request body/query are logged through the redacting logger, so secrets and
/// the Alchemy signature are stripped automatically. The signed hosted-ramp URL
/// in the response is intentionally NOT logged here (see the per-order audit
/// line in the route handlers, which logs the trail without the signature).
export function auditLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('request', {
      requestId,
      method: req.method,
      // originalUrl is stable; req.path becomes router-relative once the
      // request enters a mounted router, which would corrupt the audit trail.
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      latencyMs: Math.round(latencyMs * 100) / 100,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
      query: Object.keys(req.query ?? {}).length ? req.query : undefined,
      body:
        req.body && typeof req.body === 'object' && Object.keys(req.body).length
          ? req.body
          : undefined,
    });
  });

  next();
}
