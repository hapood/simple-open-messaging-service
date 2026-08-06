CREATE TYPE "ThreadAudienceScope" AS ENUM ('THREAD', 'CREATOR');

ALTER TABLE "ThreadAudience"
  ADD COLUMN "scope" "ThreadAudienceScope" NOT NULL DEFAULT 'THREAD',
  ADD COLUMN "creatorUserId" INTEGER,
  ADD COLUMN "deliverThroughChangeId" BIGINT,
  ADD CONSTRAINT "ThreadAudience_creatorUserId_fkey"
    FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "ThreadAudience_scope_check" CHECK (
    (
      "scope" = 'THREAD'
      AND "creatorUserId" IS NULL
      AND "deliverThroughChangeId" IS NULL
    )
    OR
    (
      "scope" = 'CREATOR'
      AND "targetDomain" <> 'local'
      AND "localUserId" IS NULL
      AND "creatorUserId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ThreadAudience_deliverThroughChangeId_check" CHECK (
    "deliverThroughChangeId" IS NULL OR "deliverThroughChangeId" > 0
  );

DROP INDEX "ThreadAudience_local_key";
DROP INDEX "ThreadAudience_peer_key";

CREATE UNIQUE INDEX "ThreadAudience_local_key"
  ON "ThreadAudience" ("targetDomain", "localUserId", "threadId")
  WHERE "targetDomain" = 'local' AND "scope" = 'THREAD';

CREATE UNIQUE INDEX "ThreadAudience_peer_key"
  ON "ThreadAudience" ("targetDomain", "threadId")
  WHERE "targetDomain" <> 'local' AND "scope" = 'THREAD';

CREATE UNIQUE INDEX "ThreadAudience_peer_creator_key"
  ON "ThreadAudience" ("targetDomain", "threadId", "creatorUserId")
  WHERE "scope" = 'CREATOR';

CREATE INDEX "ThreadAudience_creator_access_idx"
  ON "ThreadAudience" ("creatorUserId", "threadId", "deliverThroughChangeId")
  WHERE "scope" = 'CREATOR';
