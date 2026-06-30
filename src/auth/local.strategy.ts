import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Request } from 'express';

export interface LoginAuthInfo {
  status: number;
  uniqName: string;
  userId?: number;
  bannedUntil?: number;
}

/**
 * 登录暴力破解防护：滑动窗口 + 双维度（IP / 账户）渐进式封禁。
 *
 * 相对原「累计计数 + 仅按 IP」的改进：
 *  - 滑动窗口：只统计 WINDOW_MS 内的失败次数，旧的自动失忆，避免正常用户偶尔输错的累计误封；
 *  - 双维度：按 IP 防分布式扫描、按账户(uniqName)防针对单号的密码暴破（原仅按 IP 防不住后者）；
 *  - 取真实 IP：配合 main.ts 的 trust proxy，反代/隧道下 req.ip 为真实客户端 IP。
 *
 * 仍属进程内内存（单实例）；下列项留待 P3（见 protocol-plan）：
 *  - 多实例共享存储（Redis）；
 *  - 分层响应（CAPTCHA / 增加延迟 / 通知账户所有者）；
 *  - 封禁时长温和化与阈值精调；
 *  - 封禁可观测（结构化日志 / 告警）。
 */

/** 滑动窗口：统计窗口内的失败次数，窗口外的自动失效。 */
const WINDOW_MS = 15 * 60 * 1000; // 15 分钟
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟回收过期条目，防内存膨胀

interface Step {
  count: number; // 窗口内失败次数阈值（>count 触发）
  banMs: number; // 触发后封禁时长
}
interface Dimension {
  prefix: string;
  steps: readonly Step[]; // 升序，命中的最高档生效
}

// 按 IP 阈值宽松（NAT 下多人共享一个公网 IP）；按账户阈值严格（防针对单号的密码暴破）。
// 阶梯沿用原渐进式档位（30min / 3h / 24h），仅计数基础由「累计」改为「窗口内」。
const RULES: Record<'ip' | 'user', Dimension> = {
  ip: {
    prefix: 'ip',
    steps: [
      { count: 10, banMs: 30 * 60 * 1000 },
      { count: 20, banMs: 3 * 60 * 60 * 1000 },
      { count: 40, banMs: 24 * 60 * 60 * 1000 },
    ],
  },
  user: {
    prefix: 'user',
    steps: [
      { count: 5, banMs: 30 * 60 * 1000 },
      { count: 10, banMs: 3 * 60 * 60 * 1000 },
      { count: 20, banMs: 24 * 60 * 60 * 1000 },
    ],
  },
};

@Injectable()
export class LocalStrategy
  extends PassportStrategy(Strategy)
  implements OnModuleDestroy
{
  // key(prefix:value) -> 窗口内失败时间戳列表
  private readonly _failLog = new Map<string, number[]>();
  // key -> 封禁截止时间(ms)
  private readonly _banned = new Map<string, number>();
  private readonly _timer: NodeJS.Timeout;

  constructor(private authService: AuthService) {
    super({
      usernameField: 'uniqName',
      passwordField: 'password',
      passReqToCallback: true,
    });
    this._timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this._timer);
  }

  async validate(
    req: Request,
    uniqName: string,
    password: string,
  ): Promise<LoginAuthInfo> {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

    // 任一维度仍在封禁期 → 直接拒（顺带返回剩余封禁时间供前端提示）
    const bannedUntil = this.activeBanUntil(ip, uniqName);
    if (bannedUntil !== undefined) {
      return { status: 1, uniqName, bannedUntil };
    }

    const user = await this.authService.validateUser(uniqName, password);
    if (user === undefined) {
      // 失败：两个维度各记一笔，按窗口内计数定阶梯封禁，取两者中较晚的截止时间
      const ipBan = this.registerFailure(RULES.ip.prefix, ip, RULES.ip.steps);
      const userBan = this.registerFailure(
        RULES.user.prefix,
        uniqName,
        RULES.user.steps,
      );
      const until = maxDefined(ipBan, userBan);
      return {
        status: 1,
        uniqName,
        ...(until !== undefined ? { bannedUntil: until } : {}),
      };
    }

    // 成功：清除该账户的失败记录（滑动窗口本会过期，即时清除体验更好）。
    // 不清 IP 维度——NAT 下该 IP 可能还有他人正在被计数。
    this._failLog.delete(`${RULES.user.prefix}:${uniqName}`);
    return { status: 0, uniqName, userId: user.id };
  }

  /** 记一次失败，返回若触发封禁的截止时间(否则 undefined)。 */
  private registerFailure(
    prefix: string,
    value: string,
    steps: readonly Step[],
  ): number | undefined {
    const now = Date.now();
    const key = `${prefix}:${value}`;
    const fresh = (this._failLog.get(key) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    fresh.push(now);
    this._failLog.set(key, fresh);

    // 取命中的最高档（steps 升序）
    let ban: number | undefined;
    for (const s of steps) {
      if (fresh.length > s.count) ban = now + s.banMs;
    }
    if (ban !== undefined) this._banned.set(key, ban);
    return ban;
  }

  /** 返回当前仍在封禁期的最晚截止时间(无则 undefined)，顺带回收过期封禁。 */
  private activeBanUntil(ip: string, uniqName: string): number | undefined {
    const now = Date.now();
    let max: number | undefined;
    for (const key of [
      `${RULES.ip.prefix}:${ip}`,
      `${RULES.user.prefix}:${uniqName}`,
    ]) {
      const until = this._banned.get(key);
      if (until === undefined) continue;
      if (until > now) {
        max = max === undefined ? until : Math.max(max, until);
      } else {
        this._banned.delete(key);
      }
    }
    return max;
  }

  /** 列当前未过期封禁（admin 看板用）。 */
  listBans(): Array<{ key: string; type: string; value: string; until: number; remainingMs: number }> {
    const now = Date.now();
    const out: Array<{ key: string; type: string; value: string; until: number; remainingMs: number }> = [];
    for (const [key, until] of this._banned) {
      if (until > now) {
        const idx = key.indexOf(':');
        out.push({
          key,
          type: key.slice(0, idx),
          value: key.slice(idx + 1),
          until,
          remainingMs: until - now,
        });
      }
    }
    return out;
  }

  /** 解封（admin 用）：清指定 IP 和/或账户的封禁 + 失败记录。 */
  clearBan(opts: { ip?: string; uniqName?: string }) {
    if (opts.ip) {
      this._banned.delete(`${RULES.ip.prefix}:${opts.ip}`);
      this._failLog.delete(`${RULES.ip.prefix}:${opts.ip}`);
    }
    if (opts.uniqName) {
      this._banned.delete(`${RULES.user.prefix}:${opts.uniqName}`);
      this._failLog.delete(`${RULES.user.prefix}:${opts.uniqName}`);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, list] of this._failLog) {
      const fresh = list.filter((t) => now - t < WINDOW_MS);
      if (fresh.length === 0) this._failLog.delete(key);
      else this._failLog.set(key, fresh);
    }
    for (const [key, until] of this._banned) {
      if (until <= now) this._banned.delete(key);
    }
  }
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
