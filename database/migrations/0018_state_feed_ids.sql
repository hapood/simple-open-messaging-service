ALTER TABLE "User"
  RENAME COLUMN "threadRevision" TO "stateFeedAllocatedThrough";

ALTER TABLE "ClientStateFeed" RENAME COLUMN revision TO "feedId";

ALTER INDEX "ClientStateFeed_user_revision_idx"
  RENAME TO "ClientStateFeed_user_feedId_idx";

ALTER TABLE "ClientStateFeed"
  RENAME CONSTRAINT "ClientStateFeed_revision_check"
  TO "ClientStateFeed_feedId_check";

DROP TABLE "ThreadRevision";
DROP TABLE "ProfileStateRevision";
DROP TABLE "MemberProfileStateRevision";
DROP TYPE "ThreadRevisionDirection";
