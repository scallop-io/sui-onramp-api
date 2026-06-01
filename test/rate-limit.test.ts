import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from '../src/middleware/rate-limit.ts';
import { startTestServer } from './helpers.ts';

/// Builds a throwaway app whose only middleware is a rate limiter with the given
/// options, so limits are deterministic regardless of the global config.
async function appWithLimiter(max: number) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({ windowMs: 60_000, max, name: 'test' }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return startTestServer(app);
}

describe('rateLimit middleware', () => {
  let srv: Awaited<ReturnType<typeof appWithLimiter>>;
  before(async () => {
    srv = await appWithLimiter(2);
  });
  after(async () => {
    await srv.close();
  });

  test('allows up to max, then returns 429 with Retry-After', async () => {
    const r1 = await fetch(`${srv.base}/ping`);
    const r2 = await fetch(`${srv.base}/ping`);
    const r3 = await fetch(`${srv.base}/ping`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, 'third request over the limit is blocked');
    assert.ok(r3.headers.get('retry-after'), 'Retry-After header set on 429');
    const body: any = await r3.json();
    assert.equal(body.error, 'rate_limited');
  });

  test('sets RateLimit-Limit / RateLimit-Remaining headers', async () => {
    const srv2 = await appWithLimiter(5);
    try {
      const r = await fetch(`${srv2.base}/ping`);
      assert.equal(r.headers.get('ratelimit-limit'), '5');
      assert.equal(r.headers.get('ratelimit-remaining'), '4');
    } finally {
      await srv2.close();
    }
  });

  test('max <= 0 disables the limiter (pass-through)', async () => {
    const srv3 = await appWithLimiter(0);
    try {
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${srv3.base}/ping`);
        assert.equal(r.status, 200);
      }
    } finally {
      await srv3.close();
    }
  });
});
