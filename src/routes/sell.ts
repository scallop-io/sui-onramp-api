import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.ts';
import {
  buildHostedRampUrl,
  fetchCryptoList,
  fetchFiatList,
  fetchQuote,
  fetchSellRate,
  groupFiatRows,
  type GroupedFiat,
} from '../lib/alchemy.ts';
import { logger } from '../lib/logger.ts';
import { TtlCache } from '../lib/cache.ts';
import {
  CryptoSymbol,
  DecimalAmount,
  FiatCode,
  NetworkName,
  PayWayCode,
  SuiAddress,
} from '../lib/validation.ts';

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

/// Static fallback for the `/crypto-list` stub path. Rates are approximations;
/// real responses come from Alchemy.
const STUB_SELL_COINS = [
  { symbol: 'SUI',  sellRate: '0.85' },
  { symbol: 'USDC', sellRate: '0.998' },
];

const QuoteBody = z.object({
  crypto: CryptoSymbol,
  fiat: FiatCode,
  fiatAmount: DecimalAmount,
  network: NetworkName.default(SUI_NETWORK),
  payWayCode: PayWayCode.optional(),
});

/// Sell orders specify the amount of crypto to sell, not the fiat to
/// receive — that's what Alchemy's hosted off-ramp page reads.
/// redirectUrl/callbackUrl are set server-side from config, never from the
/// client; `.strict()` rejects unknown keys.
const OrderBody = z
  .object({
    crypto: CryptoSymbol,
    cryptoAmount: DecimalAmount,
    network: NetworkName.default(SUI_NETWORK),
    address: SuiAddress,
    fiat: FiatCode.optional(),
  })
  .strict();

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
  fiat: FiatCode.optional(),
});

interface SellCryptoRow {
  symbol: string;
  network: string;
  contractAddress: string | null;
  icon: string | null;
  sellRate: string | null;
}

// The sell crypto-list does one Alchemy quote PER sellable coin, so an
// unauthenticated caller could otherwise force a fan-out of upstream calls on
// every request. Cache the computed result per fiat to bound that.
const sellListCache = new TtlCache<SellCryptoRow[]>(config.CACHE_TTL_MS);
const sellFiatListCache = new TtlCache<GroupedFiat[]>(config.CACHE_TTL_MS);

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
          sellRate: c.sellRate,
        })),
      });
      return;
    }

    const data = await sellListCache.getOrCompute(fiat, async () => {
      const assets = await fetchCryptoList({ fiat });
      const sellable = assets.filter(
        (a) => a.network === SUI_NETWORK && SELLABLE_SYMBOLS.has(a.crypto.toUpperCase()),
      );

      // One Alchemy quote per sellable coin (parallel) to discover the
      // current sell rate. No per-coin sell-min: Alchemy doesn't expose it
      // via any public endpoint and we won't ship a guess.
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
            sellRate,
          };
        }),
      );

      // Drop coins with no rate. Most commonly this happens when the merchant
      // isn't configured for the (fiat, side) pair (Alchemy code 3100); the
      // hosted page would just reject the order, so surfacing those coins as
      // sellable in the UI is worse than hiding them. An empty `data` array
      // tells mobile to drop the fiat from the sell-side picker entirely.
      return probed.filter((r) => r.sellRate != null);
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get('/fiat-list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await sellFiatListCache.getOrCompute('SELL', async () =>
      groupFiatRows(await fetchFiatList({ type: 'SELL' })),
    );
    res.json({ data });
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
    const merchantOrderNo = `sui-offramp-${randomUUID()}`;

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
      redirectUrl: config.RAMP_REDIRECT_URL,
      callbackUrl: config.RAMP_CALLBACK_URL,
      merchantOrderNo,
      side: 'sell',
    });

    // Audit trail for the money-movement event. Logs the full source address
    // and amount against the merchantOrderNo, but never the signed `url` (it
    // embeds the HMAC signature).
    logger.info('order', {
      requestId: res.locals.requestId,
      side: 'sell',
      merchantOrderNo,
      crypto: body.crypto,
      network: body.network,
      fiat: country ? fiat : undefined,
      cryptoAmount: body.cryptoAmount,
      address: body.address,
    });

    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as sellRouter };
