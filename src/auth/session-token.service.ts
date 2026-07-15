import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { KvStoreService } from '../kv-store/kv-store.service.js';

/** Web session deadline + how long it slides forward on each (throttled) use. Active web sessions
 *  stay alive indefinitely; an idle one expires 30 days after its last request. Native-app tokens
 *  carry no deadline (Telegram-style — revocation-only). */
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Throttle for the activity+sliding write: refresh lastSeenAt/lastSeenIp (all clients) and extend
 *  the web/desktop deadline at most once per 5 minutes per token, so validate() never writes to the DB
 *  on every request — only on a cache miss past this interval. */
const WEB_SESSION_SLIDING_TOUCH_MS = 5 * 60 * 1000;
/** KV-cache a successful validation for 60s (parity with the access-token `tver` cache) so the hot
 *  REST path doesn't hit the DB per request. Revocation propagates within this window (revoke() dels
 *  the key for a presented token; logout-all relies on the 60s TTL — acceptable lag, matches today). */
const VALIDATE_CACHE_TTL_SEC = 60;
const CACHE_PREFIX = 'session:';

/** Client kind selects the token's lifetime policy at issue time. 'app' (native) → no-expiry;
 *  'web' (browser) + 'desktop' (Tauri) → sliding 30-day. Persisted on the row so the device list can
 *  render an icon/label per credential and so per-client behavior (which sessions expire) is auditable. */
export type SessionClient = 'app' | 'web' | 'desktop';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues + validates long-lived, revocable, per-device session credentials (the single credential that
 * replaces the legacy access+refresh pair). Stores only the sha256 hash; the plaintext is returned once,
 * generalized to:
 *  - a nullable `expiresAt` (app = never; web = sliding 30d);
 *  - a `lastSeenAt` sliding-window tracker for web;
 *  - a 60s KV cache so validation is cheap on the hot path.
 *
 * Used by {@link BearerAuthService}, which is the single source of truth shared by the global
 * JwtAuthGuard and the /uploads/* media preHandler — so a session token grants identical access on
 * the API and on media, and revoking it (logout / logout-all / password change / admin disable) cuts
 * both at once.
 */
@Injectable()
export class SessionTokenService {
  private readonly logger = new Logger(SessionTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kvStore: KvStoreService,
  ) {}

  /**
   * Mint a session token. `client:'app'` → `expiresAt=null` (no lifecycle; the native client stores it
   * in OS secure storage and it is valid until explicitly revoked). `client:'web'` → `expiresAt=now+30d`,
   * sliding (extended on use). The plaintext is returned ONCE; only the sha256 hash is stored. Prior
   * tokens are NOT revoked — a user may have several (one per device); each is independently revocable.
   */
  async issue(
    userId: number,
    client: SessionClient,
    opts: { device?: string; userAgent?: string; ip?: string } = {},
  ): Promise<string> {
    const plaintext = randomBytes(32).toString('hex');
    const expiresAt =
      client === 'app' ? null : new Date(Date.now() + WEB_SESSION_TTL_MS);
    await this.prisma.sessionToken.create({
      data: {
        userId,
        tokenHash: hashToken(plaintext),
        client,
        device: opts.device ?? null,
        userAgent: opts.userAgent ?? null,
        ip: opts.ip ?? null,
        lastSeenIp: opts.ip ?? null,
        expiresAt,
      },
    });
    return plaintext;
  }

