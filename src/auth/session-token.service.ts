import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { KvStoreService } from '../kv-store/kv-store.service.js';

/** Untrusted-session deadline + how long it slides forward on each (throttled) use. Active sessions
 *  stay alive indefinitely; an idle one expires 14 days after its last request. TRUSTED-device tokens
 *  (the native app, or a desktop that opted in via OS keyring) carry no deadline (Telegram-style —
 *  revocation-only); their `lastSeenAt` activity tracking still runs (the sliding-window capability is
 *  retained) but `expiresAt` is never set. */
const WEB_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Throttle for the activity+sliding write: refresh lastSeenAt/lastSeenIp (all clients) and extend
 *  the web/desktop deadline at most once per 5 minutes per token. Persistent cache entries carry the
 *  next touch deadline, so validate() does not write to the DB on every request. */
const WEB_SESSION_SLIDING_TOUCH_MS = 5 * 60 * 1000;
const CACHE_PREFIX = 'session:';

interface SessionCacheEntry {
  userId: number;
  sessionId: number;
  exp: number | null;
  persistent: boolean;
  mustChangePassword: boolean;
  nextTouchAt: number;
}

function encodeCacheEntry(entry: SessionCacheEntry): string {
  return JSON.stringify(entry);
}

/** Client kind = the device platform ('app' native / 'web' browser / 'desktop' Tauri). Persisted on the
 *  row so the device list can render an icon/label per credential. It is INFORMATIONAL only — the
 *  token's lifetime is driven by `trusted`, not `client` (see {@link issue}). The native `app` client
 *  is trusted by default (its token lives in OS secure storage). */
