import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/lib/cache.ts';

afterEach(() => mock.restoreAll());

describe('TtlCache', () => {
  test('returns cached value within TTL and computes only once', async () => {
    const cache = new TtlCache<number>(1000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    assert.equal(await cache.getOrCompute('k', compute), 42);
    assert.equal(await cache.getOrCompute('k', compute), 42);
    assert.equal(calls, 1, 'compute runs once while cached');
  });

  test('recomputes after the entry expires', async () => {
    let now = 1_000_000;
    mock.method(Date, 'now', () => now);
    const cache = new TtlCache<number>(1000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    assert.equal(await cache.getOrCompute('k', compute), 1);
    now += 1500; // advance past TTL
    assert.equal(await cache.getOrCompute('k', compute), 2, 'recomputes after expiry');
  });

  test('keys are independent', async () => {
    const cache = new TtlCache<string>(1000);
    assert.equal(await cache.getOrCompute('USD', async () => 'usd'), 'usd');
    assert.equal(await cache.getOrCompute('EUR', async () => 'eur'), 'eur');
    assert.equal(await cache.getOrCompute('USD', async () => 'changed'), 'usd');
  });

  test('ttl of 0 disables caching (always recomputes)', async () => {
    const cache = new TtlCache<number>(0);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    await cache.getOrCompute('k', compute);
    await cache.getOrCompute('k', compute);
    assert.equal(calls, 2, 'no caching when ttl=0');
  });
});
