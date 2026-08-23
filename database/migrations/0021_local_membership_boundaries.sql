ALTER TABLE "ThreadParticipant"
  ADD COLUMN "afterSeq" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "leftSeq" integer;

ALTER TABLE "ThreadParticipant"
  ADD CONSTRAINT "ThreadParticipant_after_seq_check" CHECK ("afterSeq" >= 0),
  ADD CONSTRAINT "ThreadParticipant_left_seq_check" CHECK ("leftSeq" IS NULL OR "leftSeq" > 0);

ALTER TABLE "Message" ALTER COLUMN creator DROP NOT NULL;

UPDATE "Message"
SET creator = NULL
WHERE "contentType" = 'SYSTEM';

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_system_creator_check" CHECK (
    ("contentType" = 'SYSTEM' AND creator IS NULL)
    OR ("contentType" <> 'SYSTEM' AND creator IS NOT NULL)
  );
