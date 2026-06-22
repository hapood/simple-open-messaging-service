import { requireEnv } from '../common/env';

export const jwtConstants = {
  // access_token 签名/校验密钥（JwtModule、JwtStrategy、WebSocket 网关均用此）
  accessSecret: requireEnv('JWT_ACCESS_SECRET'),
  // refresh_token 签名/校验密钥（仅 AuthService 使用，与 access 分离）
  refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
};
