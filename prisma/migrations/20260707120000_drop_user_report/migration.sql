-- Reverts the UserReport table introduced in 20260706120000_thread_meta_block_report.
-- Report/complaint ingestion is removed from the product (no ingestion path, no admin queue ever
-- read this table). Re-added later it will be a different schema (target-type + category + snapshot +
-- status), so this DDL is dropped outright rather than left as dead weight.

-- DropForeignKey
ALTER TABLE "UserReport" DROP CONSTRAINT "UserReport_reporterId_fkey";

-- DropForeignKey
ALTER TABLE "UserReport" DROP CONSTRAINT "UserReport_reportedUserId_fkey";

-- DropIndex
DROP INDEX "UserReport_reportedUserId_idx";

-- DropTable
DROP TABLE "UserReport";
