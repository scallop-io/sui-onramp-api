/// Tiny in-process TTL cache for slow-changing upstream data (crypto/fiat
/// lists). Bounded by key cardinality (a handful of fiats), so no eviction
/// policy beyond TTL expiry is needed. A `ttlMs` of 0 disables caching entirely
/// (every get misses), which is how tests and `CACHE_TTL_MS=0` opt out.
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  // Explicit field + assignment rather than a `constructor(private ttlMs)`
  // parameter property — Node's --experimental-strip-types can't synthesize the
  // assignment and throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at load.
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /// Returns the cached value or computes, stores, and returns it.
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }
}
