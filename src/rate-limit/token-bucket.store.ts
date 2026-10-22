export interface TokenBucketConfig {
  ratePerSecond: number;
  burst: number;
}

export interface TokenBucketDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
  lastSeenMs: number;
}

/** In-process token buckets for the deliberately single-instance server. All time values are monotonic. */
export class TokenBucketStore {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxBuckets = 100_000,
    private readonly idleTtlMs = 15 * 60 * 1000,
  ) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
      throw new Error('maxBuckets must be a positive integer');
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0)
      throw new Error('idleTtlMs must be positive');
  }

  consume(
    key: string,
    config: TokenBucketConfig,
    cost: number,
    nowMs: number,
  ): TokenBucketDecision {
    validateConfig(config, cost, nowMs);
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs - bucket.lastSeenMs >= this.idleTtlMs) {
      this.ensureCapacity(nowMs);
      bucket = {
        tokens: config.burst,
        updatedAtMs: nowMs,
        lastSeenMs: nowMs,
      };
    }

    const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
    const replenished = Math.min(
      config.burst,
      bucket.tokens + (elapsedMs / 1000) * config.ratePerSecond,
    );
    const allowed = replenished >= cost;
    const tokens = allowed ? replenished - cost : replenished;
    bucket.tokens = tokens;
    bucket.updatedAtMs = nowMs;
    bucket.lastSeenMs = nowMs;
    this.buckets.set(key, bucket);

    const deficit = allowed ? 0 : cost - tokens;
    return {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterMs: Math.ceil((deficit / config.ratePerSecond) * 1000),
    };
  }

  cleanup(nowMs: number): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastSeenMs >= this.idleTtlMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  private ensureCapacity(nowMs: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    this.cleanup(nowMs);
    if (this.buckets.size < this.maxBuckets) return;

    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeenMs < oldestSeen) {
        oldestKey = key;
        oldestSeen = bucket.lastSeenMs;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

function validateConfig(
  config: TokenBucketConfig,
  cost: number,
  nowMs: number,
): void {
  if (!Number.isFinite(config.ratePerSecond) || config.ratePerSecond <= 0)
    throw new Error('ratePerSecond must be positive');
  if (!Number.isFinite(config.burst) || config.burst <= 0)
    throw new Error('burst must be positive');
  if (!Number.isFinite(cost) || cost <= 0 || cost > config.burst)
    throw new Error('cost must be positive and no greater than burst');
  if (!Number.isFinite(nowMs) || nowMs < 0)
    throw new Error('nowMs must be a non-negative monotonic timestamp');
}
