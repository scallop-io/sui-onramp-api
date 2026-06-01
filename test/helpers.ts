import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/// A syntactically valid Sui address (0x + 64 hex) for happy-path tests.
export const VALID_SUI_ADDRESS = `0x${'a'.repeat(64)}`;

/// Boots an Express app on an ephemeral port (0) and returns its base URL plus
/// a close fn. Lets integration tests hit the real middleware/route stack over
/// HTTP without hardcoding a port.
export async function startTestServer(app: Express): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/// Minimal stand-in for the global `fetch`, recording calls and replaying
/// queued responses. alchemy.ts only uses `res.ok`, `res.status`, `res.json()`.
export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export interface MockFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: FetchCall[];
  restore: () => void;
}

export function installMockFetch(
  responses: Array<{ ok?: boolean; status?: number; body: unknown }>,
): MockFetch {
  const original = globalThis.fetch;
  const queue = [...responses];
  const calls: FetchCall[] = [];

  const mock = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { ok: true, status: 200, body: {} };
    const res = {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
    return Promise.resolve(res);
  }) as MockFetch;

  mock.calls = calls;
  mock.restore = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

/// Captures everything written to console.{log,warn,error} during `fn`, so
/// tests can assert on (and scrub-check) emitted log lines. Restores the
/// originals even if `fn` throws.
export async function captureLogs(
  fn: () => void | Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const sink = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return lines;
}

/// Small JSON POST helper returning status + parsed body + the response object
/// (for header assertions).
export async function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}
