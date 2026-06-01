import { z } from 'zod';

/// Shared input schemas. Beyond rejecting obviously-bad input, these enforce a
/// security property the hosted-ramp signing relies on: every value that gets
/// concatenated into the signed query string is restricted to a safe character
/// set with NO query delimiters (`&`, `=`, `?`, `#`, whitespace). That makes the
/// signature-canonicalization smuggling (finding SEV-001) unexploitable — an
/// attacker cannot inject a second `address=`/`fiatAmount=` through any field.

/// A Sui address: 0x followed by exactly 32 bytes (64 hex chars). Rejects
/// typos, wrong-chain addresses, and anything containing query delimiters.
export const SuiAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte Sui address');

/// Crypto ticker, e.g. SUI / USDC. Alphanumeric only.
export const CryptoSymbol = z
  .string()
  .regex(/^[A-Za-z0-9]{1,16}$/, 'invalid crypto symbol');

/// Network name, e.g. SUI. Alphanumeric plus `_`/`-`.
export const NetworkName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'invalid network');

/// ISO-4217-style 3-letter fiat code.
export const FiatCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'fiat must be a 3-letter code');

/// Alchemy payment-method code (digits, e.g. 10001).
export const PayWayCode = z
  .string()
  .regex(/^[A-Za-z0-9]{1,16}$/, 'invalid payWayCode');

/// A positive decimal amount as a string. Rejects negatives, zero, scientific
/// notation, hex, and any non-numeric payload.
export const DecimalAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'amount must be a decimal string')
  .refine((v) => Number(v) > 0, 'amount must be greater than zero');