  /**
   * Validate a presented token. Returns `{ userId, sessionId }` on success (the row id lets the device
   * list flag the requesting session as "current"), null otherwise (not-found / revoked / expired).
   * The hash lookup is constant-time-ish via the unique index. KV-cached for 60s; on a cache miss the
   * session's activity is refreshed — `lastSeenAt` + `lastSeenIp` update for EVERY client (so the
   * device list's "last active" stays fresh even for no-expiry app tokens), and web/desktop deadlines
   * additionally slide forward. Both writes are throttled to once per
   * {@link WEB_SESSION_SLIDING_TOUCH_MS} so validate() never writes on every request; a failed write
   * can't invalidate an otherwise-valid token (fire-and-forget).
   */
  async validate(
    raw: string,
    opts: { ip?: string | null } = {},
  ): Promise<{ userId: number; sessionId: number } | null> {
    const h = hashToken(raw);
    const key = `${CACHE_PREFIX}${h}`;

    const cached = await this.kvStore.get(key).catch(() => null);
    if (cached !== null) {
      const entry = JSON.parse(cached) as {
        userId: number;
        sessionId?: number;
        exp: number | null;
      };
      // sessionId present guards a stale pre-upgrade cache shape (no sessionId) → treat as a miss and
      // fall through to the DB. An expired entry likewise falls through.
      if (
        entry.sessionId !== undefined &&
        !(entry.exp !== null && entry.exp <= Date.now())
      ) {
        return { userId: entry.userId, sessionId: entry.sessionId };
      }
    }

    const rec = await this.prisma.sessionToken.findUnique({
      where: { tokenHash: h },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
      },
    });
    if (!rec || rec.revokedAt !== null) return null;
    const exp = rec.expiresAt?.getTime() ?? null;
    if (exp !== null && exp <= Date.now()) return null;

    // Activity refresh (all clients) + sliding deadline (web/desktop only), throttled to once per
    // WEB_SESSION_SLIDING_TOUCH_MS. lastSeenAt/lastSeenIp feed the device list's "last active" +
    // location; the deadline slide keeps active web/desktop sessions alive while idle ones expire.
    let cachedExp = exp;
    if (Date.now() - rec.lastSeenAt.getTime() > WEB_SESSION_SLIDING_TOUCH_MS) {
      const data: { lastSeenAt: Date; lastSeenIp?: string; expiresAt?: Date } = {
        lastSeenAt: new Date(),
      };
      if (opts.ip) data.lastSeenIp = opts.ip;
      if (exp !== null) {
        cachedExp = Date.now() + WEB_SESSION_TTL_MS;
        data.expiresAt = new Date(cachedExp);
      }
      this.prisma.sessionToken
        .update({ where: { tokenHash: h }, data })
        .catch((e) =>
          this.logger.warn(`activity/sliding-touch write failed (non-fatal): ${String(e)}`),
        );
    }
    await this.kvStore
      .setex(
        key,
        VALIDATE_CACHE_TTL_SEC,
        JSON.stringify({ userId: rec.userId, sessionId: rec.id, exp: cachedExp }),
      )
      .catch(() => {});
    return { userId: rec.userId, sessionId: rec.id };
  }

  /** Revoke a single presented token (self-revoke on logout). Idempotent — a not-found or
   *  already-revoked token is a no-op so device logout is resilient to retries / stale state. */
  async revoke(raw: string): Promise<void> {
    const h = hashToken(raw);
    await this.prisma.sessionToken.updateMany({
      where: { tokenHash: h, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
    await this.kvStore.del(`${CACHE_PREFIX}${h}`).catch(() => {});
  }

  /** Revoke a session by its row id — the device-list "revoke this device" path, where the caller has
   *  the row id (shown in the list) but not the raw token. Ownership-checked: only a row belonging to
   *  `userId` and still active is touched, so a user can't revoke another user's session by guessing an
   *  id. Idempotent (a not-found / already-revoked / foreign row is a no-op). The KV entry is dropped by
   *  the row's `tokenHash` so the revocation lands within the 60s window instead of waiting for TTL.
   *  Returns true iff a row was actually revoked (lets the caller distinguish "revoked" from "no-op"). */
  async revokeById(userId: number, sessionId: number): Promise<boolean> {
    const rec = await this.prisma.sessionToken.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: { tokenHash: true },
    });
    if (!rec) return false;
    await this.prisma.sessionToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokeReason: 'device_revoke' },
    });
    await this.kvStore.del(`${CACHE_PREFIX}${rec.tokenHash}`).catch(() => {});
    return true;
  }

  /** Revoke ALL of the user's session tokens — called on logout-all / password change / admin disable
   *  (invalidateAllSessions) so every device loses access in one move. Per-token KV entries are left to
   *  expire (60s) — we can't enumerate them by userId; the live SSE connection is dropped immediately
   *  by the `auth.sessions-invalidated` → FORCE_LOGOUT handler regardless. */
  async revokeAllForUser(userId: number, reason = 'all_devices'): Promise<void> {
    await this.prisma.sessionToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }
}
