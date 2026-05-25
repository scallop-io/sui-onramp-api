import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import {
  buildHostedRampUrl,
  fetchCryptoList,
  fetchFiatList,
  fetchQuote,
  fetchSellRate,
} from '../lib/alchemy.ts';

const router = Router();

/// Alchemy's `network` value for Sui mainnet. Kept aligned with the
/// buy-side router on purpose so both share the default.
const SUI_NETWORK = 'SUI';

/// Alchemy's /crypto/list reports `sellEnable: 0` for every Sui coin even
/// though their /quote endpoint accepts SELL for some. Maintain the
/// allowlist server-side so mobile doesn't need its own copy. Drop once
/// Alchemy fixes the flag upstream.
///
/// USDT-on-Sui is intentionally excluded — Alchemy doesn't actually settle
/// sells for it on this network even though their merchant API accepts a
/// quote, and the hosted page rejects the order at submit time.
const SELLABLE_SYMBOLS = new Set(['SUI', 'USDC']);

/// Static fallback for the `/crypto-list` stub path. Rates / mins are
/// approximations; real responses come from Alchemy.
const STUB_SELL_COINS = [
  { symbol: 'SUI',  minSellFiat: 20.2, maxSellFiat: 10000, sellRate: '0.85' },
  { symbol: 'USDC', minSellFiat: 15.0, maxSellFiat: 10000, sellRate: '0.998' },
];

const QuoteBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  payWayCode: z.string().min(1).optional(),
});

/// Sell orders specify the amount of crypto to sell, not the fiat to
/// receive — that's what Alchemy's hosted off-ramp page reads.
const OrderBody = z.object({
  crypto: z.string().min(1),
  cryptoAmount: z.string().regex(/^\d+(\.\d+)?$/, 'cryptoAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  address: z.string().min(1, 'address (source Sui wallet) is required'),
  fiat: z.string().length(3).optional(),
  redirectUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
});

/// Alchemy's off-ramp page requires `country` alongside `fiat`. Map the
/// fiats Alchemy supports for SELL payouts to a canonical country.
/// Sent only when we have a confident mapping; otherwise the hosted page
/// falls back to its own picker.
const FIAT_TO_COUNTRY: Record<string, string> = {
  USD: 'US',
  EUR: 'DE',
  GBP: 'GB',
  HKD: 'HK',
  IDR: 'ID',
  INR: 'IN',
  JPY: 'JP',
  KRW: 'KR',
  MYR: 'MY',
  CAD: 'CA',
  AUD: 'AU',
  SGD: 'SG',
  TWD: 'TW',
  THB: 'TH',
  PHP: 'PH',
  VND: 'VN',
  BRL: 'BR',
  TRY: 'TR',
  MXN: 'MX',
  ZAR: 'ZA',
};

const CryptoListQuery = z.object({
  fiat: z.string().length(3).optional(),
});

/// Per-coin sell limits + indicative sell rate. Mobile divides
/// `minSellFiat / sellRate` to derive a coin-unit floor for the sell tab
/// (Alchemy's quote endpoint is the only place that exposes the post-spread
/// rate, so we probe it here once per coin per request).
router.get('/crypto-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = CryptoListQuery.parse(req.query);
    const fiat = query.fiat ?? 'USD';

    if (config.USE_STUB_CRYPTO_LIST) {
      res.json({
        data: STUB_SELL_COINS.map((c) => ({
          symbol: c.symbol,
          network: SUI_NETWORK,
          contractAddress: null,
          icon: null,
          minSellFiat: c.minSellFiat,
          maxSellFiat: c.maxSellFiat,
          sellRate: c.sellRate,
        })),
      });
      return;
    }

    const assets = await fetchCryptoList({ fiat });
    const sellable = assets.filter(
      (a) => a.network === SUI_NETWORK && SELLABLE_SYMBOLS.has(a.crypto.toUpperCase()),
    );

    // One Alchemy quote per sellable coin (parallel). Alchemy's quote
    // endpoint doesn't validate sell-side fiat minimums (verified by
    // probing — amounts well below the hosted-page floor still return
    // successful quotes), so `minSellFiat` stays null here. Mobile either
    // skips the client-side floor or applies its own conservative default.
    const probed = await Promise.all(
      sellable.map(async (a) => {
        const sellRate = await fetchSellRate({
          crypto: a.crypto,
          network: a.network,
          fiat,
        });
        return {
          symbol: a.crypto,
          network: a.network,
          contractAddress: a.address ?? null,
          icon: a.icon ?? null,
          minSellFiat: null as number | null,
          maxSellFiat: a.maxSellAmount ?? null,
          sellRate,
        };
      }),
    );

    // Drop coins with no rate. Most commonly this happens when the merchant
    // isn't configured for the (fiat, side) pair (Alchemy code 3100); the
    // hosted page would just reject the order, so surfacing those coins as
    // sellable in the UI is worse than hiding them. An empty `data` array
    // tells mobile to drop the fiat from the sell-side picker entirely.
    const result = probed.filter((r) => r.sellRate != null);

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/fiat-list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await fetchFiatList({ type: 'SELL' });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = QuoteBody.parse(req.body);
    const quote = await fetchQuote({ ...body, side: 'SELL' });
    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

router.post('/order', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = OrderBody.parse(req.body);
    const merchantOrderNo = `sui-offramp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Only send `fiat` when we can pair it with `country`; otherwise the
    // hosted page ignores fiat anyway and we'd just bloat the URL.
    const fiat = body.fiat?.toUpperCase();
    const country = fiat ? FIAT_TO_COUNTRY[fiat] : undefined;
    const fiatPair = fiat && country ? { fiat, country } : {};

    const url = buildHostedRampUrl({
      crypto: body.crypto,
      cryptoAmount: body.cryptoAmount,
      network: body.network,
      address: body.address,
      ...fiatPair,
      redirectUrl: body.redirectUrl,
      callbackUrl: body.callbackUrl,
      merchantOrderNo,
      side: 'sell',
    });
    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as sellRouter };
