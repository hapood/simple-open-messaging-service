import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';

/**
 * In-process TTL key-value store: SessionToken validation cache (60s TTL — see SessionTokenService) +
 * fixed-window rate-limit counters (ThrottleGuard).
 *
 * Backed by a plain Map (NOT Redis) — single-instance only. The method names mirror Redis
 * (setex/get/del/incrWithExpire) so that going multi-instance only requires swapping this
 * implementation for ioredis; callers stay unchanged.
 *
 * Periodically cleans up expired keys (a 5-minute setInterval). Loss on restart is bounded: the
 * SessionToken cache is a read optimization only (a miss re-reads the DB, where revocation is
 * authoritative), and the rate-limit counters are best-effort — both acceptable at small scale.
 */
@Injectable()
export class KvStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvStoreService.name);
  private readonly store = new Map<string, { val: string; expireAt: number }>();
  private cleanupTimer: NodeJS.Timeout | undefined;

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

  /**
   * Fixed-window counter: INCR within a TTL-bounded window. The TTL is anchored at the FIRST
   * increment of a window and left untouched on subsequent ones, so the window closes at a fixed
   * point regardless of traffic — under sustained load the count resets at the boundary instead of
   * climbing without limit. (Calling setex on every increment would refresh expireAt each time and
   * turn this into a sliding window that never expires while requests keep arriving inside the TTL,
   * permanently 429-ing e.g. a 30s-interval healthcheck probe after ~limit probes.) Returns the
   * current count. Used for rate limiting only.
   */
  async incrWithExpire(key: string, ttlSec: number): Promise<number> {
    const now = Date.now();
    const e = this.store.get(key);
    if (!e || e.expireAt <= now) {
      // New or just-expired window: start the count at 1 and anchor a fresh TTL.
      this.store.set(key, { val: '1', expireAt: now + ttlSec * 1000 });
      return 1;
    }
    const next = Number(e.val) + 1;
    // Preserve the ORIGINAL window end — refreshing the TTL here would make this a sliding window.
    this.store.set(key, { val: String(next), expireAt: e.expireAt });
    return next;
  }
}
