-- This release intentionally has no data-compatibility path. The identity, roster,
-- and relationship projections are replaced atomically with their source-correct forms.

DROP TABLE IF EXISTS "FederatedGroupMember" CASCADE;
DROP TABLE IF EXISTS "FederatedMemberProfile" CASCADE;
DROP TABLE IF EXISTS "FederatedProfile" CASCADE;
DROP TABLE IF EXISTS "ClientGroupMetaMemberFeed" CASCADE;
DROP TABLE IF EXISTS "ClientGroupMetaFeedTarget" CASCADE;
DROP TABLE IF EXISTS "GroupMetaMemberFeed" CASCADE;
DROP TABLE IF EXISTS "GroupMetaFeedTarget" CASCADE;

DROP TABLE "ThreadParticipant" CASCADE;
DROP TABLE "RelationshipIntent" CASCADE;
DROP TABLE "RelationshipPair" CASCADE;

ALTER TABLE "MessageThread"
  DROP CONSTRAINT IF EXISTS "MessageThread_groupUserId_fkey",
  DROP CONSTRAINT IF EXISTS "MessageThread_groupUserId_type_check";
DROP INDEX IF EXISTS "MessageThread_groupUserId_key";

DROP TABLE "Group" CASCADE;

ALTER TABLE "User"
  DROP CONSTRAINT IF EXISTS "User_isGroup_sigil_check",
  DROP COLUMN IF EXISTS "hashPwd",
  DROP COLUMN IF EXISTS "isGroup",
  DROP COLUMN IF EXISTS "isDeleted",
  DROP COLUMN IF EXISTS "remoteProfileRev",
  DROP COLUMN IF EXISTS "stateFeedAllocatedThrough",
  DROP COLUMN IF EXISTS "mustChangePassword",
  DROP COLUMN IF EXISTS "readRevision",
  ADD COLUMN "sourceDomain" varchar(63) DEFAULT 'local' NOT NULL,
  ADD COLUMN availability varchar(16) DEFAULT 'AVAILABLE' NOT NULL;
DROP INDEX IF EXISTS "User_account_domain_key";
CREATE UNIQUE INDEX "User_account_domain_sourceDomain_key"
  ON "User" (account, domain, "sourceDomain");
CREATE INDEX "User_address_idx" ON "User" (account, domain);
CREATE INDEX "User_source_address_idx" ON "User" ("sourceDomain", account, domain);
ALTER TABLE "User"
  ADD CONSTRAINT "User_account_check" CHECK (account NOT LIKE '!%'),
  ADD CONSTRAINT "User_availability_check"
    CHECK (availability IN ('AVAILABLE', 'REMOVED'));

