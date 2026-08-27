ALTER TABLE "Message"
  ADD COLUMN "creatorAccount" varchar(31),
  ADD COLUMN "creatorDomain" varchar(63);

ALTER TABLE "PendingMedia"
  ADD COLUMN "creatorAccount" varchar(31),
  ADD COLUMN "creatorDomain" varchar(63);

UPDATE "Message" message
SET "creatorAccount" = author.account,
    "creatorDomain" = author.domain
FROM "User" author
WHERE message.creator = author.id;

UPDATE "PendingMedia" pending
SET "creatorAccount" = author.account,
    "creatorDomain" = author.domain
FROM "User" author
WHERE pending."creatorId" = author.id;

ALTER TABLE "PendingMedia"
  ALTER COLUMN "creatorAccount" SET NOT NULL,
  ALTER COLUMN "creatorDomain" SET NOT NULL;

ALTER TABLE "Message" DROP CONSTRAINT "Message_creator_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_system_creator_check";
DROP INDEX "Message_creator_idx";
DROP INDEX "Message_threadId_creator_originSeq_key";
DROP INDEX "PendingMedia_threadId_creatorId_originSeq_key";

ALTER TABLE "Message" DROP COLUMN creator;
ALTER TABLE "PendingMedia" DROP COLUMN "creatorId";

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_system_creator_check"
  CHECK (("contentType" = 'SYSTEM' AND "creatorAccount" IS NULL AND "creatorDomain" IS NULL)
      OR ("contentType" <> 'SYSTEM' AND "creatorAccount" IS NOT NULL AND "creatorDomain" IS NOT NULL));

CREATE INDEX "Message_creator_address_idx"
  ON "Message" ("creatorAccount", "creatorDomain");
CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key"
  ON "Message" ("threadId", "creatorAccount", "creatorDomain", "originSeq");
CREATE UNIQUE INDEX "PendingMedia_threadId_creator_originSeq_key"
  ON "PendingMedia" ("threadId", "creatorAccount", "creatorDomain", "originSeq");
