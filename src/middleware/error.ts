import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AlchemyApiError } from '../lib/alchemy.ts';
import { logger } from '../lib/logger.ts';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = res.locals.requestId as string | undefined;

  if (err instanceof ZodError) {
    const fieldErrors = err.flatten().fieldErrors;
    // Log validation failures so probing/abuse is visible in the audit trail.
    // Only field names + messages are logged here, never the submitted values.
    logger.warn('validation failed', { requestId, fields: fieldErrors });
    res.status(400).json({
      error: 'bad_request',
      message: 'Invalid request parameters.',
      details: fieldErrors,
    });
    return;
  }

  if (err instanceof AlchemyApiError) {
    // Log the verbatim upstream message server-side for debugging, but return a
    // generic message to the client — Alchemy's returnMsg can disclose merchant
    // configuration / enumeration hints. The opaque `code` is kept so the
    // mobile client can map it to a localized, user-facing string.
    logger.error('alchemy error', { requestId, code: err.code, message: err.message });
    res.status(502).json({
      error: 'upstream_error',
      message: 'Payment provider request failed.',
      code: err.code,
    });
    return;
  }

  // Body-parser / http-errors style errors carry a numeric status: malformed
  // JSON → 400, body over the 64kb cap → 413. Honor that status with a safe,
  // generic message instead of masking a client error as a server 500.
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    logger.warn('client error', {
      requestId,
      status,
      message: err instanceof Error ? err.message : String(err),
    });
    res.status(status).json({
      error: status === 413 ? 'payload_too_large' : 'bad_request',
      message:
        status === 413 ? 'Request body too large.' : 'Malformed request.',
    });
    return;
  }

  logger.error('unhandled error', {
    requestId,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({
    error: 'internal_error',
    message: 'Unexpected server error.',
  });
}
