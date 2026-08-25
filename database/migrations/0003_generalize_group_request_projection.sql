ALTER TABLE "GroupJoinRequestProjection"
  RENAME TO "GroupRequestProjection";

ALTER TABLE "GroupRequestProjection"
  RENAME COLUMN "applicantUserId" TO "memberUserId";

ALTER TABLE "GroupRequestProjection"
  ADD COLUMN direction varchar(15) NOT NULL DEFAULT 'APPLICATION';

ALTER TABLE "GroupRequestProjection"
  ALTER COLUMN direction DROP DEFAULT,
  DROP CONSTRAINT "GroupJoinRequestProjection_pkey",
  ADD CONSTRAINT "GroupRequestProjection_pkey"
    PRIMARY KEY ("managerUserId", "threadId", "memberUserId", direction),
  ADD CONSTRAINT "GroupRequestProjection_direction_check"
    CHECK (direction IN ('APPLICATION', 'INVITATION'));

ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_managerUserId_fkey" TO "GroupRequestProjection_managerUserId_fkey";
ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_threadId_fkey" TO "GroupRequestProjection_threadId_fkey";
ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_applicantUserId_fkey" TO "GroupRequestProjection_memberUserId_fkey";
ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_feedId_check" TO "GroupRequestProjection_feedId_check";
ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_status_check" TO "GroupRequestProjection_status_check";
ALTER TABLE "GroupRequestProjection" RENAME CONSTRAINT
  "GroupJoinRequestProjection_retention_check" TO "GroupRequestProjection_retention_check";

ALTER INDEX "GroupJoinRequestProjection_manager_feed_key"
  RENAME TO "GroupRequestProjection_manager_feed_key";
ALTER INDEX "GroupJoinRequestProjection_thread_feed_idx"
  RENAME TO "GroupRequestProjection_thread_feed_idx";
ALTER INDEX "GroupJoinRequestProjection_expiry_idx"
  RENAME TO "GroupRequestProjection_expiry_idx";
