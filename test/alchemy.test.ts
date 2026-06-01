import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.ts';
import {
  signAlchemyRequest,
  buildHostedRampUrl,
  fetchCryptoList,
  fetchQuote,
  fetchSellRate,
  groupFiatRows,
  AlchemyApiError,
  type AlchemyFiatRow,
} from '../src/lib/alchemy.ts';
import { installMockFetch, captureLogs } from './helpers.ts';

const SECRET = config.ALCHEMY_PAY_APP_SECRET;

afterEach(() => {
  mock.restoreAll();
});

describe('signAlchemyRequest', () => {
  test('produces a deterministic HMAC-SHA256 base64 sign over the canonical content', () => {
    mock.method(Date, 'now', () => 1_700_000_000_000);
    const fullUrl = 'https://openapi-test.alchemypay.org/open/api/v4/x?b=2&a=1';
    const { sign, timestamp, appId } = signAlchemyRequest({
      method: 'GET',
      fullUrl,
    });

    assert.equal(timestamp, '1700000000000');
    assert.equal(appId, config.ALCHEMY_PAY_APP_ID);

    // getPath sorts query params alphabetically: a=1 before b=2.
    const expectedContent = '1700000000000GET/open/api/v4/x?a=1&b=2';
    const expected = createHmac('sha256', SECRET)
      .update(expectedContent, 'utf8')
      .digest('base64');
    assert.equal(sign, expected);
  });

  test('sorts POST body keys for the signed content', () => {
    mock.method(Date, 'now', () => 1_700_000_000_000);
    const body = JSON.stringify({ b: '2', a: '1' });
    const { sign } = signAlchemyRequest({
      method: 'POST',
      fullUrl: 'https://openapi-test.alchemypay.org/open/api/v4/order/quote',
      body,
    });
    const expectedContent =
      '1700000000000POST/open/api/v4/order/quote{"a":"1","b":"2"}';
    const expected = createHmac('sha256', SECRET)
      .update(expectedContent, 'utf8')
      .digest('base64');
    assert.equal(sign, expected);
  });
});

