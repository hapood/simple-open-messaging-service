import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** Sliding window: only failures within this span count; older ones auto-age-out so a legitimate user's
 *  occasional typos never accumulate into a permanent ban. */
const WINDOW_MS = 15 * 60 * 1000;
/** Reclaim expired entries periodically so a flood of distinct keys (one per attacker IP/account) can't
 *  bloat the maps between lazy reclaims. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Dimension namespaces — opaque keys that partition the failure/ban space so each login method tracks its
 *  own surface without colliding, while sharing storage + admin observability. A single account may be
 *  tracked under several dimensions at once (a password guess and an OTP guess are different attacks with
 *  different entropies), so each gets its own counter and ban. */
export const BAN_DIM_IP = 'ip'; // password-login IP dimension (NAT-shared, lenient)
export const BAN_DIM_USER = 'user'; // password-login account dimension
export const BAN_DIM_OTP = 'otp'; // one-time-code account dimension
/** Dimensions keyed by an account string (cleared together on an account unban — see {@link unban}). */
const ACCOUNT_DIMENSIONS = [BAN_DIM_USER, BAN_DIM_OTP];

/** A failure-count threshold within {@link WINDOW_MS} and the ban duration once exceeded. Steps within a
 *  dimension are ascending; the highest matched tier takes effect (progressive banning). */
export interface BanStep {
  /** Triggers when the within-window failure count is strictly greater than this. */
  count: number;
  /** Ban duration once this tier triggers. */
  banMs: number;
}

/** One ban key passed to {@link BruteForceService.registerFailure} / {@link activeBanUntil}. */
export interface BanKey {
  dimension: string;
  value: string;
}

/** A currently-in-effect ban as surfaced to the admin dashboard. */
export interface BanView {
  /** `${dimension}:${value}` — the canonical key (stable for the admin UI row identity). */
  key: string;
  /** The ban type — which login surface this locks: 'ip' (password-login IP), 'user' (password-login
   *  account), or 'otp' (one-time-code account). The API field is `type` (a stable, deployed name); the
   *  value IS the internal dimension namespace. */
  type: string;
  /** The value within the dimension (an IP string or an account string). */
  value: string;
  /** Absolute ban deadline (ms epoch). */
  until: number;
  /** Milliseconds remaining (convenience for a UI countdown). */
  remainingMs: number;
}

/**
 * Brute-force protection shared across every login method. Each path (password via {@link LocalStrategy},
 * one-time-code via {@link OtpLoginService}) records failures against its own dimensions and thresholds,
 * but they share the storage, the sliding-window expiry, the cleanup timer, and — critically — the admin
 * observability + unban. That closes the gap where an OTP-only account (the mode-2 Android login) could be
 * locked out with no admin recourse: OTP bans now appear in the same ban list and clear with the same unban.
 *
 * Still in-process memory (single instance). Multi-instance shared storage (Redis), tiered responses
 * (CAPTCHA / delay / notify owner), and ban alerting are deferred P3 hardening — the same constraint the
 * password path already documented before this consolidation.
 */
@Injectable()
export class BruteForceService implements OnModuleDestroy {
  // `${dimension}:${value}` → recent failure timestamps within WINDOW_MS
  private readonly _failLog = new Map<string, number[]>();
  // `${dimension}:${value}` → ban deadline (ms epoch)
  private readonly _banned = new Map<string, number>();
  private readonly _timer: NodeJS.Timeout;

  constructor() {
    this._timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // A background reclamation sweep must never keep the process alive on its own — unref so a graceful
    // shutdown / test run exits promptly; OnModuleDestroy clears it on normal module teardown.
    this._timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this._timer);
  }

  /** Record one failure for (dimension, value) under the given ascending steps; return the ban deadline iff a
   *  tier is newly crossed this call (else undefined). Only failures within {@link WINDOW_MS} are counted. */
  registerFailure(dimension: string, value: string, steps: readonly BanStep[]): number | undefined {
    const now = Date.now();
    const key = keyOf(dimension, value);
    const fresh = (this._failLog.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    fresh.push(now);
    this._failLog.set(key, fresh);
    // Highest matched tier wins (steps are ascending; a later tier overwrites an earlier ban deadline).
    let ban: number | undefined;
    for (const s of steps) {
      if (fresh.length > s.count) ban = now + s.banMs;
    }
    if (ban !== undefined) this._banned.set(key, ban);
    return ban;
  }

  /** The latest still-in-effect ban deadline across the given keys (or undefined), reclaiming expired bans
   *  along the way. A caller checking several dimensions (e.g. ip + account) passes all keys; the worst
   *  (latest) deadline governs. */
  activeBanUntil(keys: readonly BanKey[]): number | undefined {
    const now = Date.now();
    let max: number | undefined;
    for (const { dimension, value } of keys) {
      const key = keyOf(dimension, value);
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

  /** On a successful auth, clear one (dimension, value)'s failure log immediately (the window would expire
   *  it anyway, but clearing at once is better UX — a legit user isn't one typo away from a ban). */
  clearFailures(dimension: string, value: string): void {
    this._failLog.delete(keyOf(dimension, value));
  }

  /** All currently in-effect bans across every dimension (admin dashboard). */
  listBans(): BanView[] {
    const now = Date.now();
    const out: BanView[] = [];
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

  /** Admin unban. An IP unban clears only the IP dimension; an account unban clears EVERY account-keyed
   *  dimension (password + OTP) so unbanning a person restores all their login methods at once. Also drops
   *  the cleared keys' failure logs so the within-window count restarts. */
  unban(opts: { ip?: string; account?: string }): void {
    const keys: BanKey[] = [];
    if (opts.ip) keys.push({ dimension: BAN_DIM_IP, value: opts.ip });
    if (opts.account) {
      for (const dim of ACCOUNT_DIMENSIONS) keys.push({ dimension: dim, value: opts.account });
    }
    for (const { dimension, value } of keys) {
      const key = keyOf(dimension, value);
      this._banned.delete(key);
      this._failLog.delete(key);
    }
  }

  /** Periodic reclamation: drop fully-aged failure logs and expired bans so a flood of distinct keys can't
   *  bloat the maps. (The public methods also reclaim lazily; this bounds memory between calls.) */
  private cleanup(): void {
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

function keyOf(dimension: string, value: string): string {
  return `${dimension}:${value}`;
}
