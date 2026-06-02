import express, { type Express } from 'express';
import { config } from './config.ts';
import { buyRouter } from './routes/buy.ts';
import { sellRouter } from './routes/sell.ts';
import { errorHandler } from './middleware/error.ts';
import { auditLogger } from './middleware/audit.ts';
import { rateLimit } from './middleware/rate-limit.ts';

/// Builds the Express app with all middleware and routes wired up, but does NOT
/// start listening or register process-level handlers. Keeping construction
/// separate from bootstrap lets tests exercise the real middleware/route stack
/// (audit logging, validation, error handling) without binding a fixed port or
/// installing signal handlers. The bootstrap (listen, egress probe, process
/// safety net) lives in index.ts.
export function createApp(): Express {
  const app = express();

  // Behind a single load balancer / reverse proxy (ALB, nginx). Trusting one
  // hop lets `req.ip` reflect the real client IP from X-Forwarded-For for the
  // audit log. Tighten this (to the proxy's subnet) or raise the hop count to
  // match the actual deployment topology so the header can't be spoofed.
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '64kb' }));

  app.use(auditLogger);

  app.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Health check is exempt from rate limiting so load-balancer probes never
  // get throttled.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // General per-IP limiter on everything below, plus a stricter limiter on the
  // write/expensive endpoints (the signing oracle + the /sell/crypto-list
  // upstream fan-out).
  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
      name: 'global',
    }),
  );
  const writeLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_WRITE,
    name: 'write',
  });
  app.use(
    ['/buy/order', '/buy/quote', '/sell/order', '/sell/quote', '/sell/crypto-list'],
    writeLimiter,
  );

  app.use('/buy', buyRouter);
  app.use('/sell', sellRouter);

  app.use(errorHandler);

  return app;
}
