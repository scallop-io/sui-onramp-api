import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.ts';
import {
  buildHostedRampUrl,
  fetchCryptoList,
  fetchFiatList,
  fetchQuote,
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

/// Alchemy's `network` value for Sui mainnet — historical alts: `SUI_NETWORK`.
const SUI_NETWORK = 'SUI';

/// Static fallback served when `USE_STUB_CRYPTO_LIST=true`. Same shape as
/// the live Alchemy response so the mobile client doesn't branch.
const STUB_SUI_COINS = [
  { symbol: 'SUI', network: SUI_NETWORK },
  { symbol: 'USDC', network: SUI_NETWORK },
  { symbol: 'USDT', network: SUI_NETWORK },
  { symbol: 'SCA', network: SUI_NETWORK },
];

const STUB_FIATS = [
  {
    code: 'USD',
    country: 'US',
    countryName: 'United States',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 15, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
      { payWayCode: '701',   payWayName: 'Apple Pay',   payMin: 15, payMax: 5000,  fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'EUR',
    country: 'EU',
    countryName: 'Eurozone',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 25, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'GBP',
    country: 'GB',
    countryName: 'United Kingdom',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 25, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'HKD',
    country: 'HK',
    countryName: 'Hong Kong',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 200, payMax: 80000, fixedFee: 2.4, feeRate: 0.035 },
    ],
  },
];

const CryptoListQuery = z.object({
  fiat: FiatCode.optional(),
});

interface BuyCryptoRow {
  symbol: string;
  network: string;
  contractAddress: string | null;
  icon: string | null;
  minPurchaseAmount: number | null;
  maxPurchaseAmount: number | null;
}

// Slow-changing upstream data — cache it so we don't re-hit Alchemy on every
// mobile cold-start. Keyed by fiat.
const cryptoListCache = new TtlCache<BuyCryptoRow[]>(config.CACHE_TTL_MS);
const fiatListCache = new TtlCache<GroupedFiat[]>(config.CACHE_TTL_MS);

router.get('/crypto-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.USE_STUB_CRYPTO_LIST) {
      res.json({
        data: STUB_SUI_COINS.map((c) => ({
          symbol: c.symbol,
          network: c.network,
          contractAddress: null,
          icon: null,
          minPurchaseAmount: null,
          maxPurchaseAmount: null,
        })),
      });
      return;
    }

    const query = CryptoListQuery.parse(req.query);
    const data = await cryptoListCache.getOrCompute(query.fiat ?? 'ANY', async () => {
      const assets = await fetchCryptoList({ fiat: query.fiat });
      return assets
        .filter((a) => a.network === SUI_NETWORK && a.buyEnable === 1)
        .map((a) => ({
          symbol: a.crypto,
          network: a.network,
          contractAddress: a.address ?? null,
          icon: a.icon ?? null,
          minPurchaseAmount: a.minPurchaseAmount,
          maxPurchaseAmount: a.maxPurchaseAmount,
        }));
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

const FiatListQuery = z.object({
  type: z.enum(['BUY', 'SELL']).default('BUY'),
});

router.get('/fiat-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = FiatListQuery.parse(req.query);

    if (config.USE_STUB_CRYPTO_LIST) {
      res.json({ data: STUB_FIATS });
      return;
    }

    const data = await fiatListCache.getOrCompute(query.type, async () =>
      groupFiatRows(await fetchFiatList({ type: query.type })),
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

const QuoteBody = z.object({
  crypto: CryptoSymbol,
  fiat: FiatCode,
  fiatAmount: DecimalAmount,
  network: NetworkName.default(SUI_NETWORK),
  payWayCode: PayWayCode.optional(),
});

router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = QuoteBody.parse(req.body);

    if (config.USE_STUB_CRYPTO_LIST) {
      const fiatAmount = Number.parseFloat(body.fiatAmount);
      const stubPayMin = body.crypto === 'SUI' ? 30 : 15;
      const stubPrice = body.crypto === 'SUI' ? 1.2 : 1.0;
      const cryptoQuantity = fiatAmount > 0 ? (fiatAmount / stubPrice).toFixed(6) : '0';
      res.json({
        data: {
          crypto: body.crypto,
          network: body.network,
          fiat: body.fiat,
          cryptoPrice: stubPrice.toString(),
          fiatQuantity: body.fiatAmount,
          cryptoQuantity,
          payMin: stubPayMin.toString(),
          payMax: '10000',
          rampFee: '1.50',
          networkFee: '0.10',
          payWayCode: body.payWayCode ?? '10001',
        },
      });
      return;
    }

    const quote = await fetchQuote(body);
    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

// redirectUrl/callbackUrl are intentionally NOT accepted from the client — they
// are fixed for our app and set server-side from config. `.strict()` rejects
// unknown keys so a client can't probe for accepted fields.
const OrderBody = z
  .object({
    crypto: CryptoSymbol,
    fiat: FiatCode,
    fiatAmount: DecimalAmount,
    network: NetworkName.default(SUI_NETWORK),
    address: SuiAddress,
  })
  .strict();

router.post('/order', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = OrderBody.parse(req.body);
    const merchantOrderNo = `sui-onramp-${randomUUID()}`;

    const url = buildHostedRampUrl({
      crypto: body.crypto,
      fiat: body.fiat,
      fiatAmount: body.fiatAmount,
      network: body.network,
      address: body.address,
      redirectUrl: config.RAMP_REDIRECT_URL,
      callbackUrl: config.RAMP_CALLBACK_URL,
      merchantOrderNo,
    });

    // Audit trail for the money-movement event. Logs the full recipient
    // address and amount against the merchantOrderNo, but never the signed
    // `url` (it embeds the HMAC signature).
    logger.info('order', {
      requestId: res.locals.requestId,
      side: 'buy',
      merchantOrderNo,
      crypto: body.crypto,
      network: body.network,
      fiat: body.fiat,
      fiatAmount: body.fiatAmount,
      address: body.address,
    });

    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as buyRouter };