export type SessionClient = 'app' | 'web' | 'desktop';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues + validates long-lived, revocable, per-device session credentials (the single credential that
 * replaces the legacy access+refresh pair). Stores only the sha256 hash; the plaintext is returned once,
 * generalized to:
 *  - a nullable `expiresAt` (app = never; web = sliding 14d);
 *  - a `lastSeenAt` sliding-window tracker for web;
 *  - an issue-initialized validation cache so the hot REST path avoids a DB read.
 *
 * Used by {@link BearerAuthService}, which is the single source of truth shared by the global
 * SessionAuthGuard and the /uploads/* media preHandler — so a session token grants identical access on
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
   * Mint a session token. Lifetime is driven by `trusted`, not by platform: a TRUSTED device (token
   * stored in OS secure storage) → `expiresAt=null` (no lifecycle; valid until explicitly revoked); an
   * UNTRUSTED device → `expiresAt=now+14d`, sliding (extended on use). `trusted` defaults to
   * `client === 'app'` (the native app stores its token in OS secure storage, so it is trusted by
   * default); a `desktop` client is trusted only when the caller opts in (it has OS keyring storage and
   * the user chose "trust this device"); `web` is never trusted (a browser can't store a bearer token
   * in OS secure storage). `persistent` (untrusted web/desktop) selects a 14-day cookie ("keep me
   * logged in") vs a session cookie — only persistent cookies are refreshed on slide. The plaintext is
   * returned ONCE; only the sha256 hash is stored. Prior tokens are NOT revoked — a user may have
   * several (one per device, including multiple trusted devices); each is independently revocable.
   */
  async issue(
    userId: number,
    client: SessionClient,
    opts: { device?: string; userAgent?: string; ip?: string; persistent?: boolean; trusted?: boolean } = {},
  ): Promise<string> {
    const plaintext = randomBytes(32).toString('hex');
    // Lifetime by trust, not platform: the native app is trusted by default; a desktop opts in; web never.
    const trusted = opts.trusted ?? (client === 'app');
    const expiresAt = trusted ? null : new Date(Date.now() + WEB_SESSION_TTL_MS);
    const tokenHash = hashToken(plaintext);
    const persistent = opts.persistent ?? true;
    const created = await this.prisma.sessionToken.create({
      data: {
        userId,
        tokenHash,
        client,
        device: opts.device ?? null,
        userAgent: opts.userAgent ?? null,
        ip: opts.ip ?? null,
        lastSeenIp: opts.ip ?? null,
        expiresAt,
        persistent,
        trusted,
      },
      select: {
        id: true,
        user: { select: { mustChangePassword: true } },
      },
    });
    await this.kvStore
      .initPersistent(
        `${CACHE_PREFIX}${tokenHash}`,
        encodeCacheEntry({
          userId,
          sessionId: created.id,
          exp: expiresAt?.getTime() ?? null,
          persistent,
          mustChangePassword: created.user.mustChangePassword,
          nextTouchAt: Date.now() + WEB_SESSION_SLIDING_TOUCH_MS,
        }),
        expiresAt?.getTime() ?? null,
      )
      .catch(() => {});
    return plaintext;
  }

  /**
   * Validate a presented token. Returns `{ userId, sessionId, slid, persistent }` on success (the row
   * id lets the device list flag the requesting session as "current"; `slid` signals the untrusted
   * deadline moved this call — the auth guard uses it to re-issue the browser cookie; `persistent` is
   * the cookie-persistence choice), or null (not-found / revoked / expired). The cache is initialized
   * only by issue(); validate may update an existing entry after an activity/sliding touch but never
   * recreates a missing entry. That contract makes revoke deletion final even when a validation DB read
   * was already in flight: its update fails instead of resurrecting the deleted cache entry.
   */
  async validate(
    raw: string,
    opts: { ip?: string | null } = {},
  ): Promise<{ userId: number; sessionId: number; slid: boolean; persistent: boolean; mustChangePassword: boolean } | null> {
    const h = hashToken(raw);
    const key = `${CACHE_PREFIX}${h}`;

    const cached = await this.kvStore.getPersistent(key).catch(() => null);
    const cacheExistedAtStart = cached !== null;
    if (cached !== null) {
      const entry = JSON.parse(cached) as SessionCacheEntry;
      if (entry.nextTouchAt > Date.now()) {
        return {
          userId: entry.userId,
          sessionId: entry.sessionId,
          slid: false,
          persistent: entry.persistent,
          mustChangePassword: entry.mustChangePassword,
        };
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
        persistent: true,
        user: { select: { mustChangePassword: true } },
      },
    });
    if (!rec || rec.revokedAt !== null) return null;
    const exp = rec.expiresAt?.getTime() ?? null;
    if (exp !== null && exp <= Date.now()) return null;

    // Activity refresh (all clients) + sliding deadline (untrusted only), throttled by nextTouchAt in
    // the persistent cache. A cache miss (for example after a process restart) still validates against
    // the database, but deliberately does not recreate the cache: only issue() has create semantics.
    let cachedExp = exp;
    let slid = false;
    let nextTouchAt = Date.now() + WEB_SESSION_SLIDING_TOUCH_MS;
    if (Date.now() - rec.lastSeenAt.getTime() > WEB_SESSION_SLIDING_TOUCH_MS) {
      const data: { lastSeenAt: Date; lastSeenIp?: string; expiresAt?: Date } = {
        lastSeenAt: new Date(),
      };
      if (opts.ip) data.lastSeenIp = opts.ip;
      if (exp !== null) {
        cachedExp = Date.now() + WEB_SESSION_TTL_MS;
        data.expiresAt = new Date(cachedExp);
        slid = true;
      }
      try {
        await this.prisma.sessionToken.update({ where: { tokenHash: h }, data });
      } catch (e) {
        // Authentication is still valid according to the authoritative row just read. Do not claim a
        // slide or refresh the cookie when persistence failed; leave nextTouchAt due so a later request
        // retries the touch.
        this.logger.warn(`activity/sliding-touch write failed (non-fatal): ${String(e)}`);
        cachedExp = exp;
        slid = false;
        nextTouchAt = Date.now();
      }
    }

    if (cacheExistedAtStart) {
      const updated = await this.kvStore
        .updatePersistent(
          key,
          encodeCacheEntry({
          userId: rec.userId,
          sessionId: rec.id,
          exp: cachedExp,
          persistent: rec.persistent,
          mustChangePassword: rec.user.mustChangePassword,
            nextTouchAt,
          }),
          cachedExp,
        )
        .catch(() => false);
      // A state-changing operation deleted the entry while the DB work above was in flight. Re-read
      // authoritatively with cache-create disabled: revoke now returns null, while a non-revoking change
      // such as setPassword returns the fresh principal instead of causing a spurious logout.
      if (!updated) return this.validate(raw, opts);
    }
    return { userId: rec.userId, sessionId: rec.id, slid, persistent: rec.persistent, mustChangePassword: rec.user.mustChangePassword };
  }

  /** Revoke a single presented token (self-revoke on logout). Idempotent — a not-found or
   *  already-revoked token is a no-op so device logout is resilient to retries / stale state. */
  async revoke(raw: string): Promise<void> {
    const h = hashToken(raw);
    await this.prisma.sessionToken.updateMany({
      where: { tokenHash: h, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
    await this.kvStore.delPersistent(`${CACHE_PREFIX}${h}`).catch(() => {});
  }

  /** Revoke a session by its row id — the device-list "revoke this device" path, where the caller has
   *  the row id (shown in the list) but not the raw token. Ownership-checked: only a row belonging to
   *  `userId` and still active is touched, so a user can't revoke another user's session by guessing an
   *  id. Idempotent (a not-found / already-revoked / foreign row is a no-op). The persistent validation
   *  entry is dropped by the row's tokenHash, immediately preventing further cache authentication.
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
    await this.kvStore.delPersistent(`${CACHE_PREFIX}${rec.tokenHash}`).catch(() => {});
    return true;
  }

  /** Revoke ALL of the user's session tokens and delete each corresponding persistent validation entry. */
  async revokeAllForUser(userId: number, reason = 'all_devices'): Promise<void> {
    const sessions = await this.prisma.sessionToken.findMany({
      where: { userId, revokedAt: null },
      select: { tokenHash: true },
    });
    await this.prisma.sessionToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    if (sessions.length > 0) {
      await this.kvStore
        .delPersistent(
          ...sessions.map(({ tokenHash }) => `${CACHE_PREFIX}${tokenHash}`),
        )
        .catch(() => {});
    }
  }

  /** Resolve the row id of a freshly-issued plaintext token (hashing it the same way {@link issue} does).
   *  Used by OTP/QR login to record the produced session id on an audit row WITHOUT changing issue()'s
   *  return shape. The row exists immediately after issue()'s create, so this never misses. */
  async idOfToken(raw: string): Promise<number | null> {
    const rec = await this.prisma.sessionToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { id: true },
    });
    return rec?.id ?? null;
  }

  /** Drop the validate-cache entry for a session row (looked up by id) so the NEXT validate() re-reads the
   *  DB. Used when a mutation changes a field that lives in that cache WITHOUT invalidating the session —
   *  specifically {@link AuthService.setPassword} clearing `mustChangePassword`: unlike changePassword /
   *  generateInitialPassword (which revoke all sessions, so stale caches die with them), setPassword KEEPS
   *  this session, so the issue-initialized entry must be removed when that flag changes. */
  async bustCacheBySessionId(sessionId: number): Promise<void> {
    const rec = await this.prisma.sessionToken.findUnique({
      where: { id: sessionId },
      select: { tokenHash: true },
    });
    if (rec) {
      await this.kvStore
        .delPersistent(`${CACHE_PREFIX}${rec.tokenHash}`)
        .catch(() => {});
    }
  }
}
