ALTER TABLE "User"
ADD COLUMN "readRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ThreadParticipant"
ADD COLUMN "readRevision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ThreadParticipant_userId_readRevision_idx"
ON "ThreadParticipant" ("userId", "readRevision");
