ALTER TABLE "ThreadAudience"
  DROP CONSTRAINT "ThreadAudience_visibleRange_check";

ALTER TABLE "ThreadAudience"
  RENAME COLUMN "visibleFromMessageId" TO "startAfterOriginSeq";

ALTER TABLE "ThreadAudience"
  RENAME COLUMN "visibleThroughMessageId" TO "visibleThroughOriginSeq";

-- 0023 has not been a production discovery source. Existing rows describe freshly-created P2P
-- access, whose exact pre-message boundary is -1; closed rows end at the thread's committed max seq.
UPDATE "ThreadAudience"
SET
  "startAfterOriginSeq" = -1,
  "visibleThroughOriginSeq" = CASE
    WHEN "visibleThroughOriginSeq" IS NULL THEN NULL
    ELSE COALESCE(
      (SELECT MAX(message.seq) FROM "Message" message WHERE message."threadId" = "ThreadAudience"."threadId"),
      -1
    )
  END;

ALTER TABLE "ThreadAudience"
  ALTER COLUMN "startAfterOriginSeq" TYPE INTEGER
    USING "startAfterOriginSeq"::INTEGER,
  ALTER COLUMN "visibleThroughOriginSeq" TYPE INTEGER
    USING "visibleThroughOriginSeq"::INTEGER;

ALTER TABLE "ThreadAudience"
  ADD CONSTRAINT "ThreadAudience_visibleRange_check" CHECK (
    "startAfterOriginSeq" >= -1
    AND (
      "visibleThroughOriginSeq" IS NULL
      OR "visibleThroughOriginSeq" >= "startAfterOriginSeq"
    )
  );

CREATE TABLE "DiscoveryTarget" (
  "id" BIGSERIAL PRIMARY KEY,
  "targetDomain" VARCHAR(63) NOT NULL,
  "localUserId" INTEGER,
  "latestChangeId" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiscoveryTarget_identity_check" CHECK (
    ("targetDomain" = 'local' AND "localUserId" IS NOT NULL)
    OR
    ("targetDomain" <> 'local' AND "localUserId" IS NULL)
  ),
  CONSTRAINT "DiscoveryTarget_latestChangeId_check" CHECK ("latestChangeId" >= 0),
  CONSTRAINT "DiscoveryTarget_localUserId_fkey"
    FOREIGN KEY ("localUserId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE UNIQUE INDEX "DiscoveryTarget_local_key"
  ON "DiscoveryTarget" ("targetDomain", "localUserId")
  WHERE "targetDomain" = 'local';

CREATE UNIQUE INDEX "DiscoveryTarget_peer_key"
  ON "DiscoveryTarget" ("targetDomain")
  WHERE "targetDomain" <> 'local';

CREATE TABLE "DiscoveryChange" (
  "targetId" BIGINT NOT NULL,
  "changeId" BIGINT NOT NULL,
  "audienceId" BIGINT NOT NULL,
  "threadId" INTEGER NOT NULL,
  "messageId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiscoveryChange_pkey" PRIMARY KEY ("targetId", "changeId"),
  CONSTRAINT "DiscoveryChange_changeId_check" CHECK ("changeId" > 0),
  CONSTRAINT "DiscoveryChange_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "DiscoveryTarget"("id") ON DELETE CASCADE,
  CONSTRAINT "DiscoveryChange_audienceId_fkey"
    FOREIGN KEY ("audienceId") REFERENCES "ThreadAudience"("id") ON DELETE CASCADE,
  CONSTRAINT "DiscoveryChange_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "DiscoveryChange_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "DiscoveryChange_target_message_key"
  ON "DiscoveryChange" ("targetId", "messageId");

CREATE INDEX "DiscoveryChange_audience_idx"
  ON "DiscoveryChange" ("audienceId");

CREATE TABLE "FederationPullCursor" (
  "peerDomain" VARCHAR(63) PRIMARY KEY,
  "remoteHwm" BIGINT NOT NULL DEFAULT 0,
  "lastAdvertisedHwm" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FederationPullCursor_remoteHwm_check" CHECK ("remoteHwm" >= 0),
  CONSTRAINT "FederationPullCursor_lastAdvertisedHwm_check" CHECK ("lastAdvertisedHwm" >= 0),
  CONSTRAINT "FederationPullCursor_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE
);
