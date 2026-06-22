import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { jwtConstants } from './constants';

const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 天，与 JWT expiresIn 对齐
const REFRESH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日清理一次过期记录

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
   * 签发 refresh token：用 refreshSecret 签 JWT（14d）并入库（存 sha256 哈希，不存明文）。
   * 返回 token 字符串。前端无需改动。
   */
  async getRefreshToken(userId: number, device?: string): Promise<string> {
    // jti 保证同一秒内为同一用户签发的多个 refresh token 互不相同，避免 tokenHash 唯一冲突
    const token = this.jwtService.sign(
      { sub: userId, jti: randomUUID() },
      { secret: jwtConstants.refreshSecret, expiresIn: '14d' },
    );
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        device: device ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return token;
  }

  /**
   * 校验 refresh token：先验 JWT 签名/过期，再查 DB 记录是否有效（未吊销、未过期）。
   * DB 记录是吊销与「重启存活」的事实源。有效返回 userId，否则 undefined。
   */
  async verifyRefreshToken(refreshToken: string): Promise<number | undefined> {
    let payload: { sub: number; exp: number };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: jwtConstants.refreshSecret,
      });
    } catch {
      return undefined;
    }
    const record = await this.prisma.refreshToken.findFirst({
      where: {
        tokenHash: hashToken(refreshToken),
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { userId: true },
    });
    return record?.userId;
  }

  /** 吊销 refresh token（幂等：不存在或已吊销则无操作）。 */
  async revokeRefreshToken(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
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
