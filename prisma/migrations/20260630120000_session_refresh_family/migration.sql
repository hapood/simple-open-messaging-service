-- RefreshToken 家族化（session 加固 Phase 1）：
--   jti         该 token 的唯一 id，精确吊销键，与 JWT claim 对齐
--   familyId    登录时铸造、轮换时继承；重用检测锚点
--   revokeReason 吊销原因（仅观测/取证）
-- 回填策略：每个 legacy token 自成一家（独立 jti/familyId）——旧 JWT 本就带 jti claim，
--   但旧 DB 行未存；旧 token 下次轮换即升级为新格式 token（继承到真实 family）。

ALTER TABLE "RefreshToken" ADD COLUMN "jti" TEXT;
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT;
ALTER TABLE "RefreshToken" ADD COLUMN "revokeReason" VARCHAR(32);

UPDATE "RefreshToken" SET "jti" = gen_random_uuid() WHERE "jti" IS NULL;
UPDATE "RefreshToken" SET "familyId" = gen_random_uuid() WHERE "familyId" IS NULL;

CREATE UNIQUE INDEX "RefreshToken_jti_key" ON "RefreshToken"("jti");
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

ALTER TABLE "RefreshToken" ALTER COLUMN "jti" SET NOT NULL;
ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;
