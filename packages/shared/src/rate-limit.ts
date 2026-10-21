/**
 * Token-bucket rate limiter. Time source is injectable for deterministic tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Tokens currently available (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** True once the bucket has fully refilled (useful for evicting idle keys). */
  isFull(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
  }
}

/**
 * Keyed token buckets with a hard cap on tracked keys, so an attacker cycling
 * keys cannot grow memory without bound. When full, idle (fully refilled)
 * buckets are evicted first; if none are idle the request is refused.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, maxKeys = 10_000, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  tryTake(key: string, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys && !this.evictIdle()) return false;
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.tryTake(cost);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictIdle(): boolean {
    let evicted = false;
    for (const [k, b] of this.buckets) {
      if (b.isFull()) {
        this.buckets.delete(k);
        evicted = true;
      }
    }
    return evicted;
  }
}
