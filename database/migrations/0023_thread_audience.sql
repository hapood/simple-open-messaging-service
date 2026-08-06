CREATE TABLE "ThreadAudience" (
  "id" BIGSERIAL PRIMARY KEY,
  "targetDomain" VARCHAR(63) NOT NULL,
  "localUserId" INTEGER,
  "threadId" INTEGER NOT NULL,
  "accessEpoch" INTEGER NOT NULL,
  "visibleFromMessageId" BIGINT NOT NULL,
  "visibleThroughMessageId" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),

  CONSTRAINT "ThreadAudience_target_check" CHECK (
    ("targetDomain" = 'local' AND "localUserId" IS NOT NULL)
    OR
    ("targetDomain" <> 'local' AND "localUserId" IS NULL)
  ),
  CONSTRAINT "ThreadAudience_accessEpoch_check" CHECK ("accessEpoch" > 0),
  CONSTRAINT "ThreadAudience_visibleRange_check" CHECK (
    "visibleThroughMessageId" IS NULL OR "visibleThroughMessageId" >= "visibleFromMessageId"
  ),
  CONSTRAINT "ThreadAudience_localUserId_fkey"
    FOREIGN KEY ("localUserId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "ThreadAudience_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE UNIQUE INDEX "ThreadAudience_local_epoch_key"
  ON "ThreadAudience" ("targetDomain", "localUserId", "threadId", "accessEpoch")
  WHERE "targetDomain" = 'local';

CREATE UNIQUE INDEX "ThreadAudience_peer_epoch_key"
  ON "ThreadAudience" ("targetDomain", "threadId", "accessEpoch")
  WHERE "targetDomain" <> 'local';

CREATE INDEX "ThreadAudience_local_access_idx"
  ON "ThreadAudience" ("localUserId", "endedAt", "threadId")
  WHERE "targetDomain" = 'local';

CREATE INDEX "ThreadAudience_peer_access_idx"
  ON "ThreadAudience" ("targetDomain", "endedAt", "threadId")
  WHERE "targetDomain" <> 'local';

CREATE INDEX "Message_threadId_id_idx" ON "Message" ("threadId", "id");
