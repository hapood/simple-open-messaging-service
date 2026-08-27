ALTER TABLE "ThreadParticipant"
  ADD COLUMN "lastSentSeq" integer;

ALTER TABLE "ThreadParticipant"
  ADD CONSTRAINT "ThreadParticipant_lastSentSeq_check"
  CHECK ("lastSentSeq" IS NULL OR "lastSentSeq" > 0);
