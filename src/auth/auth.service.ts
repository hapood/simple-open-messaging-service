import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '../prisma/generated/client';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis/redis.service';
import { jwtConstants } from './constants';

const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 天，与 JWT expiresIn 对齐
const REFRESH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日清理一次过期记录

/** refresh token 签发/轮换选项：familyId 省略→铸造新家族（登录），传入→继承（轮换）。 */
type RefreshOpts = { familyId?: string; device?: string };

/** verifyRefreshToken 判别结果：区分重用(reuse)以触发前端强制重登，区别于普通失效。 */
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
    private redis: RedisService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    // 定时清理已过期的 refresh token 记录（替代原内存清理，修其 key 错配 bug）
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
    uniqName: string,
    password: string,
  ): Promise<UserModel | undefined> {
    const user = await this.userService.findUniqueUser({ uniqName }, true);
    if (user === null) {
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

  async login(userId: number) {
    return {
      access_token: await this.getAccessToken(userId),
      refresh_token: await this.getRefreshToken(userId),
    };
  }

  async logout(refreshToken: string) {
    await this.revokeRefreshToken(refreshToken);
  }

  /**
   * 签发 refresh token：用 refreshSecret 签 JWT（14d）并入库（存 sha256 哈希 + jti + familyId）。
   * - opts.familyId 省略 → 铸造新家族（登录）；传入 → 继承（轮换，维持重用检测链）。
   * - jti 保证同秒多签互不冲突；familyId 是重用检测锚点（重放已吊销 token→全家族失效）。
   */
  async getRefreshToken(userId: number, opts: RefreshOpts = {}): Promise<string> {
    const familyId = opts.familyId ?? randomUUID();
    const jti = randomUUID();
    const token = this.jwtService.sign(
      { sub: userId, jti, fam: familyId },
      { secret: jwtConstants.refreshSecret, expiresIn: '14d' },
    );
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        jti,
        familyId,
        device: opts.device ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return token;
  }

  /**
   * 校验 refresh token：先验 JWT 签名/过期，再查 DB 记录。
   * - JWT 有效但 DB 记录已吊销 → 重用（token 链已泄露）→ 全家族连根吊销 + 返回 reason:'reuse'。
   * - 旧 token（migration 前签发，JWT 无 fam claim 但 DB 行已回填 familyId/jti）仍可用，
   *   下次轮换即升级为新格式 token。
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
      return { ok: false, reason: 'reuse' };
    }
    if (rec.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: true, userId: rec.userId, familyId: rec.familyId, jti: rec.jti };
  }

  /**
   * 轮换 refresh token：校验 → 原子 claim（翻 revokedAt）→ 签发新 access+refresh（继承 familyId）。
   * - 并发 race：两调用方同时轮换同一 token，updateMany where revokedAt:null 只有一个 count===1，
   *   失败方 count===0 视为重用 → 全家族吊销（"合法用户与攻击者同用旧 token → 同归于尽"）。
   * - verifyRefreshToken 已对"已吊销"做 reuse 检测；此处 claim 兜底 verify 之后的并发窗口。
   * 失败抛 reason 字符串（'invalid'|'expired'|'reuse'），调用方据此映射业务码。
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
      throw 'reuse';
    }
    const refresh = await this.getRefreshToken(v.userId, {
      familyId: v.familyId,
      ...opts,
    });
    return { access: await this.getAccessToken(v.userId), refresh, userId: v.userId };
  }

  /** 连根吊销整个家族（重用检测触发）：所有未吊销成员一并失效。 */
  async revokeFamily(familyId: string, reason: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** 吊销单个 refresh token（logout 用；幂等：不存在或已吊销则无操作）。 */
  async revokeRefreshToken(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
  }

  /**
   * 签发 access token：claim 带 {sub, jti, tver}。
   * - jti：该 token 唯一 id；单 token 吊销时入 Redis 黑名单（TTL=剩余寿命）。
   * - tver：签发时的 User.tokenVersion，JwtStrategy 校验与当前一致；bump tver 即令所有 access 失效。
   */
  async getAccessToken(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return this.jwtService.sign(
      { sub: userId, jti: randomUUID(), tver: user!.tokenVersion },
      { expiresIn: '15m' },
    );
  }

  /** 单个 access token 即时吊销（登出单设备）：jti 入 Redis 黑名单，TTL 取剩余寿命。 */
  async blacklistAccessJti(jti: string, ttlSec: number) {
    if (!this.redis.enabled) return;
    await this.redis.setex(`access:jti:${jti}`, ttlSec, '1').catch(() => {});
  }

  /**
   * 全设备登出 / 改密 / 强制下线：吊销所有 refresh + tokenVersion++（令所有 access 失效）。
   * 清 Redis 的 tokenVersion 缓存让新版本即时生效；发事件让在线 WS 客户端 FORCE_LOGOUT。
   */
  async invalidateAllSessions(userId: number, reason: string): Promise<number> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    if (this.redis.enabled) {
      await this.redis.del(`access:tver:${userId}`).catch(() => {});
    }
    this.eventEmitter.emit('auth.sessions-invalidated', {
      userId,
      reason,
      tokenVersion: user.tokenVersion,
    });
    return user.tokenVersion;
  }

  /** 改密：验旧密 → 换 hash → invalidateAllSessions → 返回新登录对（当前设备重登）。 */
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

  /** 列活跃 refresh 会话（未吊销未过期），按创建时间倒序。 */
  async listActiveSessions(userId: number) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { jti: true, device: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 吊销指定 refresh（按 jti + 属该 userId）+ 可选吊销其 access（黑名单）。 */
  async revokeSession(userId: number, refreshJti: string, accessJti?: string) {
    await this.prisma.refreshToken.updateMany({
      where: { jti: refreshJti, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
    if (accessJti) {
      await this.blacklistAccessJti(accessJti, 15 * 60);
    }
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
