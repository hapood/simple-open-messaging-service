-- Admin 账户体系（独立于聊天 User）：拖库隔离 + 消除提权 + 更严安全策略。
-- AdminRefreshToken 镜像 RefreshToken 家族化结构（独立实例）。

CREATE TABLE "Admin" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(31) NOT NULL,
    "hashPwd" VARCHAR(127) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginIp" VARCHAR(64),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Admin_username_key" ON "Admin"("username");
CREATE INDEX "Admin_username_idx" ON "Admin"("username");

CREATE TABLE "AdminRefreshToken" (
    "id" BIGSERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userAgent" VARCHAR(255),
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(32),

    CONSTRAINT "AdminRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRefreshToken_tokenHash_key" ON "AdminRefreshToken"("tokenHash");
CREATE UNIQUE INDEX "AdminRefreshToken_jti_key" ON "AdminRefreshToken"("jti");
CREATE INDEX "AdminRefreshToken_adminId_idx" ON "AdminRefreshToken"("adminId");
CREATE INDEX "AdminRefreshToken_familyId_idx" ON "AdminRefreshToken"("familyId");

ALTER TABLE "AdminRefreshToken" ADD CONSTRAINT "AdminRefreshToken_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
