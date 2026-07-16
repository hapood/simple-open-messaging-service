import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../user/user.service.js';
import argon2 from 'argon2';
import { PrismaService } from '../prisma.service.js';
import { normalizeAccount } from '../common/account.js';
import { SessionTokenService } from './session-token.service.js';

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
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private sessionTokens: SessionTokenService,
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
    const match = await argon2.verify(user.hashPwd, password);
    if (match === true) {
      return user;
    }
    return undefined;
  }

  async hashStr(str: string) {
    return argon2.hash(str);
  }

  /**
   * Revoke every session token for the user (logout-all / password change / admin disable / admin purge)
   * + emit `auth.sessions-invalidated` so the SSE service pushes FORCE_LOGOUT and drops their live
   * connections at once. KV-cached session validations self-expire within 60s, so a token presented
   * after this lands is rejected on its next (re)validation.
   */
  async invalidateAllSessions(userId: number, reason: string): Promise<void> {
    await this.sessionTokens.revokeAllForUser(userId, reason);
    this.eventEmitter.emit('auth.sessions-invalidated', { userId, reason });
  }

  /** Revoke every active `app` (long-term, Android) session for the user and notify JUST those devices —
   *  the one-app-session rule: a new OTP app login replaces the prior app session (Telegram-style), so a
   *  user holds at most one app session. Unlike {@link invalidateAllSessions} (which kicks ALL devices),
   *  this targets only app sessions, leaving web/desktop sessions online. Emits `auth.session-revoked` per
   *  revoked session so the SSE service FORCE_LOGOUTs only the replaced app connection(s); the reason
   *  ('app_session_replaced') rides the FORCE_LOGOUT `message` field → the kicked client surfaces a
   *  "signed in elsewhere" notice. */
  async replaceAppSessions(userId: number, reason = 'app_session_replaced'): Promise<void> {
    const sessionIds = await this.sessionTokens.revokeAllForClient(userId, 'app', reason);
    for (const sessionId of sessionIds) {
      this.eventEmitter.emit('auth.session-revoked', { userId, sessionId, reason });
    }
  }

  /** Change password: verify the old password → swap the hash → invalidateAllSessions (every session
   *  token revoked; the client re-logs in for a fresh one — no token is reissued here). */
  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'wrong_password' }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { hashPwd: true },
    });
    if (!user || !(await argon2.verify(user.hashPwd, oldPassword))) {
      return { ok: false, reason: 'wrong_password' };
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashPwd: await argon2.hash(newPassword) },
    });
    await this.invalidateAllSessions(userId, 'password_change');
    return { ok: true };
  }

  /** Active session credentials — the data behind the "Devices / Active sessions" settings page.
   *  SessionToken rows that are not revoked and not past their sliding deadline (no-expiry app tokens
   *  always qualify), newest activity (lastSeenAt) first. `currentSessionId` is the requesting token's
   *  row id (stamped on req.user by the guard); the matching row is flagged `isCurrent` so the UI can
   *  tag "this device". */
  async listActiveSessions(userId: number, currentSessionId: number | null) {
    const rows = await this.prisma.sessionToken.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        client: true,
        device: true,
        userAgent: true,
        ip: true,
        lastSeenIp: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
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
      isCurrent: currentSessionId !== null && r.id === currentSessionId,
    }));
  }

  /** Revoke one session by its device-list row id (the "revoke this device" action). Delegates to
   *  SessionTokenService.revokeById, which ownership-checks (id + userId + active) and drops the KV
   *  entry so the revocation lands within the 60s cache window. Emits `auth.session-revoked` so the SSE
   *  service pushes FORCE_LOGOUT to ONLY that session's connection(s) and drops them — the user's other
   *  devices stay online (unlike invalidateAllSessions, which kicks every device). Returns true iff a row
   *  was revoked (no emit on a no-op — unknown/foreign/already-revoked id). */
  async revokeSession(userId: number, sessionId: number) {
    const ok = await this.sessionTokens.revokeById(userId, sessionId);
    if (ok) {
      this.eventEmitter.emit('auth.session-revoked', { userId, sessionId, reason: 'device_revoke' });
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
  async listAllSessions(opts: { skip?: number; take?: number; userId?: number; ip?: string }) {
    const where = {
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ...(opts.userId ? [{ userId: opts.userId }] : []),
        ...(opts.ip
          ? [{ OR: [{ ip: { contains: opts.ip } }, { lastSeenIp: { contains: opts.ip } }] }]
          : []),
      ],
    };
    const [list, total] = await Promise.all([
      this.prisma.sessionToken.findMany({
        where,
        skip: opts.skip ?? 0,
        take: opts.take ?? 50,
        orderBy: { lastSeenAt: 'desc' },
        select: {
          id: true,
          userId: true,
          client: true,
          device: true,
          userAgent: true,
          ip: true,
          lastSeenIp: true,
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
          user: { select: { id: true, account: true } },
        },
      }),
      this.prisma.sessionToken.count({ where }),
    ]);
    return { list, total };
  }

  /** Purge every active session in one shot: revoke every session token for each user with an active
   *  credential (forces every user to re-login). */
  async purgeAllSessions(): Promise<{ purgedUsers: number }> {
    const sessionUsers = await this.prisma.sessionToken.findMany({
      where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true },
      distinct: ['userId'],
    });
    const userIds = new Set(sessionUsers.map((r) => r.userId));
    for (const userId of userIds) {
      await this.invalidateAllSessions(userId, 'admin_purge');
    }
    return { purgedUsers: userIds.size };
  }
}
