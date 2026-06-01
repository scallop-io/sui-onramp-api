import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { startTestServer, postJson, VALID_SUI_ADDRESS } from './helpers.ts';

// Runs with USE_STUB_CRYPTO_LIST=true (see the `test` script), so list/quote
// endpoints serve stubs and no network is touched. Order endpoints build the
// signed URL locally.

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startTestServer(createApp()));
});
after(async () => {
  await close();
});

describe('health + correlation', () => {
  test('GET /healthz returns ok and an x-request-id header', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  test('every response carries a unique x-request-id', async () => {
    const a = await fetch(`${base}/healthz`);
    const b = await fetch(`${base}/healthz`);
    assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
  });
});

describe('buy routes (stub mode)', () => {
  test('GET /buy/crypto-list returns the expected shape', async () => {
    const res = await fetch(`${base}/buy/crypto-list`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
    assert.ok('symbol' in body.data[0]);
    assert.ok('network' in body.data[0]);
  });

  test('GET /buy/fiat-list returns grouped fiats', async () => {
    const res = await fetch(`${base}/buy/fiat-list`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok('paymentMethods' in body.data[0]);
  });

  test('POST /buy/quote computes a crypto quantity', async () => {
    const { status, json } = await postJson(base, '/buy/quote', {
      crypto: 'SUI',
      fiat: 'USD',
      fiatAmount: '120',
    });
    assert.equal(status, 200);
    assert.ok(json.data.cryptoQuantity);
    assert.equal(json.data.fiat, 'USD');
  });

  test('POST /buy/order returns a signed sandbox URL + merchantOrderNo', async () => {
    const { status, json } = await postJson(base, '/buy/order', {
      crypto: 'SUI',
      fiat: 'USD',
      fiatAmount: '100',
      address: VALID_SUI_ADDRESS,
    });
    assert.equal(status, 200);
    assert.ok(json.data.url.startsWith('https://ramptest.alchemypay.org/'));
    // Order number is a UUID-based id, not the old timestamp+Math.random form.
    assert.match(
      json.data.merchantOrderNo,
      /^sui-onramp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const parsed = new URL(json.data.url);
    assert.ok(parsed.searchParams.get('sign'));
  });
});

describe('sell routes (stub mode)', () => {
  test('GET /sell/crypto-list returns sellable coins', async () => {
    const res = await fetch(`${base}/sell/crypto-list`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.every((c: any) => 'sellRate' in c));
  });

  test('POST /sell/order returns a signed sandbox URL', async () => {
    const { status, json } = await postJson(base, '/sell/order', {
      crypto: 'SUI',
      cryptoAmount: '5',
      address: VALID_SUI_ADDRESS,
      fiat: 'USD',
    });
    assert.equal(status, 200);
    assert.match(json.data.merchantOrderNo, /^sui-offramp-[0-9a-f-]{36}$/);
    assert.ok(json.data.url.includes('showTable=sell'));
  });
});

describe('request body limits', () => {
  test('rejects bodies over the 64kb cap', async () => {
    const huge = 'a'.repeat(70 * 1024);
    const res = await fetch(`${base}/buy/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crypto: 'SUI', fiat: 'USD', fiatAmount: '1', address: huge }),
    });
    assert.equal(res.status, 413);
  });
});
