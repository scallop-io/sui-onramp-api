import { z } from 'zod';

const boolFromEnv = z
  .string()
  .transform((v) => v === 'true' || v === '1');

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALCHEMY_PAY_APP_ID: z.string().min(1, 'ALCHEMY_PAY_APP_ID is required'),
  ALCHEMY_PAY_APP_SECRET: z.string().min(1, 'ALCHEMY_PAY_APP_SECRET is required'),
  ALCHEMY_PAY_BASE_URL: z
    .string()
    .url()
    .default('https://openapi.alchemypay.org'),
  USE_STUB_CRYPTO_LIST: boolFromEnv.default('false'),

  // Hosted-ramp redirect/callback are FIXED for our mobile app, so they are set
  // server-side from config — never accepted from the client. This closes the
  // open-redirect/phishing vector (a client could otherwise mint a merchant-
  // signed URL pointing anywhere) and removes the biggest signature-injection
  // input. Optional: when unset, the hosted page uses its own defaults.
  RAMP_REDIRECT_URL: z.string().url().optional(),
  RAMP_CALLBACK_URL: z.string().url().optional(),

  // Logs the HMAC sign input + signature for local signature debugging. Gated
  // behind an explicit flag (NOT NODE_ENV) so signing material is never logged
  // just because a deploy forgot to set NODE_ENV=production. Keep off in prod.
  DEBUG_SIGN: boolFromEnv.default('false'),

  // In-memory per-IP rate limiting. `*_MAX` of 0 disables that limiter. Tune to
  // your client topology — mobile clients behind carrier-grade NAT share IPs,
  // so keep the global limit generous. The write limit guards the signing
  // oracle + the expensive /sell/crypto-list fan-out.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(300),
  RATE_LIMIT_MAX_WRITE: z.coerce.number().int().nonnegative().default(60),

  // TTL for caching the slow-changing list endpoints (especially the per-coin
  // /sell/crypto-list quote fan-out). 0 disables caching.
  CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;
