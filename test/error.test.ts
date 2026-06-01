import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { errorHandler } from '../src/middleware/error.ts';
import { AlchemyApiError } from '../src/lib/alchemy.ts';
import { captureLogs } from './helpers.ts';

/// A fake Express Response capturing status/json, plus res.locals for the
/// requestId the handler reads.
interface FakeRes {
  locals: { requestId: string };
  _status: number;
  _json: any;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    locals: { requestId: 'req-test-1' },
    _status: 0,
    _json: undefined,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res;
}

const req = {} as Request;
const next = () => {};

describe('errorHandler', () => {
  test('maps ZodError to 400 bad_request and logs a warn (no values leaked)', async () => {
    const schema = z.object({ fiatAmount: z.string() });
    let zerr: ZodError;
    try {
      schema.parse({});
      throw new Error('should have thrown');
    } catch (e) {
      zerr = e as ZodError;
    }
    const res = fakeRes();
    const lines = await captureLogs(() => errorHandler(zerr, req, res as unknown as Response, next));
    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'bad_request');
    assert.ok(res._json.details);
    // A warn line with the requestId is emitted for the audit trail.
    const warn = lines.map((l) => JSON.parse(l)).find((o) => o.msg === 'validation failed');
    assert.ok(warn);
    assert.equal(warn.requestId, 'req-test-1');
  });

  test('maps AlchemyApiError to 502 with code + GENERIC message (no verbatim upstream leak)', async () => {
    const res = fakeRes();
    const lines = await captureLogs(() =>
      errorHandler(
        new AlchemyApiError('merchant not configured for USD SELL', '3100'),
        req,
        res as unknown as Response,
        next,
      ),
    );
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'upstream_error');
    assert.equal(res._json.code, '3100');
    // The opaque code is kept, but the verbatim upstream message (which can
    // leak merchant config / enumeration hints) must NOT reach the client...
    assert.equal(res._json.message, 'Payment provider request failed.');
    assert.ok(!JSON.stringify(res._json).includes('merchant not configured'));
    // ...it is logged server-side for debugging.
    const logged = lines.map((l) => JSON.parse(l)).find((o) => o.msg === 'alchemy error');
    assert.ok(logged);
    assert.equal(logged.requestId, 'req-test-1');
    assert.match(logged.message, /merchant not configured/);
  });

  test('maps unknown errors to a generic 500 WITHOUT leaking stack/message to the client', async () => {
    const res = fakeRes();
    const secretInternal = new Error('connection string mongodb://user:pw@host leaked');
    const lines = await captureLogs(() => errorHandler(secretInternal, req, res as unknown as Response, next));
    assert.equal(res._status, 500);
    assert.equal(res._json.error, 'internal_error');
    assert.equal(res._json.message, 'Unexpected server error.');
    // The internal detail is logged server-side but NEVER sent to the client.
    assert.ok(!JSON.stringify(res._json).includes('mongodb://'));
    const logged = lines.map((l) => JSON.parse(l)).find((o) => o.msg === 'unhandled error');
    assert.ok(logged, 'internal error is logged server-side');
  });
});
