import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';

/**
 * 进程内 KV store（替代 Redis）：access-token jti 黑名单、tokenVersion 缓存、限流计数。
 *
 * 单实例部署够用；接口对齐 Redis（setex/get/del/existsKey/incrWithExpire），
 * 未来要多实例时把内部实现换成 ioredis 即可，调用方不动。
 *
 * 简单定时清理过期 key（仿 auth.service.cleanupExpiredRefreshTokens 的 setInterval 模式）。
 * 重启丢失：jti 黑名单丢失意味着已登出的单 token 在剩余寿命(≤15min)内复活——小规模可接受；
 * tokenVersion 缓存丢失无害（回查 DB，正确性在 DB）。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly store = new Map<string, { val: string; expireAt: number }>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  /** 内存版恒为 true（保留 enabled 字段使调用方 `if(redis.enabled)` 逻辑零改动）。 */
  readonly enabled = true;

  async onModuleInit() {
    // 每 5 分钟清理过期 key
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

  /** 固定窗口计数器：INCR + 首次 EXPIRE，返回当前计数（限流 / 暴力封禁用）。 */
  async incrWithExpire(key: string, ttlSec: number): Promise<number> {
    const cur = await this.get(key);
    const next = (cur ? Number(cur) : 0) + 1;
    await this.setex(key, ttlSec, String(next));
    return next;
  }

  /** 键是否存在（access jti 黑名单用，布尔）。 */
  async existsKey(...keys: string[]): Promise<boolean> {
    const now = Date.now();
    for (const k of keys) {
      const e = this.store.get(k);
      if (e) {
        if (e.expireAt > now) return true;
        this.store.delete(k); // 过期清
      }
    }
    return false;
  }
}
