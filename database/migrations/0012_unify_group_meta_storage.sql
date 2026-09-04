DROP TABLE "ClientGroupMetaMemberFeed";
DROP TABLE "ClientGroupMetaFeedTarget";
DROP TABLE "GroupMetaMemberFeed";
DROP TABLE "GroupMetaProfileFeed";
DROP TABLE "GroupMetaFeedTarget";
DROP TABLE "ThreadMember";

ALTER TABLE "Group"
  DROP COLUMN "remoteGroupMetaFeedId";

ALTER TABLE "ThreadAudience"
  ADD COLUMN "groupMetaVisibleAfter" bigint DEFAULT 0 NOT NULL;

ALTER TABLE "ThreadAudience"
  ADD CONSTRAINT "ThreadAudience_groupMetaVisibleAfter_check"
  CHECK ("groupMetaVisibleAfter" >= 0);

CREATE UNIQUE INDEX "RelationshipPair_p2p_threadId_key"
  ON "RelationshipPair" ("threadId")
  WHERE kind = 'P2P' AND "threadId" IS NOT NULL;

CREATE INDEX "RelationshipPair_thread_kind_active_idx"
  ON "RelationshipPair" ("threadId", kind, active);

CREATE TABLE "GroupMetaFeed" (
  "groupId" integer PRIMARY KEY NOT NULL,
  "feedEndId" bigint DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaFeed_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"(id)
    ON DELETE CASCADE,
  CONSTRAINT "GroupMetaFeed_feedEndId_check"
    CHECK ("feedEndId" >= 0)
);

CREATE TABLE "GroupMetaMemberFeed" (
  "groupId" integer NOT NULL,
  "feedId" bigint NOT NULL,
  "memberUserId" integer NOT NULL,
  operation "GroupMetaMemberOperation" NOT NULL,
  body jsonb NOT NULL,
  "fullSyncRunId" bigint,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaMemberFeed_pkey"
    PRIMARY KEY ("groupId", "feedId"),
  CONSTRAINT "GroupMetaMemberFeed_memberUserId_fkey"
    FOREIGN KEY ("memberUserId") REFERENCES "User"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "GroupMetaMemberFeed_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"(id)
    ON DELETE CASCADE,
  CONSTRAINT "GroupMetaMemberFeed_fullSyncRunId_fkey"
    FOREIGN KEY ("fullSyncRunId") REFERENCES "DurableTask"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "GroupMetaMemberFeed_feedId_check"
    CHECK ("feedId" > 0),
  CONSTRAINT "GroupMetaMemberFeed_body_check"
    CHECK (
      jsonb_typeof(body) = 'object'
      AND (
        (operation = 'UPSERT' AND body <> '{}'::jsonb)
        OR (operation = 'DEPART' AND body = '{}'::jsonb)
      )
    )
);

CREATE INDEX "GroupMetaMemberFeed_member_feed_idx"
  ON "GroupMetaMemberFeed" (
    "groupId",
    "memberUserId",
    "feedId"
  );

CREATE INDEX "GroupMetaMemberFeed_full_sync_idx"
  ON "GroupMetaMemberFeed" ("groupId", "fullSyncRunId", "feedId");

CREATE TABLE "GroupMetaProfileFeed" (
  "groupId" integer PRIMARY KEY NOT NULL,
  "feedId" bigint NOT NULL,
  "profileRev" integer NOT NULL,
  "fullSyncRunId" bigint,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaProfileFeed_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"(id)
    ON DELETE CASCADE,
  CONSTRAINT "GroupMetaProfileFeed_fullSyncRunId_fkey"
    FOREIGN KEY ("fullSyncRunId") REFERENCES "DurableTask"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "GroupMetaProfileFeed_feedId_check"
    CHECK ("feedId" > 0),
  CONSTRAINT "GroupMetaProfileFeed_profileRev_check"
    CHECK ("profileRev" >= 0)
);
