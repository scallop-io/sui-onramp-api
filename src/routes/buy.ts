import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import {
  buildHostedRampUrl,
  fetchCryptoList,
  fetchFiatList,
  fetchQuote,
  groupFiatRows,
} from '../lib/alchemy.ts';

const router = Router();

/// Alchemy's `network` value for Sui mainnet — historical alts: `SUI_NETWORK`.
const SUI_NETWORK = 'SUI';

/// Static fallback served when `USE_STUB_CRYPTO_LIST=true`. Same shape as
/// the live Alchemy response so the mobile client doesn't branch.
const STUB_SUI_COINS = [
  { symbol: 'SUI', network: SUI_NETWORK },
  { symbol: 'USDC', network: SUI_NETWORK },
  { symbol: 'USDT', network: SUI_NETWORK },
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
  fiat: z.string().length(3).optional(),
});

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
    const assets = await fetchCryptoList({ fiat: query.fiat });

    const result = assets
      .filter((a) => a.network === SUI_NETWORK && a.buyEnable === 1)
      .map((a) => ({
        symbol: a.crypto,
        network: a.network,
        contractAddress: a.address ?? null,
        icon: a.icon ?? null,
        minPurchaseAmount: a.minPurchaseAmount,
        maxPurchaseAmount: a.maxPurchaseAmount,
      }));

    res.json({ data: result });
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

    const rows = await fetchFiatList({ type: query.type });
    res.json({ data: groupFiatRows(rows) });
  } catch (err) {
    next(err);
  }
});

const QuoteBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  payWayCode: z.string().min(1).optional(),
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

const OrderBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  address: z.string().min(1, 'address (recipient Sui wallet) is required'),
  redirectUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
});

router.post('/order', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = OrderBody.parse(req.body);
    const merchantOrderNo = `sui-onramp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const url = buildHostedRampUrl({
      crypto: body.crypto,
      fiat: body.fiat,
      fiatAmount: body.fiatAmount,
      network: body.network,
      address: body.address,
      redirectUrl: body.redirectUrl,
      callbackUrl: body.callbackUrl,
      merchantOrderNo,
    });

    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as buyRouter };
