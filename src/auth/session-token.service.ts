import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { sessionToken, user, userPreference } from '../database/schema.js';
import { KvStoreService } from '../kv-store/kv-store.service.js';
import {
  AUTO_TERMINATE_PREFERENCE_KEY,
  DEFAULT_AUTO_TERMINATE_DAYS,
  isAutoTerminateDays,
  type AutoTerminateDays,
} from './session-policy.js';

/** Throttle for the activity+sliding write: refresh lastSeenAt/lastSeenIp (all clients) and extend
 *  the inactivity deadline at most once per 5 minutes per token. Persistent cache entries carry the
 *  next touch deadline, so validate() does not write to the DB on every request. */
const WEB_SESSION_SLIDING_TOUCH_MS = 5 * 60 * 1000;
const CACHE_PREFIX = 'session:';

interface SessionCacheEntry {
  userId: number;
  sessionId: number;
  exp: number;
  autoTerminateDays: AutoTerminateDays;
  mustChangePassword: boolean;
  nextTouchAt: number;
}

function encodeCacheEntry(entry: SessionCacheEntry): string {
  return JSON.stringify(entry);
}

/** Client kind = the device platform ('app' native / 'web' browser / 'desktop' Tauri). Persisted on the
 *  row so the device list can render an icon/label per credential. It is INFORMATIONAL only — the
 *  client value does not affect the session lifetime policy. */
