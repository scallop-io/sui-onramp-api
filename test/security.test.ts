import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { startTestServer, postJson, captureLogs, VALID_SUI_ADDRESS } from './helpers.ts';

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startTestServer(createApp()));
});
after(async () => {
  await close();
});

describe('input validation rejects malicious payloads', () => {
  // Each payload isolates ONE invalid field (others are valid) so the 400 is
  // attributable to the field under test.
  const A = VALID_SUI_ADDRESS;
  const bad: Array<{ name: string; body: unknown }> = [
    { name: 'missing required fields', body: { crypto: 'SUI' } },
    { name: 'negative fiatAmount', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '-100', address: A } },
    { name: 'zero fiatAmount', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '0', address: A } },
    { name: 'scientific-notation amount', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '1e9', address: A } },
    { name: 'non-numeric amount', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '100; DROP', address: A } },
    { name: 'oversized fiat code', body: { crypto: 'SUI', fiat: 'DOLLARS', fiatAmount: '100', address: A } },
    { name: 'NoSQL-style object instead of string address', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '100', address: { $gt: '' } } },
    { name: 'array injected where string expected', body: { crypto: ['SUI', 'USDC'], fiat: 'USD', fiatAmount: '100', address: A } },
    { name: 'empty address', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '100', address: '' } },
    { name: 'non-hex / wrong-length address', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '100', address: '0xZZZ' } },
    { name: 'query-delimiter injection in address (SEV-001)', body: { crypto: 'SUI', fiat: 'USD', fiatAmount: '100', address: `${A}&fiatAmount=1` } },
    { name: 'query-delimiter injection in crypto (SEV-001)', body: { crypto: 'SUI&network=ETH', fiat: 'USD', fiatAmount: '100', address: A } },
  ];

  for (const { name, body } of bad) {
    test(`POST /buy/order rejects: ${name}`, async () => {
      const { status, json } = await postJson(base, '/buy/order', body);
      assert.equal(status, 400, `expected 400 for ${name}`);
      assert.equal(json.error, 'bad_request');
    });
  }

  test('rejects client-supplied redirectUrl/callbackUrl (strict body, SEV-001/SEV-004)', async () => {
    const { status } = await postJson(base, '/buy/order', {
      crypto: 'SUI',
      fiat: 'USD',
      fiatAmount: '100',
      address: A,
      redirectUrl: 'https://evil.example/phish',
      callbackUrl: 'https://evil.example/cb',
    });
    // These fields are server-set only; supplying them is rejected outright.
    assert.equal(status, 400);
  });

  test('malformed JSON body returns 400, not 500', async () => {
    const res = await fetch(`${base}/buy/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    assert.equal(res.status, 400);
  });
});

describe('secret never leaks to clients', () => {
  test('buy order response (URL + body) does not contain the merchant secret', async () => {
    const { json } = await postJson(base, '/buy/order', {
      crypto: 'SUI',
      fiat: 'USD',
      fiatAmount: '100',
      address: VALID_SUI_ADDRESS,
    });
    const serialized = JSON.stringify(json);
    assert.ok(!serialized.includes(config.ALCHEMY_PAY_APP_SECRET), 'secret in response');
    // The signed URL carries `sign` but not the raw secret.
    const parsed = new URL(json.data.url);
    assert.ok(parsed.searchParams.get('sign'));
    assert.ok(!json.data.url.includes(config.ALCHEMY_PAY_APP_SECRET));
  });
});

describe('audit logging does not leak sensitive material', () => {
  test('order request logs the address but never the secret or signed URL', async () => {
    const lines = await captureLogs(async () => {
      await postJson(base, '/buy/order', {
        crypto: 'SUI',
        fiat: 'USD',
        fiatAmount: '100',
        address: VALID_SUI_ADDRESS,
      });
      // small delay so the res 'finish' audit line is flushed
      await new Promise((r) => setTimeout(r, 50));
    });
    const joined = lines.join('\n');
    // The secret must never appear in any log line.
    assert.ok(!joined.includes(config.ALCHEMY_PAY_APP_SECRET), 'secret leaked to logs');
    // The order audit line is present with the full address (per logging policy)...
    const orderLine = lines.map((l) => safeParse(l)).find((o) => o?.msg === 'order');
    assert.ok(orderLine, 'order audit line emitted');
    assert.equal(orderLine.address, VALID_SUI_ADDRESS);
    // ...but never the signed hosted-ramp URL (it embeds the HMAC).
    assert.ok(!('url' in orderLine), 'signed url must not be in the audit line');
    assert.ok(!joined.includes('ramptest.alchemypay.org'), 'signed url leaked to logs');
  });
});

function safeParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
