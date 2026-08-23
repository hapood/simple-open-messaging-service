DROP INDEX "ThreadParticipant_one_established_group_owner_key";

ALTER TABLE "ThreadParticipant" DROP COLUMN state;

DROP TYPE "ThreadParticipantState";

CREATE UNIQUE INDEX "ThreadParticipant_one_group_owner_key"
  ON "ThreadParticipant" ("threadId")
  WHERE role = 'OWNER';
