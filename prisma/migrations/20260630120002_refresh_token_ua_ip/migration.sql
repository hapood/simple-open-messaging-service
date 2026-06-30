-- RefreshToken 加 userAgent/ip（会话列表展示 + 异常排查；可空，增量安全）。
ALTER TABLE "RefreshToken" ADD COLUMN "userAgent" VARCHAR(255);
ALTER TABLE "RefreshToken" ADD COLUMN "ip" VARCHAR(64);
