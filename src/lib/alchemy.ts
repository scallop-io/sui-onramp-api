import { createHmac } from "node:crypto";
import { config } from "../config.ts";

/// Path + alpha-sorted query string. Port of Alchemy's reference impl
/// (https://alchemypay.readme.io/docs/api-sign).
function getPath(requestUrl: string): string {
  const uri = new URL(requestUrl);
  const path = uri.pathname;
  const params = Array.from(uri.searchParams.entries());
  if (params.length === 0) return path;
  const sorted = [...params].sort(([a], [b]) => a.localeCompare(b));
  return `${path}?${sorted.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

/// Body string for the HMAC input. Empty for GET / empty objects, else
/// keys sorted alphabetically. Callers must also POST the sorted bytes —
/// see [stableJsonStringify]. Unsorted body → 81003 Invalid Merchant Sign.
function getJsonBody(body: string | undefined): string {
  if (!body) return "";
  try {
    const map = JSON.parse(body);
    if (!map || typeof map !== "object" || Object.keys(map).length === 0)
      return "";
    return stableJsonStringify(map);
  } catch {
    return "";
  }
}

/// JSON.stringify with top-level keys sorted. Not recursive — Alchemy
/// bodies are flat in practice, recursion would mask subtle bugs.
function stableJsonStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function signAlchemyRequest(args: {
  method: "GET" | "POST";
  fullUrl: string;
  body?: string;
}): { sign: string; timestamp: string; appId: string } {
  const timestamp = Date.now().toString();
  const content =
    timestamp +
    args.method.toUpperCase() +
    getPath(args.fullUrl) +
    getJsonBody(args.body);

  const sign = createHmac("sha256", config.ALCHEMY_PAY_APP_SECRET)
    .update(content, "utf8")
    .digest("base64");

  if (config.NODE_ENV !== "production") {
    console.log("[alchemy-sign] content =", JSON.stringify(content));
    console.log("[alchemy-sign] sign    =", sign);
  }

  return { sign, timestamp, appId: config.ALCHEMY_PAY_APP_ID };
}

export interface AlchemyCryptoAsset {
  crypto: string;
  network: string;
  buyEnable: number;
  sellEnable: number;
  minPurchaseAmount: number | null;
  maxPurchaseAmount: number | null;
  address: string | null;
  icon: string | null;
  minSellAmount?: number | null;
  maxSellAmount?: number | null;
}

interface AlchemyEnvelope<T> {
  success?: boolean;
  returnCode?: string;
  returnMsg?: string;
  extend?: string;
  data?: T;
}

export async function fetchCryptoList(params: {
  fiat?: string;
}): Promise<AlchemyCryptoAsset[]> {
  const url = new URL(
    "/open/api/v4/merchant/crypto/list",
    config.ALCHEMY_PAY_BASE_URL,
  );
  if (params.fiat) url.searchParams.set("fiat", params.fiat);

  const auth = signAlchemyRequest({ method: "GET", fullUrl: url.toString() });

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyCryptoAsset[]>;
  if (config.NODE_ENV !== "production") {
    console.log("[alchemy-resp]", res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay cryptoList failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? [];
}

export class AlchemyApiError extends Error {
  // Explicit field + assignment, not a constructor parameter property —
  // Node's --experimental-strip-types can't generate the synthetic
  // assignment, so `constructor(public readonly code)` throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at boot.
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AlchemyApiError";
    this.code = code;
  }
}

// ─── Hosted Ramp URL ─────────────────────────────────────────────────────────

const HOSTED_RAMP_PROD_BASE = "https://ramp.alchemypay.org";
const HOSTED_RAMP_SANDBOX_BASE = "https://ramptest.alchemypay.org";

function isSandbox(): boolean {
  return config.ALCHEMY_PAY_BASE_URL.includes("test");
}

/// Signed hosted-ramp URL. The hosted page uses a different signing
/// algorithm than the merchant API: signInput = `${timestamp}GET/index/rampPageBuy?${sortedQuery}`.
/// See https://alchemypay.readme.io/docs/ramp-signature-description.
///
/// No documented param skips the payment-method picker step — see
/// https://alchemypay.readme.io/docs/on-ramp-custom-parameters.
/// Alchemy's hosted ramp uses different amount params per side. Buy
/// takes `fiatAmount` (what the user pays); sell takes `cryptoAmount`
/// (what they're selling). Sell also ignores `fiat` unless paired with
/// `country`, so we omit fiat there and let the page handle payout
/// selection. See https://alchemypay.readme.io/docs/off-ramp-custom-parameters.
export function buildHostedRampUrl(args: {
  crypto: string;
  network: string;
  fiat?: string;
  fiatAmount?: string;
  cryptoAmount?: string;
  country?: string;
  address?: string;
  redirectUrl?: string;
  callbackUrl?: string;
  merchantOrderNo: string;
  side?: "buy" | "sell";
}): string {
  const timestamp = Date.now().toString();
  const params: Record<string, string> = {
    appId: config.ALCHEMY_PAY_APP_ID,
    crypto: args.crypto,
    merchantOrderNo: args.merchantOrderNo,
    network: args.network,
    showTable: args.side ?? "buy",
    timestamp,
    ...(args.fiat ? { fiat: args.fiat } : {}),
    ...(args.fiatAmount ? { fiatAmount: args.fiatAmount } : {}),
    ...(args.cryptoAmount ? { cryptoAmount: args.cryptoAmount } : {}),
    ...(args.country ? { country: args.country } : {}),
    ...(args.address ? { address: args.address } : {}),
    ...(args.redirectUrl ? { redirectUrl: args.redirectUrl } : {}),
    ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
  };

  // Alpha-sort, raw `k=v&k=v` (no URL encoding inside the signed string).
  const sortedQuery = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signPath =
    args.side === "sell" ? "/index/rampPageSell" : "/index/rampPageBuy";
  const signInput = `${timestamp}GET${signPath}?${sortedQuery}`;
  const sign = createHmac("sha256", config.ALCHEMY_PAY_APP_SECRET)
    .update(signInput, "utf8")
    .digest("base64");

  const base = isSandbox() ? HOSTED_RAMP_SANDBOX_BASE : HOSTED_RAMP_PROD_BASE;
  const finalParams = new URLSearchParams({ ...params, sign });
  return `${base}/?${finalParams.toString()}`;
}

// ─── Quote ───────────────────────────────────────────────────────────────────

export interface AlchemyQuote {
  crypto?: string;
  network?: string;
  fiat?: string;
  cryptoPrice?: string;
  cryptoQuantity?: string;
  rampFee?: string;
  networkFee?: string;
  payWayCode?: string;
}

/// POST /open/api/v4/merchant/order/quote. Body keys: `amount` (not
/// `fiatAmount`, that's hosted-ramp), `side` (not `type`). Wrong keys
/// return 10005 with the offending field in the message.
export async function fetchQuote(params: {
  crypto: string;
  network: string;
  fiat: string;
  fiatAmount: string;
  payWayCode?: string;
  side?: "BUY" | "SELL";
}): Promise<AlchemyQuote> {
  const url = new URL(
    "/open/api/v4/merchant/order/quote",
    config.ALCHEMY_PAY_BASE_URL,
  );

  const requestBody: Record<string, unknown> = {
    crypto: params.crypto,
    network: params.network,
    fiat: params.fiat,
    amount: params.fiatAmount,
    side: params.side ?? "BUY",
    ...(params.payWayCode ? { payWayCode: params.payWayCode } : {}),
  };
  // Stable key order for both sent + signed bytes; mismatch → 81003.
  const bodyString = stableJsonStringify(requestBody);

  const auth = signAlchemyRequest({
    method: "POST",
    fullUrl: url.toString(),
    body: bodyString,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
    body: bodyString,
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyQuote>;
  if (config.NODE_ENV !== "production") {
    console.log("[alchemy-resp]", res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay quote failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? {};
}

/// Probes Alchemy's sell-side quote for the per-coin gross rate
/// (`cryptoPrice`, fiat per coin, before Alchemy's spread + fees).
///
/// Alchemy's quote response also includes `rampFee` (Alchemy's cut, in
/// fiat) and `fiatQuantity` (gross fiat for the probed crypto amount);
/// `cryptoQuantity` is always null on the sell side. Mobile may compute
/// a net rate by subtracting fees if it needs a closer-to-receive figure
/// for the estimate row, but the underlying per-coin reference rate is
/// what we return here.
///
/// Returns null on any failure. The `/sell/crypto-list` caller filters
/// these out so coins for which Alchemy can't quote disappear from the
/// mobile picker entirely.
export async function fetchSellRate(params: {
  crypto: string;
  network: string;
  fiat: string;
}): Promise<string | null> {
  try {
    const quote = await fetchQuote({
      crypto: params.crypto,
      network: params.network,
      fiat: params.fiat,
      // Crypto units for SELL (not fiat — Alchemy's quote endpoint flips
      // the semantics by side). Any reasonable size works; the gross rate
      // is amount-independent.
      fiatAmount: "100",
      side: "SELL",
    });
    return quote.cryptoPrice ?? null;
  } catch (err) {
    if (config.NODE_ENV !== "production") {
      console.log(
        "[alchemy-sell-rate] probe failed for",
        params.crypto,
        params.fiat,
        err,
      );
    }
    return null;
  }
}

// ─── Fiat List ───────────────────────────────────────────────────────────────

/// One row per (currency, payWayCode). Downstream dedupes to unique
/// currencies but keeps the per-method rows nested for the picker.
export interface AlchemyFiatRow {
  currency: string;
  country: string;
  countryName: string;
  payWayCode: string;
  payWayName: string;
  fixedFee: number;
  feeRate: number;
  payMin: number;
  payMax: number;
}

/// Grouped output shape returned by both `/buy/fiat-list` and
/// `/sell/fiat-list`. Mobile parses this shape — never the raw rows
/// directly, because Alchemy returns one row per (currency, payWayCode)
/// and the picker needs them collapsed by fiat with the methods nested.
export interface GroupedFiat {
  code: string;
  country: string;
  countryName: string;
  paymentMethods: Array<{
    payWayCode: string;
    payWayName: string;
    payMin: number;
    payMax: number;
    fixedFee: number;
    feeRate: number;
  }>;
}

/// Collapses Alchemy's flat (currency, payWayCode) rows into one entry per
/// currency with the payment methods nested. Shape kept stable across
/// buy/sell so mobile can use one parser.
export function groupFiatRows(rows: AlchemyFiatRow[]): GroupedFiat[] {
  const byCode = new Map<string, GroupedFiat>();
  for (const r of rows) {
    let entry = byCode.get(r.currency);
    if (!entry) {
      entry = {
        code: r.currency,
        country: r.country,
        countryName: r.countryName,
        paymentMethods: [],
      };
      byCode.set(r.currency, entry);
    }
    entry.paymentMethods.push({
      payWayCode: r.payWayCode,
      payWayName: r.payWayName,
      payMin: r.payMin,
      payMax: r.payMax,
      fixedFee: r.fixedFee,
      feeRate: r.feeRate,
    });
  }
  return Array.from(byCode.values());
}

export async function fetchFiatList(params: {
  type?: "BUY" | "SELL";
}): Promise<AlchemyFiatRow[]> {
  const url = new URL(
    "/open/api/v4/merchant/fiat/list",
    config.ALCHEMY_PAY_BASE_URL,
  );
  url.searchParams.set("type", params.type ?? "BUY");

  const auth = signAlchemyRequest({ method: "GET", fullUrl: url.toString() });

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyFiatRow[]>;
  if (config.NODE_ENV !== "production") {
    console.log("[alchemy-resp]", res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay fiatList failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? [];
}
