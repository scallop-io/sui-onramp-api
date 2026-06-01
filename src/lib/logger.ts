/// Minimal dependency-free structured logger. Emits one JSON object per line
/// (JSON Lines) so logs ingest cleanly into CloudWatch / Datadog / Loki etc.
///
/// Every value passes through `redact()` before it is written, so sensitive
/// fields are stripped even if a future caller forgets to scrub them. This is
/// an audit log for a money-movement API — the safe default is "redact unless
/// explicitly known to be safe".

/// Keys whose values must never reach the logs, matched case-insensitively on
/// the exact key name. `sign` is the Alchemy HMAC signature; `appSecret` is the
/// merchant secret. The rest are defensive (in case auth/secret fields are
/// added later, they're redacted automatically).
const SENSITIVE_KEYS = new Set([
  'sign',
  'secret',
  'appsecret',
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api-key',
  'x-api-key',
  'password',
  'passwd',
  'pwd',
  'mnemonic',
  'privatekey',
  'private-key',
  'seed',
  'passphrase',
]);

const REDACTED = '[redacted]';

/// Defense-in-depth for free-form strings: if a full hosted-ramp URL (or any
/// other signed/secret-bearing URL) is ever logged, strip the signature and
/// token query params from it rather than leaking them.
function scrubString(value: string): string {
  return value.replace(
    /([?&](?:sign|secret|token|apikey|api-key)=)[^&\s]*/gi,
    `$1${REDACTED}`,
  );
}

/// Recursively copy `value`, replacing the value of any sensitive key with
/// `[redacted]`. Bounded depth so a pathological/cyclic object can't hang the
/// logger.
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? REDACTED
        : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogFields = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields: LogFields = {}) => emit('info', msg, fields),
  warn: (msg: string, fields: LogFields = {}) => emit('warn', msg, fields),
  error: (msg: string, fields: LogFields = {}) => emit('error', msg, fields),
};
