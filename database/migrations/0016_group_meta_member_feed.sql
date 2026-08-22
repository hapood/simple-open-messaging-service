CREATE TYPE "GroupMetaMemberOperation" AS ENUM ('UPSERT', 'DELETE');

ALTER TABLE "Group" ADD COLUMN "remoteGroupMetaFeedId" bigint;

DROP TABLE "FederationMemberProfileSource";
DROP TABLE "FederationMemberProfilePublication";
DELETE FROM "FederatedMemberProfile";

ALTER TYPE "PeerStateEventType" RENAME TO "PeerStateEventType_old";
CREATE TYPE "PeerStateEventType" AS ENUM (
  'PROFILE',
  'RELATIONSHIP_INTENT',
  'GROUP_META_FEED_HEAD'
);

DELETE FROM "PeerStateFeed"
WHERE "eventType"::text IN ('MEMBER_PROFILE', 'GROUP_META');
ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_subject_check";
ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

ALTER TABLE "ClientStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

DROP TYPE "PeerStateEventType_old";

ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_subject_check"
  CHECK (
    ("eventType" = 'RELATIONSHIP_INTENT' AND "subjectAccount" <> '' AND "subjectDomain" <> '')
    OR
    ("eventType" <> 'RELATIONSHIP_INTENT' AND "subjectAccount" = '' AND "subjectDomain" = '')
  );

CREATE TABLE "GroupMetaMemberFeed" (
  "targetPeerDomain" varchar(63) NOT NULL,
  "groupUserId" integer NOT NULL,
  "feedId" bigint NOT NULL,
  "memberAccount" varchar(31) NOT NULL,
  "memberDomain" varchar(63) NOT NULL,
  "memberRev" integer NOT NULL,
  "operation" "GroupMetaMemberOperation" NOT NULL,
  "body" jsonb NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaMemberFeed_pkey"
    PRIMARY KEY ("targetPeerDomain", "groupUserId", "feedId"),
  CONSTRAINT "GroupMetaMemberFeed_member_rev_key"
    UNIQUE ("targetPeerDomain", "groupUserId", "memberDomain", "memberAccount", "memberRev"),
  CONSTRAINT "GroupMetaMemberFeed_targetPeerDomain_fkey"
    FOREIGN KEY ("targetPeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "GroupMetaMemberFeed_groupUserId_fkey"
    FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "GroupMetaMemberFeed_memberRev_check" CHECK ("memberRev" >= 0),
  CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (
    ("operation" = 'UPSERT' AND "body" <> '{}'::jsonb)
    OR
    ("operation" = 'DELETE' AND "body" = '{}'::jsonb)
  )
);

CREATE INDEX "GroupMetaMemberFeed_member_feed_idx"
  ON "GroupMetaMemberFeed" (
    "targetPeerDomain", "groupUserId", "memberDomain", "memberAccount", "feedId"
  );

CREATE TABLE "GroupMetaFeedTarget" (
  "targetPeerDomain" varchar(63) NOT NULL,
  "groupUserId" integer NOT NULL,
  "allocatedThrough" bigint DEFAULT 0 NOT NULL,
  "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaFeedTarget_pkey" PRIMARY KEY ("targetPeerDomain", "groupUserId"),
  CONSTRAINT "GroupMetaFeedTarget_targetPeerDomain_fkey"
    FOREIGN KEY ("targetPeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "GroupMetaFeedTarget_groupUserId_fkey"
    FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "GroupMetaFeedTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0),
  CONSTRAINT "GroupMetaFeedTarget_oldestAvailableAfter_check"
    CHECK ("oldestAvailableAfter" >= 0 AND "oldestAvailableAfter" <= "allocatedThrough")
);
