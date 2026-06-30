import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '../prisma/generated/client';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
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
      access_token: this.getAccessToken(userId),
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
    return { access: this.getAccessToken(v.userId), refresh, userId: v.userId };
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

  getAccessToken(userId: number) {
    return this.jwtService.sign({ sub: userId }, { expiresIn: '15m' });
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
