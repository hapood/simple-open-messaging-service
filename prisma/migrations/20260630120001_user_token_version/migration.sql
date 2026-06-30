-- User.tokenVersion：access-token 版本号。
-- bump 它即令该用户所有 access token 失效（全设备登出 / 改密 / 强制下线）。
-- JwtStrategy 校验 access claim.tver === 当前 tokenVersion（Redis 缓存 60s，miss 回查 DB）。
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
