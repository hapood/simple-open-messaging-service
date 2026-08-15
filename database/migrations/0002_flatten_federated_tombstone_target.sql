ALTER TABLE "Message"
ADD COLUMN "federationSourceDomain" varchar(255);

CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key"
ON "Message" ("threadId", "federationSourceDomain", "originSeq");

DROP INDEX "FederatedMessageTombstone_target_key";

ALTER TABLE "FederatedMessageTombstone"
DROP CONSTRAINT "FederatedMessageTombstone_creatorId_fkey";

ALTER TABLE "FederatedMessageTombstone"
DROP COLUMN "creatorId";

ALTER TABLE "FederatedMessageTombstone"
RENAME COLUMN "originSeq" TO "messageSeq";

ALTER TABLE "FederatedMessageTombstone"
RENAME CONSTRAINT "FederatedMessageTombstone_origin_seq_check"
TO "FederatedMessageTombstone_message_seq_check";

CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key"
ON "FederatedMessageTombstone" ("threadId", "sourceDomain", "messageSeq");