describe('buildHostedRampUrl', () => {
  test('includes a sign param and never leaks the merchant secret', () => {
    const url = buildHostedRampUrl({
      crypto: 'SUI',
      network: 'SUI',
      fiat: 'USD',
      fiatAmount: '100',
      address: '0xabc',
      merchantOrderNo: 'order-1',
    });
    const parsed = new URL(url);
    assert.ok(parsed.searchParams.get('sign'), 'sign param present');
    assert.equal(parsed.searchParams.get('merchantOrderNo'), 'order-1');
    // The crown jewel must never appear in a URL handed to the client.
    assert.ok(!url.includes(SECRET), 'secret must not be in the URL');
  });

  test('uses the sandbox host when base URL is a test endpoint', () => {
    // Test env sets ALCHEMY_PAY_BASE_URL to an *-test.* host → sandbox.
    const url = buildHostedRampUrl({
      crypto: 'SUI',
      network: 'SUI',
      merchantOrderNo: 'o',
    });
    assert.ok(url.startsWith('https://ramptest.alchemypay.org/'));
  });

  test('selects rampPageSell signing path for sell side', () => {
    mock.method(Date, 'now', () => 1_700_000_000_000);
    const url = buildHostedRampUrl({
      crypto: 'SUI',
      network: 'SUI',
      cryptoAmount: '5',
      address: '0xabc',
      merchantOrderNo: 'sell-1',
      side: 'sell',
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('showTable'), 'sell');
    // Recompute the expected sign using the sell path and verify it matches,
    // proving the sell branch signs against /index/rampPageSell.
    const params: Record<string, string> = {
      appId: config.ALCHEMY_PAY_APP_ID,
      address: '0xabc',
      crypto: 'SUI',
      cryptoAmount: '5',
      merchantOrderNo: 'sell-1',
      network: 'SUI',
      showTable: 'sell',
      timestamp: '1700000000000',
    };
    const sortedQuery = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const expected = createHmac('sha256', SECRET)
      .update(`1700000000000GET/index/rampPageSell?${sortedQuery}`, 'utf8')
      .digest('base64');
    assert.equal(parsed.searchParams.get('sign'), expected);
  });

  // ─── SECURITY: signature canonicalization (finding SEV-001) ────────────────
  // The HMAC is signed over a RAW `k=v&k=v` string while the URL is delivered
  // URL-encoded. To keep the two canonical, no user-controlled signed value may
  // contain a query delimiter. The builder now FAILS CLOSED on such values, so
  // an attacker can't smuggle a second `address=`/`fiatAmount=` through any
  // signed field even if route validation regresses.
  test('throws on a delimiter-bearing address (fail-closed guard)', () => {
    assert.throws(
      () =>
        buildHostedRampUrl({
          crypto: 'SUI',
          network: 'SUI',
          fiat: 'USD',
          fiatAmount: '100',
          address: '0xvictim&fiatAmount=1&address=ATTACKER',
          merchantOrderNo: 'order-1',
        }),
      /unsafe character in signed ramp param "address"/,
    );
  });

  test('throws on a delimiter-bearing crypto symbol', () => {
    assert.throws(
      () =>
        buildHostedRampUrl({
          crypto: 'SUI&network=ETH',
          network: 'SUI',
          merchantOrderNo: 'order-1',
        }),
      /unsafe character in signed ramp param "crypto"/,
    );
  });

  test('server-set redirectUrl/callbackUrl may contain URL syntax (exempt from guard)', () => {
    const url = buildHostedRampUrl({
      crypto: 'SUI',
      network: 'SUI',
      merchantOrderNo: 'order-1',
      redirectUrl: 'https://app.example/done?x=1&y=2',
      callbackUrl: 'https://api.example/cb',
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('redirectUrl'), 'https://app.example/done?x=1&y=2');
    assert.ok(parsed.searchParams.get('sign'));
  });
});

describe('signAlchemyRequest logging (SEV-007)', () => {
  test('does NOT log signing material when DEBUG_SIGN is off (default)', async () => {
    const lines = await captureLogs(() => {
      signAlchemyRequest({ method: 'GET', fullUrl: 'https://openapi-test.alchemypay.org/x' });
    });
    const joined = lines.join('\n');
    assert.ok(!joined.includes('[alchemy-sign]'), 'must not log sign content/signature by default');
  });
});

describe('alchemy fetch + error mapping', () => {
  test('fetchCryptoList returns data and sends auth headers', async () => {
    const m = installMockFetch([
      { ok: true, status: 200, body: { success: true, data: [{ crypto: 'SUI', network: 'SUI' }] } },
    ]);
    try {
      const assets = await fetchCryptoList({ fiat: 'USD' });
      assert.equal(assets.length, 1);
      assert.equal(assets[0]!.crypto, 'SUI');
      const headers = m.calls[0]!.init!.headers as Record<string, string>;
      assert.ok(headers.appId);
      assert.ok(headers.timestamp);
      assert.ok(headers.sign);
    } finally {
      m.restore();
    }
  });

  test('fetchCryptoList throws AlchemyApiError on success:false, surfacing code+msg', async () => {
    const m = installMockFetch([
      { ok: true, status: 200, body: { success: false, returnCode: '3100', returnMsg: 'merchant not configured' } },
    ]);
    try {
      await assert.rejects(() => fetchCryptoList({}), (err: unknown) => {
        assert.ok(err instanceof AlchemyApiError);
        assert.equal((err as AlchemyApiError).code, '3100');
        assert.match((err as Error).message, /merchant not configured/);
        return true;
      });
    } finally {
      m.restore();
    }
  });

  test('fetchQuote sends a stably-sorted JSON body matching the sign', async () => {
    const m = installMockFetch([
      { ok: true, status: 200, body: { success: true, data: { cryptoPrice: '1.2' } } },
    ]);
    try {
      await fetchQuote({ crypto: 'SUI', network: 'SUI', fiat: 'USD', fiatAmount: '100', side: 'BUY' });
      const sentBody = m.calls[0]!.init!.body as string;
      // Keys must be alphabetically ordered in the wire body (so it matches the
      // signed bytes — mismatch causes Alchemy 81003).
      assert.equal(sentBody, JSON.stringify(JSON.parse(sentBody), Object.keys(JSON.parse(sentBody)).sort()));
      const keys = Object.keys(JSON.parse(sentBody));
      assert.deepEqual(keys, [...keys].sort());
    } finally {
      m.restore();
    }
  });

  test('fetchSellRate returns null instead of throwing when the quote fails', async () => {
    const m = installMockFetch([
      { ok: false, status: 400, body: { success: false, returnCode: '3100', returnMsg: 'no rate' } },
    ]);
    try {
      const rate = await fetchSellRate({ crypto: 'SUI', network: 'SUI', fiat: 'USD' });
      assert.equal(rate, null);
    } finally {
      m.restore();
    }
  });
});

describe('groupFiatRows', () => {
  test('collapses rows by currency with payment methods nested', () => {
    const rows: AlchemyFiatRow[] = [
      { currency: 'USD', country: 'US', countryName: 'United States', payWayCode: '10001', payWayName: 'Card', fixedFee: 0.3, feeRate: 0.035, payMin: 15, payMax: 10000 },
      { currency: 'USD', country: 'US', countryName: 'United States', payWayCode: '701', payWayName: 'Apple Pay', fixedFee: 0.3, feeRate: 0.035, payMin: 15, payMax: 5000 },
      { currency: 'EUR', country: 'DE', countryName: 'Germany', payWayCode: '10001', payWayName: 'Card', fixedFee: 0.3, feeRate: 0.035, payMin: 25, payMax: 10000 },
    ];
    const grouped = groupFiatRows(rows);
    assert.equal(grouped.length, 2);
    const usd = grouped.find((g) => g.code === 'USD')!;
    assert.equal(usd.paymentMethods.length, 2);
    const eur = grouped.find((g) => g.code === 'EUR')!;
    assert.equal(eur.paymentMethods.length, 1);
  });
});