CREATE TABLE "Account" (
  id integer PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
  "hashPwd" varchar(127),
  "mustChangePassword" boolean DEFAULT false NOT NULL,
  "disabledAt" timestamp(3) with time zone,
  "stateFeedAllocatedThrough" integer DEFAULT 0 NOT NULL,
  "readRevision" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "Group" (
  id serial PRIMARY KEY,
  account varchar(31) NOT NULL,
  domain varchar(63) DEFAULT 'local' NOT NULL,
  name varchar(30) NOT NULL,
  avatar text DEFAULT '' NOT NULL,
  description varchar(255) DEFAULT '' NOT NULL,
  "profileRev" integer DEFAULT 0 NOT NULL,
  "remoteGroupMetaFeedId" bigint,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "dissolvedAt" timestamp(3) with time zone,
  CONSTRAINT "Group_account_sigil_check" CHECK (account LIKE '!%'),
  CONSTRAINT "Group_profileRev_check" CHECK ("profileRev" >= 0)
);
CREATE UNIQUE INDEX "Group_account_domain_key" ON "Group" (account, domain);

ALTER TABLE "MessageThread"
  DROP COLUMN "groupUserId",
  ADD COLUMN "groupId" integer;
CREATE UNIQUE INDEX "MessageThread_groupId_key" ON "MessageThread" ("groupId");
ALTER TABLE "MessageThread"
  ADD CONSTRAINT "MessageThread_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "MessageThread_groupId_type_check"
    CHECK ("federationTruncated" OR ((type = 'P2P') = ("groupId" IS NULL)));

CREATE TABLE "ThreadMember" (
  id serial PRIMARY KEY,
  "threadId" integer NOT NULL,
  "userId" integer NOT NULL,
  role "GroupRole",
  "left" boolean DEFAULT false NOT NULL,
  "lastSentSeq" integer,
  "joinedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "messageVisibleBeforeSeq" bigint,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ThreadMember_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE RESTRICT,
  CONSTRAINT "ThreadMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT,
  CONSTRAINT "ThreadMember_lastSentSeq_check"
    CHECK ("lastSentSeq" IS NULL OR "lastSentSeq" > 0),
  CONSTRAINT "ThreadMember_messageVisibleBeforeSeq_check"
    CHECK ("messageVisibleBeforeSeq" IS NULL OR "messageVisibleBeforeSeq" > 1)
);
CREATE UNIQUE INDEX "ThreadMember_threadId_userId_key"
  ON "ThreadMember" ("threadId", "userId");
CREATE UNIQUE INDEX "ThreadMember_id_threadId_key"
  ON "ThreadMember" (id, "threadId");
CREATE INDEX "ThreadMember_threadId_left_lastSentSeq_idx"
  ON "ThreadMember" ("threadId", "left", "lastSentSeq");
CREATE UNIQUE INDEX "ThreadMember_one_current_owner_key"
  ON "ThreadMember" ("threadId") WHERE role = 'OWNER' AND "left" = false;

CREATE TABLE "ThreadParticipant" (
  id integer PRIMARY KEY REFERENCES "ThreadMember"(id) ON DELETE CASCADE,
  "lastReadSeq" integer,
  "readRevision" integer DEFAULT 0 NOT NULL,
  muted boolean DEFAULT false NOT NULL,
  blocked boolean DEFAULT false NOT NULL,
  pinned boolean DEFAULT false NOT NULL,
  "pinnedAt" timestamp(3) with time zone,
  "clearedSeq" integer,
  alias varchar(64),
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ThreadParticipant_cleared_seq_check"
    CHECK ("clearedSeq" IS NULL OR "clearedSeq" >= 0)
);

CREATE TABLE "RelationshipPair" (
  id bigserial PRIMARY KEY,
  kind varchar(16) NOT NULL,
  "endpointAType" varchar(8) NOT NULL,
  "endpointAAccount" varchar(31) NOT NULL,
  "endpointADomain" varchar(63) NOT NULL,
  "endpointBType" varchar(8) NOT NULL,
  "endpointBAccount" varchar(31) NOT NULL,
  "endpointBDomain" varchar(63) NOT NULL,
  "threadId" integer REFERENCES "MessageThread"(id) ON DELETE SET NULL,
  active boolean DEFAULT false NOT NULL,
  revision integer DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "RelationshipPair_kind_check" CHECK (kind IN ('P2P', 'GROUP_MEMBER')),
  CONSTRAINT "RelationshipPair_endpoint_type_check" CHECK (
    "endpointAType" IN ('USER', 'GROUP') AND "endpointBType" IN ('USER', 'GROUP')
    AND ((kind = 'P2P' AND "endpointAType" = 'USER' AND "endpointBType" = 'USER')
      OR (kind = 'GROUP_MEMBER' AND "endpointAType" <> "endpointBType"))
  ),
  CONSTRAINT "RelationshipPair_distinct_endpoints_check" CHECK (
    ("endpointAType", "endpointAAccount", "endpointADomain") <>
    ("endpointBType", "endpointBAccount", "endpointBDomain")
  ),
  CONSTRAINT "RelationshipPair_revision_check" CHECK (revision >= 0)
);
CREATE UNIQUE INDEX "RelationshipPair_endpoints_key" ON "RelationshipPair" (
  "endpointAType", "endpointAAccount", "endpointADomain",
  "endpointBType", "endpointBAccount", "endpointBDomain"
);
CREATE INDEX "RelationshipPair_endpointA_idx" ON "RelationshipPair"
  ("endpointAType", "endpointAAccount", "endpointADomain", active);
CREATE INDEX "RelationshipPair_endpointB_idx" ON "RelationshipPair"
  ("endpointBType", "endpointBAccount", "endpointBDomain", active);

CREATE TABLE "RelationshipIntent" (
  id bigserial NOT NULL,
  "pairId" bigint NOT NULL REFERENCES "RelationshipPair"(id) ON DELETE CASCADE,
  "authorSide" varchar(1) NOT NULL,
  status "RelationshipIntentStatus" NOT NULL,
  note varchar(255) DEFAULT '' NOT NULL,
  "requestedAt" timestamp(3) with time zone,
  "expiresAt" timestamp(3) with time zone,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "RelationshipIntent_pkey" PRIMARY KEY ("pairId", "authorSide"),
  CONSTRAINT "RelationshipIntent_authorSide_check" CHECK ("authorSide" IN ('A', 'B')),
  CONSTRAINT "RelationshipIntent_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status = 'ACCEPTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NULL)
    OR (status = 'REVOKED' AND "expiresAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "RelationshipIntent_id_key" ON "RelationshipIntent" (id);

ALTER TABLE "GroupAuditLog" RENAME COLUMN "groupUserId" TO "groupId";
ALTER INDEX IF EXISTS "GroupAuditLog_groupUserId_at_idx"
  RENAME TO "GroupAuditLog_groupId_at_idx";

CREATE TABLE "GroupMetaFeedTarget" (
  "targetPeerDomain" varchar(63) NOT NULL REFERENCES "FederatedPeer"(domain) ON DELETE CASCADE,
  "groupId" integer NOT NULL REFERENCES "Group"(id) ON DELETE CASCADE,
  "allocatedThrough" bigint DEFAULT 0 NOT NULL,
  "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaFeedTarget_pkey" PRIMARY KEY ("targetPeerDomain", "groupId"),
  CONSTRAINT "GroupMetaFeedTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0),
  CONSTRAINT "GroupMetaFeedTarget_oldestAvailableAfter_check"
    CHECK ("oldestAvailableAfter" >= 0 AND "oldestAvailableAfter" <= "allocatedThrough")
);

CREATE TABLE "GroupMetaMemberFeed" (
  "targetPeerDomain" varchar(63) NOT NULL REFERENCES "FederatedPeer"(domain) ON DELETE CASCADE,
  "groupId" integer NOT NULL REFERENCES "Group"(id) ON DELETE CASCADE,
  "feedId" bigint NOT NULL,
  "memberAccount" varchar(31) NOT NULL,
  "memberDomain" varchar(63) NOT NULL,
  operation "GroupMetaMemberOperation" NOT NULL,
  body jsonb NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY ("targetPeerDomain", "groupId", "feedId"),
  CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (
    (operation = 'UPSERT' AND body <> '{}'::jsonb)
      OR (operation = 'DELETE' AND body = '{}'::jsonb)
  )
);
CREATE INDEX "GroupMetaMemberFeed_member_feed_idx" ON "GroupMetaMemberFeed"
  ("targetPeerDomain", "groupId", "memberDomain", "memberAccount", "feedId");

CREATE TABLE "ClientGroupMetaFeedTarget" (
  "accountId" integer NOT NULL REFERENCES "Account"(id) ON DELETE CASCADE,
  "groupId" integer NOT NULL REFERENCES "Group"(id) ON DELETE CASCADE,
  "allocatedThrough" bigint DEFAULT 0 NOT NULL,
  "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientGroupMetaFeedTarget_pkey" PRIMARY KEY ("accountId", "groupId"),
  CONSTRAINT "ClientGroupMetaFeedTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0),
  CONSTRAINT "ClientGroupMetaFeedTarget_oldestAvailableAfter_check"
    CHECK ("oldestAvailableAfter" >= 0 AND "oldestAvailableAfter" <= "allocatedThrough")
);

CREATE TABLE "ClientGroupMetaMemberFeed" (
  "accountId" integer NOT NULL REFERENCES "Account"(id) ON DELETE CASCADE,
  "groupId" integer NOT NULL REFERENCES "Group"(id) ON DELETE CASCADE,
  "feedId" bigint NOT NULL,
  "memberAccount" varchar(31) NOT NULL,
  "memberDomain" varchar(63) NOT NULL,
  operation "GroupMetaMemberOperation" NOT NULL,
  body jsonb NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientGroupMetaMemberFeed_pkey" PRIMARY KEY ("accountId", "groupId", "feedId"),
  CONSTRAINT "ClientGroupMetaMemberFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "ClientGroupMetaMemberFeed_body_check" CHECK (
    (operation = 'UPSERT' AND body <> '{}'::jsonb)
      OR (operation = 'DELETE' AND body = '{}'::jsonb)
  )
);
CREATE INDEX "ClientGroupMetaMemberFeed_member_feed_idx" ON "ClientGroupMetaMemberFeed"
  ("accountId", "groupId", "memberDomain", "memberAccount", "feedId");

-- Local control-plane tables must never reference profile-only external users.
ALTER TABLE "UserPreference" DROP CONSTRAINT IF EXISTS "UserPreference_userId_fkey";
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ThreadAudience" DROP CONSTRAINT IF EXISTS "ThreadAudience_localUserId_fkey";
ALTER TABLE "ThreadAudience" ADD CONSTRAINT "ThreadAudience_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "Admin" DROP CONSTRAINT IF EXISTS "Admin_userId_fkey";
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "MessageReport" DROP CONSTRAINT IF EXISTS "MessageReport_reporterId_fkey";
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "PushToken" DROP CONSTRAINT IF EXISTS "PushToken_userId_fkey";
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "UploadSession" DROP CONSTRAINT IF EXISTS "UploadSession_creatorId_fkey";
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ClientStateFeed" DROP CONSTRAINT IF EXISTS "ClientStateFeed_userId_fkey";
ALTER TABLE "ClientStateFeed" ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "GroupRequestProjection" DROP CONSTRAINT IF EXISTS "GroupRequestProjection_managerUserId_fkey";
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "ClientMessageFeedTarget" DROP CONSTRAINT IF EXISTS "ClientMessageFeedTarget_userId_fkey";
ALTER TABLE "ClientMessageFeedTarget" ADD CONSTRAINT "ClientMessageFeedTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "ClientMessageFeed" DROP CONSTRAINT IF EXISTS "ClientMessageFeed_userId_fkey";
ALTER TABLE "ClientMessageFeed" ADD CONSTRAINT "ClientMessageFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "ClientMessageTombstoneFeed" DROP CONSTRAINT IF EXISTS "ClientMessageTombstoneFeed_userId_fkey";
ALTER TABLE "ClientMessageTombstoneFeed" ADD CONSTRAINT "ClientMessageTombstoneFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "FederatedFriendRequest" DROP CONSTRAINT IF EXISTS "FederatedFriendRequest_localUserId_fkey";
ALTER TABLE "FederatedFriendRequest" ADD CONSTRAINT "FederatedFriendRequest_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "LoginCode" DROP CONSTRAINT IF EXISTS "LoginCode_userId_fkey";
ALTER TABLE "LoginCode" ADD CONSTRAINT "LoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "SessionToken" DROP CONSTRAINT IF EXISTS "SessionToken_userId_fkey";
ALTER TABLE "SessionToken" ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "DiagnosticsReport" DROP CONSTRAINT IF EXISTS "DiagnosticsReport_reporterUserId_fkey";
ALTER TABLE "DiagnosticsReport" ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "UserQuotaPolicy" DROP CONSTRAINT IF EXISTS "UserQuotaPolicy_userId_fkey";
ALTER TABLE "UserQuotaPolicy" ADD CONSTRAINT "UserQuotaPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "UserQuotaDailyUsage" DROP CONSTRAINT IF EXISTS "UserQuotaDailyUsage_userId_fkey";
ALTER TABLE "UserQuotaDailyUsage" ADD CONSTRAINT "UserQuotaDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "UserQuotaFileByteUsage" DROP CONSTRAINT IF EXISTS "UserQuotaFileByteUsage_userId_fkey";
ALTER TABLE "UserQuotaFileByteUsage" ADD CONSTRAINT "UserQuotaFileByteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "UserQuotaDailyAllowance" DROP CONSTRAINT IF EXISTS "UserQuotaDailyAllowance_userId_fkey";
ALTER TABLE "UserQuotaDailyAllowance" ADD CONSTRAINT "UserQuotaDailyAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"(id) ON DELETE CASCADE;
