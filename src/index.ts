import { config } from './config.ts';
import { createApp } from './app.ts';
import { logger } from './lib/logger.ts';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info('listening', { port: config.PORT, env: config.NODE_ENV });
  // One-shot egress-IP probe — Alchemy Pay requires the caller IP to be
  // whitelisted on prod. Log it on every boot so the IP for the current
  // deployment is visible without exec'ing into the container.
  fetch('https://api.ipify.org')
    .then((r) => r.text())
    .then((ip) => logger.info('egress-ip', { ip: ip.trim() }))
    .catch((e) => logger.warn('egress-ip probe failed', { error: String(e) }));
});

// Listen failures (e.g. EADDRINUSE) — these fire on `server`, not via the
// request error handler, so they'd otherwise crash unlogged.
server.on('error', (err) => {
  logger.error('server error', { message: err.message, stack: err.stack });
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info('draining', { signal });
    server.close(() => process.exit(0));
  });
}

// Process-level safety net. An uncaught exception or unhandled rejection leaves
// the process in an undefined state — for a money-movement service the correct
// response is to log it (structured, so it's visible in the audit trail) and
// exit so the orchestrator restarts a clean process, never to keep serving.
function fatal(kind: string, err: unknown): void {
  logger.error(kind, {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Best-effort graceful close, with a hard exit if it hangs.
  const timer = setTimeout(() => process.exit(1), 2000);
  timer.unref();
  server.close(() => process.exit(1));
}

process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
