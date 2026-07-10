-- Admin RBAC + tokenVersion (global session revocation) + AdminActionLog audit trail.
-- Phase 1 security foundations (see src/admin). Additive only — no data loss.
-- AdminRole defaults to SUPER_ADMIN so the existing seed admin keeps full access.

-- ── new type ─────────────────────────────────────────────────────────────────
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VIEWER');

-- ── Admin: role + tokenVersion ───────────────────────────────────────────────
ALTER TABLE "Admin" ADD COLUMN "role" "AdminRole" NOT NULL DEFAULT 'SUPER_ADMIN';
ALTER TABLE "Admin" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- ── AdminActionLog ───────────────────────────────────────────────────────────
CREATE TABLE "AdminActionLog" (
    "id" BIGSERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "adminRole" "AdminRole" NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32),
    "targetId" VARCHAR(64),
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(255),
    "route" VARCHAR(255),
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" VARCHAR(255),
    "meta" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminActionLog_adminId_idx" ON "AdminActionLog"("adminId");
CREATE INDEX "AdminActionLog_at_idx" ON "AdminActionLog"("at");
CREATE INDEX "AdminActionLog_action_idx" ON "AdminActionLog"("action");

ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
