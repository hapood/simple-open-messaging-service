CREATE TYPE "AdminAuditStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

ALTER TABLE "AdminActionLog"
ADD COLUMN "status" "AdminAuditStatus";

UPDATE "AdminActionLog"
SET "status" = CASE
  WHEN "success" THEN 'SUCCEEDED'::"AdminAuditStatus"
  ELSE 'FAILED'::"AdminAuditStatus"
END;

ALTER TABLE "AdminActionLog"
ALTER COLUMN "status" SET DEFAULT 'STARTED',
ALTER COLUMN "status" SET NOT NULL,
DROP COLUMN "success";