export type SessionClient = 'app' | 'web' | 'desktop';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues + validates long-lived, revocable, per-device session credentials (the single credential that
 * replaces the legacy access+refresh pair). Stores only the sha256 hash; the plaintext is returned once,
 * generalized to:
 *  - a required sliding `expiresAt` for every client;
 *  - a `lastSeenAt` activity tracker;
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
    private readonly database: DatabaseService,
    private readonly kvStore: KvStoreService,
  ) {}

  /** Mint a session token using the user's inactivity policy (30 days by default). Client is metadata
   * only. The plaintext is returned once; only its sha256 hash is stored. */
  async issue(
    userId: number,
    client: SessionClient,
    opts: {
      device?: string;
      userAgent?: string;
      ip?: string;
    } = {},
  ): Promise<string> {
    const plaintext = randomBytes(32).toString('hex');
    const tokenHash = hashToken(plaintext);
    const [principal, preference] = await Promise.all([
      this.database.db
        .select({ mustChangePassword: user.mustChangePassword })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)
        .then((rows) => rows[0]),
      this.database.db
        .select({ value: userPreference.value })
        .from(userPreference)
        .where(
          and(
            eq(userPreference.userId, userId),
            eq(userPreference.key, AUTO_TERMINATE_PREFERENCE_KEY),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!principal) throw new Error('session issue failed');
    const autoTerminateDays = isAutoTerminateDays(preference?.value)
      ? preference.value
      : DEFAULT_AUTO_TERMINATE_DAYS;
    const expiresAt = new Date(
      Date.now() + autoTerminateDays * 24 * 60 * 60 * 1000,
    );
    const created = await this.database.db
      .insert(sessionToken)
      .values({
        userId,
        tokenHash,
        client,
        device: opts.device ?? null,
        userAgent: opts.userAgent ?? null,
        ip: opts.ip ?? null,
        lastSeenIp: opts.ip ?? null,
        expiresAt,
        autoTerminateDays,
      })
      .returning({ id: sessionToken.id })
      .then((rows) => rows[0]);
    if (!created) throw new Error('session issue failed');
    await this.kvStore
      .initPersistent(
        `${CACHE_PREFIX}${tokenHash}`,
        encodeCacheEntry({
          userId,
          sessionId: created.id,
          exp: expiresAt.getTime(),
          autoTerminateDays,
          mustChangePassword: principal.mustChangePassword,
          nextTouchAt: Date.now() + WEB_SESSION_SLIDING_TOUCH_MS,
        }),
        expiresAt.getTime(),
      )
      .catch(() => {});
    return plaintext;
  }

  /**
   * Validate a presented token. `slid` signals that the inactivity deadline moved, allowing the browser
   * cookie to be re-issued. Returns null for unknown, revoked, or expired credentials. The cache is initialized
   * only by issue(); validate may update an existing entry after an activity/sliding touch but never
   * recreates a missing entry. That contract makes revoke deletion final even when a validation DB read
   * was already in flight: its update fails instead of resurrecting the deleted cache entry.
   */
  async validate(
    raw: string,
    opts: { ip?: string | null } = {},
  ): Promise<{
    userId: number;
    sessionId: number;
    slid: boolean;
    autoTerminateDays: AutoTerminateDays;
    mustChangePassword: boolean;
  } | null> {
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
          autoTerminateDays: entry.autoTerminateDays,
          mustChangePassword: entry.mustChangePassword,
        };
      }
    }

    const rec = await this.database.db
      .select({
        id: sessionToken.id,
        userId: sessionToken.userId,
        expiresAt: sessionToken.expiresAt,
        revokedAt: sessionToken.revokedAt,
        lastSeenAt: sessionToken.lastSeenAt,
        autoTerminateDays: sessionToken.autoTerminateDays,
        mustChangePassword: user.mustChangePassword,
      })
      .from(sessionToken)
      .innerJoin(user, eq(user.id, sessionToken.userId))
      .where(eq(sessionToken.tokenHash, h))
      .limit(1)
      .then((rows) => rows[0]);
    if (!rec || rec.revokedAt !== null) return null;
    const exp = rec.expiresAt.getTime();
    if (exp <= Date.now()) {
      await this.database.db
        .update(sessionToken)
        .set({ revokedAt: new Date(), revokeReason: 'auto_terminated' })
        .where(
          and(eq(sessionToken.id, rec.id), isNull(sessionToken.revokedAt)),
        );
      return null;
    }

    // Activity refresh + sliding deadline for every client, throttled by nextTouchAt in
    // the persistent cache. A cache miss (for example after a process restart) still validates against
    // the database, but deliberately does not recreate the cache: only issue() has create semantics.
    let cachedExp = exp;
    let slid = false;
    let nextTouchAt = Date.now() + WEB_SESSION_SLIDING_TOUCH_MS;
    if (Date.now() - rec.lastSeenAt.getTime() > WEB_SESSION_SLIDING_TOUCH_MS) {
      const data: { lastSeenAt: Date; lastSeenIp?: string; expiresAt: Date } = {
        lastSeenAt: new Date(),
        expiresAt: new Date(
          Date.now() + rec.autoTerminateDays * 24 * 60 * 60 * 1000,
        ),
      };
      if (opts.ip) data.lastSeenIp = opts.ip;
      cachedExp = data.expiresAt.getTime();
      slid = true;
      try {
        await this.database.db
          .update(sessionToken)
          .set(data)
          .where(eq(sessionToken.tokenHash, h));
      } catch (e) {
        // Authentication is still valid according to the authoritative row just read. Do not claim a
        // slide or refresh the cookie when persistence failed; leave nextTouchAt due so a later request
        // retries the touch.
        this.logger.warn(
          `activity/sliding-touch write failed (non-fatal): ${String(e)}`,
        );
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
            autoTerminateDays: rec.autoTerminateDays as AutoTerminateDays,
            mustChangePassword: rec.mustChangePassword,
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
    return {
      userId: rec.userId,
      sessionId: rec.id,
      slid,
      autoTerminateDays: rec.autoTerminateDays as AutoTerminateDays,
      mustChangePassword: rec.mustChangePassword,
    };
  }

  async getAutoTerminateDays(userId: number): Promise<AutoTerminateDays> {
    const preference = await this.database.db
      .select({ value: userPreference.value })
      .from(userPreference)
      .where(
        and(
          eq(userPreference.userId, userId),
          eq(userPreference.key, AUTO_TERMINATE_PREFERENCE_KEY),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    return isAutoTerminateDays(preference?.value)
      ? preference.value
      : DEFAULT_AUTO_TERMINATE_DAYS;
  }

  async setAutoTerminateDays(
    userId: number,
    days: AutoTerminateDays,
  ): Promise<void> {
    const now = new Date();
    const sessions = await this.database.db
      .select({ tokenHash: sessionToken.tokenHash })
      .from(sessionToken)
      .where(
        and(eq(sessionToken.userId, userId), isNull(sessionToken.revokedAt)),
      );
    if (sessions.length > 0) {
      try {
        await this.kvStore.delPersistent(
          ...sessions.map(({ tokenHash }) => `${CACHE_PREFIX}${tokenHash}`),
        );
      } catch (error) {
        this.logger.error(
          `refusing session-lifetime update because cache invalidation failed for user ${userId}: ${String(error)}`,
        );
        throw new ServiceUnavailableException(
          'session settings are temporarily unavailable',
        );
      }
    }
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(userPreference)
        .values({
          userId,
          key: AUTO_TERMINATE_PREFERENCE_KEY,
          value: days,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userPreference.userId, userPreference.key],
          set: {
            value: days,
            revision: sql`${userPreference.revision} + 1`,
            updatedAt: now,
          },
        });
      await tx
        .update(sessionToken)
        .set({
          autoTerminateDays: days,
          expiresAt: sql`${sessionToken.lastSeenAt} + (${days} * interval '1 day')`,
        })
        .where(
          and(eq(sessionToken.userId, userId), isNull(sessionToken.revokedAt)),
        )
        .returning({ tokenHash: sessionToken.tokenHash });
      await tx
        .update(sessionToken)
        .set({ revokedAt: now, revokeReason: 'auto_terminated' })
        .where(
          and(
            eq(sessionToken.userId, userId),
            isNull(sessionToken.revokedAt),
            lte(sessionToken.expiresAt, now),
          ),
        );
    });
  }

  /** Revoke a single presented token (self-revoke on logout). Idempotent — a not-found or
   *  already-revoked token is a no-op so device logout is resilient to retries / stale state. */
  async revoke(raw: string): Promise<void> {
    const h = hashToken(raw);
    await this.database.db
      .update(sessionToken)
      .set({ revokedAt: new Date(), revokeReason: 'logout' })
      .where(
        and(eq(sessionToken.tokenHash, h), isNull(sessionToken.revokedAt)),
      );
    await this.kvStore.delPersistent(`${CACHE_PREFIX}${h}`).catch(() => {});
  }

  /** Revoke a session by its row id — the device-list "revoke this device" path, where the caller has
   *  the row id (shown in the list) but not the raw token. Ownership-checked: only a row belonging to
   *  `userId` and still active is touched, so a user can't revoke another user's session by guessing an
   *  id. Idempotent (a not-found / already-revoked / foreign row is a no-op). The persistent validation
   *  entry is dropped by the row's tokenHash, immediately preventing further cache authentication.
   *  Returns true iff a row was actually revoked (lets the caller distinguish "revoked" from "no-op"). */
  async revokeById(
    userId: number,
    sessionId: number,
    reason: string = 'device_revoke',
  ): Promise<boolean> {
    const rec = await this.database.db
      .select({ tokenHash: sessionToken.tokenHash })
      .from(sessionToken)
      .where(
        and(
          eq(sessionToken.id, sessionId),
          eq(sessionToken.userId, userId),
          isNull(sessionToken.revokedAt),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!rec) return false;
    await this.database.db
      .update(sessionToken)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(eq(sessionToken.id, sessionId));
    await this.kvStore
      .delPersistent(`${CACHE_PREFIX}${rec.tokenHash}`)
      .catch(() => {});
    return true;
  }

  /** Revoke ALL of the user's session tokens and delete each corresponding persistent validation entry. */
  async revokeAllForUser(
    userId: number,
    reason = 'all_devices',
  ): Promise<void> {
    const active = and(
      eq(sessionToken.userId, userId),
      isNull(sessionToken.revokedAt),
    );
    const sessions = await this.database.db
      .select({ tokenHash: sessionToken.tokenHash })
      .from(sessionToken)
      .where(active);
    await this.database.db
      .update(sessionToken)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(active);
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
    const rec = await this.database.db
      .select({ id: sessionToken.id })
      .from(sessionToken)
      .where(eq(sessionToken.tokenHash, hashToken(raw)))
      .limit(1)
      .then((rows) => rows[0]);
    return rec?.id ?? null;
  }

  /** Drop the validate-cache entry for a session row (looked up by id) so the NEXT validate() re-reads the
   *  DB. Used when a mutation changes a field that lives in that cache WITHOUT invalidating the session —
   *  specifically {@link AuthService.setPassword} clearing `mustChangePassword`: unlike changePassword /
   *  generateInitialPassword (which revoke all sessions, so stale caches die with them), setPassword KEEPS
   *  this session, so the issue-initialized entry must be removed when that flag changes. */
  async bustCacheBySessionId(sessionId: number): Promise<void> {
    const rec = await this.database.db
      .select({ tokenHash: sessionToken.tokenHash })
      .from(sessionToken)
      .where(eq(sessionToken.id, sessionId))
      .limit(1)
      .then((rows) => rows[0]);
    if (rec) {
      await this.kvStore
        .delPersistent(`${CACHE_PREFIX}${rec.tokenHash}`)
        .catch(() => {});
    }
  }
}
