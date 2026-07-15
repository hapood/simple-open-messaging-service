import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../user/user.service.js';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { KvStoreService } from '../kv-store/kv-store.service.js';
import { jwtConstants } from './constants.js';
import { normalizeAccount } from '../common/account.js';
import { SessionTokenService } from './session-token.service.js';

const REFRESH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Clean up expired records once per day

/** Refresh token issue/rotation options: omit familyId -> mint a new family (login); pass it -> inherit (rotation). */
type RefreshOpts = { familyId?: string; device?: string; userAgent?: string; ip?: string };

/** verifyRefreshToken outcome: distinguishes reuse (to force re-login on the client) from ordinary invalidity. */
type VerifyResult =
  | { ok: true; userId: number; familyId: string; jti: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' };

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private _cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private prisma: PrismaService,
    private kvStore: KvStoreService,
    private eventEmitter: EventEmitter2,
    private sessionTokens: SessionTokenService,
  ) {}

  async onModuleInit() {
    // Periodically clean up expired refresh token records (replaces the original in-memory cleanup, fixing its key-mismatch bug)
    this._cleanupTimer = setInterval(
      () => this.cleanupExpiredRefreshTokens(),
      REFRESH_CLEANUP_INTERVAL_MS,
    );
  }

  async onModuleDestroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
  }

  async validateUser(
    account: string,
    password: string,
  ) {
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

  async login(userId: number, opts: RefreshOpts = {}) {
    return {
      access_token: await this.getAccessToken(userId),
      refresh_token: await this.getRefreshToken(userId, opts),
    };
  }

  async logout(refreshToken: string) {
    await this.revokeRefreshToken(refreshToken);
  }

  /**
   * Issue a refresh token: sign a JWT with refreshSecret (14d) and persist it (storing sha256 hash + jti + familyId).
   * - Omit opts.familyId -> mint a new family (login); pass it -> inherit (rotation, preserving the reuse-detection chain).
   * - jti ensures multiple signatures issued within the same second do not collide; familyId is the reuse-detection anchor (replaying a revoked token -> entire family revoked).
   */
  async getRefreshToken(userId: number, opts: RefreshOpts = {}): Promise<string> {
    const familyId = opts.familyId ?? randomUUID();
    const jti = randomUUID();
    const token = this.jwtService.sign(
      { sub: userId, jti, fam: familyId },
      { secret: jwtConstants.refreshSecret, expiresIn: jwtConstants.refreshTtlDays },
    );
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        jti,
        familyId,
        device: opts.device ?? null,
        userAgent: opts.userAgent ?? null,
        ip: opts.ip ?? null,
        expiresAt: new Date(Date.now() + jwtConstants.refreshTtlMs),
      },
    });
    return token;
  }

  /**
   * Verify a refresh token: first validate the JWT signature/expiry, then look up the DB record.
   * - JWT valid but DB record already revoked -> reuse (token chain leaked) -> revoke the entire family and return reason:'reuse'.
   * - Legacy tokens (issued before the migration; JWT lacks a fam claim but the DB row already has familyId/jti backfilled) still work,
   *   and the next rotation upgrades them to the new token format.
   */
  async verifyRefreshToken(refreshToken: string): Promise<VerifyResult> {
    try {
      this.jwtService.verify(refreshToken, {
        secret: jwtConstants.refreshSecret,
      });
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    const rec = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: {
        userId: true,
        familyId: true,
        jti: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    if (!rec) return { ok: false, reason: 'invalid' };
    if (rec.revokedAt !== null) {
      await this.revokeFamily(rec.familyId, 'reuse');
      this.eventEmitter.emit('auth.refresh-reuse-detected', {
        userId: rec.userId,
        familyId: rec.familyId,
        jti: rec.jti,
      });
      return { ok: false, reason: 'reuse' };
    }
    if (rec.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: true, userId: rec.userId, familyId: rec.familyId, jti: rec.jti };
  }

  /**
   * Rotate a refresh token: verify -> atomic claim (flip revokedAt) -> issue new access+refresh (inheriting familyId).
   * - Concurrency race: if two callers rotate the same token simultaneously, only one updateMany where revokedAt:null gets count===1;
   *   the loser gets count===0 and is treated as reuse -> revoke the entire family ("legitimate user and attacker sharing the old token -> mutual destruction").
   * - verifyRefreshToken already detects reuse for revoked records; this claim backstops the concurrency window after verify.
   * On failure throws a reason string ('invalid'|'expired'|'reuse'); the caller maps it to a business code.
   */
  async rotateRefreshToken(
    refreshToken: string,
    opts: RefreshOpts = {},
  ): Promise<{ access: string; refresh: string; userId: number }> {
    const v = await this.verifyRefreshToken(refreshToken);
    if (v.ok === false) throw v.reason;
    const claim = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'rotated' },
    });
    if (claim.count === 0) {
      await this.revokeFamily(v.familyId, 'reuse');
      this.eventEmitter.emit('auth.refresh-reuse-detected', {
        userId: v.userId,
        familyId: v.familyId,
        jti: v.jti,
      });
      throw 'reuse';
    }
    const refresh = await this.getRefreshToken(v.userId, {
      familyId: v.familyId,
      ...opts,
    });
    return { access: await this.getAccessToken(v.userId), refresh, userId: v.userId };
  }

  /** Revoke an entire family at the root (triggered by reuse detection): all non-revoked members are invalidated. */
  async revokeFamily(familyId: string, reason: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** Revoke a single refresh token (used by logout; idempotent: no-op if it does not exist or is already revoked). */
  async revokeRefreshToken(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
  }

  /**
   * Issue an access token: the claim carries {sub, jti, tver}.
   * - jti: unique id of this token; when revoking a single token it is added to a KV-store blacklist (TTL = remaining lifetime).
   * - tver: the User.tokenVersion at issue time, which JwtStrategy verifies matches the current value; bumping tver invalidates all access tokens.
   */
  async getAccessToken(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return this.jwtService.sign(
      { sub: userId, jti: randomUUID(), tver: user!.tokenVersion },
      { expiresIn: jwtConstants.accessTtl },
    );
  }

  /** Immediately revoke a single access token (log out a single device): add its jti to the blacklist, TTL defaults to the access token's remaining lifetime. */
  async blacklistAccessJti(jti: string, ttlSec: number = jwtConstants.accessTtlSec) {
    await this.kvStore.setex(`access:jti:${jti}`, ttlSec, '1').catch(() => {});
  }

  /**
   * Log out all devices / change password / force offline: revoke all refresh tokens and increment tokenVersion (invalidating all access tokens).
   * Clear the KV-store tokenVersion cache so the new version takes effect immediately; emit an event so online WS clients FORCE_LOGOUT.
   */
  async invalidateAllSessions(userId: number, reason: string): Promise<number> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    // Also revoke every session token (the native/web credential that supersedes the refresh-token
    // family). KV-cached validations self-expire within 60s; the live SSE connection is dropped at once
    // by the auth.sessions-invalidated → FORCE_LOGOUT handler emitted below.
    await this.sessionTokens.revokeAllForUser(userId, reason);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    await this.kvStore.del(`access:tver:${userId}`).catch(() => {});
    this.eventEmitter.emit('auth.sessions-invalidated', {
      userId,
      reason,
      tokenVersion: user.tokenVersion,
    });
    return user.tokenVersion;
  }

  /** Change password: verify the old password -> swap the hash -> invalidateAllSessions -> return a fresh login pair (re-login on the current device). */
  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<
    | { ok: true; access_token: string; refresh_token: string }
    | { ok: false; reason: 'wrong_password' }
  > {
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
    return {
      ok: true,
      access_token: await this.getAccessToken(userId),
      refresh_token: await this.getRefreshToken(userId),
    };
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
   *  entry so the revocation lands within the 60s cache window. Returns true iff a row was revoked. */
  async revokeSession(userId: number, sessionId: number) {
    return this.sessionTokens.revokeById(userId, sessionId);
  }

  // ── Admin session/overview reads (moved from AdminController) ────────────────
  // These own the user-side RefreshToken table; admin-session reads (AdminRefreshToken) live in
  // AdminAuthService. Services return domain data; the controller wraps the HTTP envelope.

  /** System-wide active refresh-session overview (filter by userId / ip). */
  async listAllSessions(opts: { skip?: number; take?: number; userId?: number; ip?: string }) {
    const where = {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.ip ? { ip: { contains: opts.ip } } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.refreshToken.findMany({
        where,
        skip: opts.skip ?? 0,
        take: opts.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          jti: true,
          device: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
          user: { select: { id: true, account: true } },
        },
      }),
      this.prisma.refreshToken.count({ where }),
    ]);
    return { list, total };
  }

  /** Refresh-token reuse events (the family has been revoked at the root). */
  reuseAlerts(take = 50) {
    return this.prisma.refreshToken.findMany({
      where: { revokeReason: 'reuse' },
      select: {
        userId: true,
        familyId: true,
        jti: true,
        ip: true,
        userAgent: true,
        revokedAt: true,
      },
      orderBy: { revokedAt: 'desc' },
      take,
    });
  }

  /** Purge every active session in one shot (forces every user to re-login; access tokens die at once). */
  async purgeAllSessions(): Promise<{ purgedUsers: number }> {
    const active = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const { userId } of active) {
      await this.invalidateAllSessions(userId, 'admin_purge');
    }
    return { purgedUsers: active.length };
  }

  private async cleanupExpiredRefreshTokens() {
    await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
