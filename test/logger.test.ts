import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/lib/logger.ts';
import { captureLogs } from './helpers.ts';

/// The logger is the redaction boundary for an audit log on a money-movement
/// API. These tests pin the security guarantee: nothing on the denylist, and
/// no embedded signature, ever reaches the output — even nested or in arrays.

describe('logger redaction', () => {
  test('emits a single JSON line with ts/level/msg', async () => {
    const lines = await captureLogs(() => logger.info('hello', { a: 1 }));
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.level, 'info');
    assert.equal(obj.msg, 'hello');
    assert.equal(obj.a, 1);
    assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('redacts top-level sensitive keys', async () => {
    const lines = await captureLogs(() =>
      logger.info('x', {
        sign: 'SECRET_SIGNATURE',
        secret: 'MERCHANT_SECRET',
        authorization: 'Bearer abc',
        password: 'hunter2',
        token: 'tok_123',
        safe: 'visible',
      }),
    );
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.sign, '[redacted]');
    assert.equal(obj.secret, '[redacted]');
    assert.equal(obj.authorization, '[redacted]');
    assert.equal(obj.password, '[redacted]');
    assert.equal(obj.token, '[redacted]');
    assert.equal(obj.safe, 'visible');
    // The actual secret values must not appear anywhere in the serialized line.
    assert.ok(!lines[0]!.includes('SECRET_SIGNATURE'));
    assert.ok(!lines[0]!.includes('MERCHANT_SECRET'));
  });

  test('redaction is case-insensitive on key names', async () => {
    const lines = await captureLogs(() =>
      logger.info('x', { Sign: 'a', APPSECRET: 'b', ApiKey: 'c' }),
    );
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.Sign, '[redacted]');
    assert.equal(obj.APPSECRET, '[redacted]');
    assert.equal(obj.ApiKey, '[redacted]');
  });

  test('redacts sensitive keys nested in objects and arrays', async () => {
    const lines = await captureLogs(() =>
      logger.info('x', {
        outer: { inner: { sign: 'DEEP_SECRET', ok: 1 } },
        list: [{ password: 'p' }, { ok: 2 }],
      }),
    );
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.outer.inner.sign, '[redacted]');
    assert.equal(obj.outer.inner.ok, 1);
    assert.equal(obj.list[0].password, '[redacted]');
    assert.equal(obj.list[1].ok, 2);
    assert.ok(!lines[0]!.includes('DEEP_SECRET'));
  });

  test('scrubs signature/token query params out of URL strings', async () => {
    const url =
      'https://ramp.alchemypay.org/?appId=x&address=0xabc&sign=ABC123SIGNATURE&token=t';
    const lines = await captureLogs(() => logger.info('x', { url }));
    const obj = JSON.parse(lines[0]!);
    assert.ok(!obj.url.includes('ABC123SIGNATURE'));
    assert.match(obj.url, /sign=\[redacted\]/);
    assert.match(obj.url, /token=\[redacted\]/);
    // Non-sensitive params are preserved.
    assert.match(obj.url, /address=0xabc/);
  });

  test('does not blow the stack on deeply nested input', async () => {
    let nested: Record<string, unknown> = { sign: 'x' };
    for (let i = 0; i < 50; i++) nested = { child: nested };
    const lines = await captureLogs(() => logger.info('x', { nested }));
    // Should produce a line without throwing; depth is bounded.
    assert.equal(lines.length, 1);
  });

  test('error level writes to console.error', async () => {
    const lines = await captureLogs(() => logger.error('boom', { code: 1 }));
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.level, 'error');
    assert.equal(obj.msg, 'boom');
  });
});
