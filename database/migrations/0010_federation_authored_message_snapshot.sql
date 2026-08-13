ALTER TABLE "Message"
ADD COLUMN "federationAuthoredSnapshot" jsonb;

ALTER TABLE "PendingMedia"
ADD COLUMN "federationAuthoredSnapshot" jsonb;
