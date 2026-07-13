import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';

/**
 * In-process KV store (replaces Redis): access-token jti blacklist, tokenVersion cache, rate-limit counters.
 *
 * Sufficient for single-instance deployment; the interface mirrors Redis (setex/get/del/existsKey/incrWithExpire),
 * so for multi-instance deployments only the internal implementation needs to swap to ioredis — callers stay unchanged.
 *
 * Periodically cleans up expired keys (mirrors the setInterval pattern in auth.service.cleanupExpiredRefreshTokens).
 * Loss on restart: losing the jti blacklist means a logged-out single token revives for its remaining lifetime (≤15min) — acceptable at small scale;
 * losing the tokenVersion cache is harmless (falls back to DB lookup, correctness lives in the DB).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly store = new Map<string, { val: string; expireAt: number }>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  /** The in-memory version is always true (the enabled field is retained so callers' `if(redis.enabled)` logic stays unchanged). */
  readonly enabled = true;

  async onModuleInit() {
    // clean up expired keys every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expireAt <= now) this.store.delete(k);
    }
  }

  async setex(key: string, ttlSec: number, val: string) {
    this.store.set(key, { val, expireAt: Date.now() + ttlSec * 1000 });
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expireAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.val;
  }

  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  /** Fixed-window counter: INCR + first-time EXPIRE, returns the current count (used for rate limiting / brute-force blocking). */
  async incrWithExpire(key: string, ttlSec: number): Promise<number> {
    const cur = await this.get(key);
    const next = (cur ? Number(cur) : 0) + 1;
    await this.setex(key, ttlSec, String(next));
    return next;
  }

  /** Whether a key exists (used for the access jti blacklist; returns a boolean). */
  async existsKey(...keys: string[]): Promise<boolean> {
    const now = Date.now();
    for (const k of keys) {
      const e = this.store.get(k);
      if (e) {
        if (e.expireAt > now) return true;
        this.store.delete(k); // expired — clean up
      }
    }
    return false;
  }
}
