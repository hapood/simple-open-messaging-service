import { requireEnv } from '../common/env';

export const jwtConstants = {
  // access_token 签名/校验密钥（JwtModule、JwtStrategy、WebSocket 网关均用此）
  accessSecret: requireEnv('JWT_ACCESS_SECRET'),
  // refresh_token 签名/校验密钥（仅 AuthService 使用，与 access 分离）
  refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
  // admin JWT 独立密钥（admin 控制台专用，与用户体系物理隔离）
  adminSecret: requireEnv('JWT_ADMIN_SECRET'),
  // 过期时长集中于此（避免散落的魔法字符串/数字）。as const 收窄成字面量以匹配 jwt expiresIn 的 StringValue 类型。
  accessTtl: '15m' as const,
  accessTtlSec: 15 * 60,
  refreshTtlDays: '14d' as const,
  refreshTtlMs: 14 * 24 * 60 * 60 * 1000,
};
