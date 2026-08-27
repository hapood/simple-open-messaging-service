ALTER TABLE "ThreadParticipant"
  ADD COLUMN "left" boolean DEFAULT false NOT NULL;

CREATE INDEX "ThreadParticipant_threadId_left_lastSentSeq_idx"
  ON "ThreadParticipant" ("threadId", "left", "lastSentSeq");

ALTER TABLE "FederatedGroupMember"
  ADD COLUMN "left" boolean DEFAULT false NOT NULL;

ALTER TABLE "FederatedGroupMember"
  DROP CONSTRAINT "FederatedGroupMember_seenAtFeedId_check",
  DROP COLUMN "seenAtFeedId";
