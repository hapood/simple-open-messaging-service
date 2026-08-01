import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../user/user.service.js';
import { and, count, desc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { sessionToken, user as userTable } from '../database/schema.js';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SessionTokenService } from './session-token.service.js';
import { PasswordHasher } from './password-hasher.service.js';

/**
 * User authentication: local password login validation + the single session-token lifecycle
 * (issue/validate/revoke live in {@link SessionTokenService}). There is no access JWT and no refresh
 * token — one opaque session credential per device authenticates everything, revoked wholesale by
 * {@link invalidateAllSessions} (logout-all / password change / admin purge), which also emits so online
 * SSE clients are FORCE_LOGOUT'd at once. The admin console's SEPARATE JWT+refresh auth
 * (AdminAuthService / AdminRefreshToken / Admin.tokenVersion) is a different system, untouched here.
 */
@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private database: DatabaseService,
    private eventEmitter: EventEmitter2,
    private sessionTokens: SessionTokenService,
    private passwordHasher: PasswordHasher,
  ) {}

  async validateUser(account: string, password: string) {
    const user = await this.userService.findUniqueUserForAuth({
      account_domain: { account: normalizeAccount(account), domain: 'local' },
    });
    if (user === null || user.isGroup) {
      // A `!`-group-User is not a login principal: reject as invalid credentials (non-leaking — same
      // outcome as a wrong password, and skips argon2.verify on its unusable empty hashPwd).
      return undefined;
    }
    if (user.hashPwd === null) {
      // Password-login interception: a null-hash account (OTP/QR-only) has no password to verify. Signal
      // PASSWORD_NOT_SET so the client shows "contact the administrator to set the initial password" rather
      // than a generic wrong-password — and LocalStrategy does NOT count it toward the brute-force ban
      // (there is no password to guess). Non-exploitable: a no-password account can't be brute-forced.
      throw new BusinessException(
        BusinessCode.PASSWORD_NOT_SET,
        'password not set; contact the administrator to set the initial password',
      );
    }
    const match = await this.passwordHasher.verify(user.hashPwd, password);
    if (match === true) {
      return user;
    }
    return undefined;
  }

  /** Hash a plaintext password via the shared {@link PasswordHasher} (Argon2id + pepper). */
  async hashPassword(str: string) {
    return this.passwordHasher.hash(str);
  }

  /**
   * Revoke every session token for the user (logout-all / password change / admin disable / admin purge)
   * + emit `auth.sessions-invalidated` so the SSE service pushes FORCE_LOGOUT and drops their live
   * connections at once. SessionTokenService also deletes every issue-initialized validation entry,
   * so a revoked token cannot continue authenticating from cache.
   */
  async invalidateAllSessions(userId: number, reason: string): Promise<void> {
    await this.sessionTokens.revokeAllForUser(userId, reason);
    this.eventEmitter.emit('auth.sessions-invalidated', { userId, reason });
  }

  /** Change password: verify the old password → swap the hash → invalidateAllSessions (every session
   *  token revoked; the client re-logs in for a fresh one — no token is reissued here). */
  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'wrong_password' }> {
    const user = await this.database.db.query.user.findFirst({
      where: eq(userTable.id, userId),
      columns: { hashPwd: true },
    });
    if (
      !user ||
      !user.hashPwd ||
      !(await this.passwordHasher.verify(user.hashPwd, oldPassword))
    ) {
      // No user, or no password set yet (OTP/QR-only account) → can't "change"; treat as wrong_password.
      // The first-time set uses setPassword (no old password); a voluntary change requires the current one.
      return { ok: false, reason: 'wrong_password' };
    }
    await this.database.db
      .update(userTable)
      .set({
        hashPwd: await this.passwordHasher.hash(newPassword),
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, userId));
    await this.invalidateAllSessions(userId, 'password_change');
    return { ok: true };
  }

  /** Set the user's OWN password — exactly one of two cases: (1) the FIRST-TIME set by a passwordless
   *  (OTP/QR-only) account enabling password login (hashPwd null), or (2) the forced rotation of an
   *  admin-generated initial password (mustChangePassword). No old password is required: the caller is
   *  already session-authenticated. Once a password exists AND the user has already settled it
   *  (mustChangePassword false), this refuses (FORBIDDEN) — the only path then is {@link changePassword},
   *  which requires the old password. That closes the bypass where a logged-in user rotates a known
   *  password without proving they know the current one. Stores the hash + CLEARS mustChangePassword.
   *  Unlike changePassword, sessions are NOT invalidated — the user keeps the session they just proved
   *  ownership of. The calling session's validation entry is deleted (via sessionId) so the cleared
   *  flag is seen at once on the next database-backed validation. */
  async setPassword(
    userId: number,
    newPassword: string,
    sessionId?: number,
  ): Promise<void> {
    const user = await this.database.db.query.user.findFirst({
      where: eq(userTable.id, userId),
      columns: { hashPwd: true, mustChangePassword: true },
    });
    if (!user) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'user not found');
    }
    if (user.hashPwd !== null && !user.mustChangePassword) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'password already set — use change-password (old password required)',
      );
    }
    await this.database.db
      .update(userTable)
      .set({
        hashPwd: await this.passwordHasher.hash(newPassword),
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, userId));
    if (sessionId !== undefined) {
      await this.sessionTokens.bustCacheBySessionId(sessionId);
    }
  }

  /** Active session credentials — the data behind the "Devices / Active sessions" settings page.
   *  SessionToken rows that are not revoked and not past their sliding deadline (no-expiry app tokens
   *  always qualify), newest activity (lastSeenAt) first. `currentSessionId` is the requesting token's
   *  row id (stamped on req.user by the guard); the matching row is flagged `isCurrent` so the UI can
   *  tag "this device". */
  async listActiveSessions(userId: number, currentSessionId: number | null) {
    const rows = await this.database.db.query.sessionToken.findMany({
      where: and(
        eq(sessionToken.userId, userId),
        isNull(sessionToken.revokedAt),
        or(
          isNull(sessionToken.expiresAt),
          gt(sessionToken.expiresAt, new Date()),
        ),
      ),
      orderBy: desc(sessionToken.lastSeenAt),
      columns: {
        id: true,
        client: true,
        device: true,
        userAgent: true,
        ip: true,
        lastSeenIp: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        trusted: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      client: r.client,
      device: r.device,
      userAgent: r.userAgent,
      ip: r.ip,
      lastSeenIp: r.lastSeenIp,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      trusted: r.trusted,
      isCurrent: currentSessionId !== null && r.id === currentSessionId,
    }));
  }

  /** Revoke one session by its device-list row id (the "revoke this device" action). Delegates to
   *  SessionTokenService.revokeById, which ownership-checks (id + userId + active) and drops the
   *  persistent validation entry immediately. Emits `auth.session-revoked` so the SSE
   *  service pushes FORCE_LOGOUT to ONLY that session's connection(s) and drops them — the user's other
   *  devices stay online (unlike invalidateAllSessions, which kicks every device). Returns true iff a row
   *  was revoked (no emit on a no-op — unknown/foreign/already-revoked id). */
  async revokeSession(userId: number, sessionId: number) {
    const ok = await this.sessionTokens.revokeById(userId, sessionId);
    if (ok) {
      this.eventEmitter.emit('auth.session-revoked', {
        userId,
        sessionId,
        reason: 'device_revoke',
      });
    }
    return ok;
  }

  /** Admin-side single-session revoke — NOT owner-gated. Picked from the system-wide session list, this
   *  resolves the row's userId from its id (so the SSE FORCE_LOGOUT still targets the right user),
   *  revokes it with reason 'admin_revoke', and emits auth.session-revoked → the SSE service kicks ONLY
   *  that device (the user's other devices stay online — the surgical counterpart to forceLogout, which
   *  kicks every device). Returns true iff a row was actually revoked; a not-found / already-revoked id
   *  is a no-op (no emit) so a stale list entry can't trigger a phantom logout. */
  async revokeSessionAdmin(sessionId: number): Promise<boolean> {
    const rec = await this.database.db.query.sessionToken.findFirst({
      where: and(
        eq(sessionToken.id, sessionId),
        isNull(sessionToken.revokedAt),
      ),
      columns: { userId: true },
    });
    if (!rec) return false;
    const ok = await this.sessionTokens.revokeById(
      rec.userId,
      sessionId,
      'admin_revoke',
    );
    if (ok) {
      this.eventEmitter.emit('auth.session-revoked', {
        userId: rec.userId,
        sessionId,
        reason: 'admin_revoke',
      });
    }
    return ok;
  }

  // ── Admin session/overview reads ─────────────────────────────────────────────
  // User-side sessions live on SessionToken (the canonical credential). Admin-session reads
  // (AdminRefreshToken) live in AdminAuthService. Services return domain data; the controller wraps
  // the HTTP envelope.

  /** System-wide active session overview — SessionToken rows (filter by userId / ip). Active = not
   *  revoked and not past its sliding deadline (no-expiry app tokens always qualify); the ip filter
   *  matches both the sign-in ip and the last-seen ip. Newest activity (lastSeenAt) first. */
  async listAllSessions(opts: {
    skip?: number;
    take?: number;
    userId?: number;
    ip?: string;
  }) {
    const where = and(
      isNull(sessionToken.revokedAt),
      or(
        isNull(sessionToken.expiresAt),
        gt(sessionToken.expiresAt, new Date()),
      ),
      opts.userId ? eq(sessionToken.userId, opts.userId) : undefined,
      opts.ip
        ? or(
            like(sessionToken.ip, `%${opts.ip}%`),
            like(sessionToken.lastSeenIp, `%${opts.ip}%`),
          )
        : undefined,
    );
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          id: sessionToken.id,
          userId: sessionToken.userId,
          client: sessionToken.client,
          device: sessionToken.device,
          userAgent: sessionToken.userAgent,
          ip: sessionToken.ip,
          lastSeenIp: sessionToken.lastSeenIp,
          createdAt: sessionToken.createdAt,
          lastSeenAt: sessionToken.lastSeenAt,
          expiresAt: sessionToken.expiresAt,
          trusted: sessionToken.trusted,
          account: userTable.account,
        })
        .from(sessionToken)
        .innerJoin(userTable, eq(userTable.id, sessionToken.userId))
        .where(where)
        .orderBy(desc(sessionToken.lastSeenAt))
        .offset(opts.skip ?? 0)
        .limit(opts.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(sessionToken)
        .where(where)
        .then(([row]) => row.value),
    ]);
    const list = rows.map(({ account, ...row }) => ({
      ...row,
      user: { id: row.userId, account },
    }));
    return { list, total };
  }

  /** Purge every active session in one shot: revoke every session token for each user with an active
   *  credential (forces every user to re-login). */
  async purgeAllSessions(): Promise<{ purgedUsers: number }> {
    const sessionUsers = await this.database.db
      .selectDistinct({ userId: sessionToken.userId })
      .from(sessionToken)
      .where(
        and(
          isNull(sessionToken.revokedAt),
          or(
            isNull(sessionToken.expiresAt),
            gt(sessionToken.expiresAt, new Date()),
          ),
        ),
      );
    const userIds = new Set(sessionUsers.map((r) => r.userId));
    for (const userId of userIds) {
      await this.invalidateAllSessions(userId, 'admin_purge');
    }
    return { purgedUsers: userIds.size };
  }
}
