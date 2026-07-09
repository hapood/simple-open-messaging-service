import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';

export interface LoginAuthInfo {
  status: number;
  account: string;
  userId?: number;
  bannedUntil?: number;
}

/**
 * Login brute-force protection: sliding window + dual-dimension (IP / account) progressive banning.
 *
 * Improvements over the original "cumulative count + IP-only" approach:
 *  - Sliding window: only counts failures within WINDOW_MS; older ones auto-age-out, avoiding false bans from a legitimate user's occasional typos accumulating;
 *  - Dual dimension: by IP defends against distributed scanning, by account defends against password brute-force targeting a single account (the original IP-only approach could not stop the latter);
 *  - Real client IP: combined with the FastifyAdapter trustProxy in main.ts, req.ip is the real client IP behind reverse proxies/tunnels.
 *
 * Still in-process memory (single instance); the following are deferred to P3 (see protocol-plan):
 *  - Multi-instance shared storage (Redis);
 *  - Tiered responses (CAPTCHA / added delay / notify the account owner);
 *  - Softening ban durations and fine-tuning thresholds;
 *  - Ban observability (structured logs / alerting).
 */

/** Sliding window: counts failures within the window; those outside the window auto-expire. */
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Reclaim expired entries every 5 minutes to prevent memory bloat

interface Step {
  count: number; // Failure-count threshold within the window (triggers when >count)
  banMs: number; // Ban duration once triggered
}
interface Dimension {
  prefix: string;
  steps: readonly Step[]; // Ascending; the highest matched tier takes effect
}

// IP thresholds are lenient (multiple users may share one public IP under NAT); account thresholds are strict (to defend against password brute-force targeting a single account).
// The tiered steps reuse the original progressive tiers (30min / 3h / 24h); only the counting basis changed from "cumulative" to "within-window".
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
  // key(prefix:value) -> list of failure timestamps within the window
  private readonly _failLog = new Map<string, number[]>();
  // key -> ban deadline (ms)
  private readonly _banned = new Map<string, number>();
  private readonly _timer: NodeJS.Timeout;

  constructor(private authService: AuthService) {
    super({
      usernameField: 'account',
      passwordField: 'password',
      passReqToCallback: true,
    });
    this._timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this._timer);
  }

  async validate(
    req: FastifyRequest,
    account: string,
    password: string,
  ): Promise<LoginAuthInfo> {
    // FastifyRequest exposes `.ip` (honors the adapter's trustProxy); `.socket` does not exist
    // on it, so the raw Node socket is the fallback.
    const ip = req.ip ?? req.raw?.socket?.remoteAddress ?? 'unknown';

    // If either dimension is still in its ban window -> reject outright (also return the remaining ban time for the client to display)
    const bannedUntil = this.activeBanUntil(ip, account);
    if (bannedUntil !== undefined) {
      return { status: 1, account, bannedUntil };
    }

    const user = await this.authService.validateUser(account, password);
    if (user === undefined) {
      // Failure: record one count in each dimension, determine the tiered ban by the within-window count, and take the later of the two deadlines
      const ipBan = this.registerFailure(RULES.ip.prefix, ip, RULES.ip.steps);
      const userBan = this.registerFailure(
        RULES.user.prefix,
        account,
        RULES.user.steps,
      );
      const until = maxDefined(ipBan, userBan);
      return {
        status: 1,
        account,
        ...(until !== undefined ? { bannedUntil: until } : {}),
      };
    }

    // Success: clear this account's failure log (the sliding window would expire it anyway, but clearing immediately is a better UX).
    // Do not clear the IP dimension — under NAT, that IP may have other people still being counted.
    this._failLog.delete(`${RULES.user.prefix}:${account}`);
    return { status: 0, account, userId: user.id };
  }

  /** Record one failure; return the ban deadline if a ban is triggered (otherwise undefined). */
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

    // Take the highest matched tier (steps are ascending)
    let ban: number | undefined;
    for (const s of steps) {
      if (fresh.length > s.count) ban = now + s.banMs;
    }
    if (ban !== undefined) this._banned.set(key, ban);
    return ban;
  }

  /** Return the latest deadline among bans still in effect (or undefined), reclaiming expired bans along the way. */
  private activeBanUntil(ip: string, account: string): number | undefined {
    const now = Date.now();
    let max: number | undefined;
    for (const key of [
      `${RULES.ip.prefix}:${ip}`,
      `${RULES.user.prefix}:${account}`,
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

  /** List currently non-expired bans (for the admin dashboard). */
  listBans(): Array<{
    key: string;
    type: string;
    value: string;
    until: number;
    remainingMs: number;
  }> {
    const now = Date.now();
    const out: Array<{
      key: string;
      type: string;
      value: string;
      until: number;
      remainingMs: number;
    }> = [];
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

  /** Unban (admin use): clear bans + failure logs for a specified IP and/or account. */
  clearBan(opts: { ip?: string; account?: string }) {
    if (opts.ip) {
      this._banned.delete(`${RULES.ip.prefix}:${opts.ip}`);
      this._failLog.delete(`${RULES.ip.prefix}:${opts.ip}`);
    }
    if (opts.account) {
      this._banned.delete(`${RULES.user.prefix}:${opts.account}`);
      this._failLog.delete(`${RULES.user.prefix}:${opts.account}`);
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
