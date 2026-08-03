
-- ============================================================================
-- Squashed from 0000_baseline.sql
-- ============================================================================



-- CreateSchema

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'WEB', 'IOS');

-- CreateEnum
CREATE TYPE "MessageThreadType" AS ENUM ('P2P', 'GROUP');

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PURE_TEXT', 'INVITE', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO');

-- CreateEnum
CREATE TYPE "NotifyType" AS ENUM ('FRIEND_REQUEST');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "account" VARCHAR(31) NOT NULL,
    "hashPwd" VARCHAR(127) NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT NOT NULL DEFAULT '',
    "bio" VARCHAR(255) NOT NULL DEFAULT '',
    "isForeigner" BOOLEAN NOT NULL,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "domain" VARCHAR(63) NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "hasUrFriendReq" BOOLEAN NOT NULL DEFAULT false,
    "remoteUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "deviceId" VARCHAR(127),
    "platform" "PushPlatform" NOT NULL,
    "webP256dh" VARCHAR(255),
    "webAuth" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(127) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadParticipant" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "lastReadSeq" INTEGER,
    "role" "GroupRole",
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "alias" VARCHAR(64),
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" SERIAL NOT NULL,
    "userAId" INTEGER NOT NULL,
    "userBId" INTEGER NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "reqMessage" VARCHAR(255) NOT NULL DEFAULT '',
    "threadId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlock" (
    "id" SERIAL NOT NULL,
    "blockerId" INTEGER NOT NULL,
    "blockedId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" SERIAL NOT NULL,
    "type" "MessageThreadType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "curSeq" INTEGER NOT NULL DEFAULT -1,
    "lastMessageSeq" INTEGER,
    "lastMessagePreview" VARCHAR(255),
    "lastMessageSenderId" INTEGER,
    "lastMessageAt" TIMESTAMP(3),
    "federatedThreadId" TEXT,
    "originDomain" VARCHAR(255),
    "groupUserId" INTEGER,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" BIGSERIAL NOT NULL,
    "seq" INTEGER NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "content" JSONB NOT NULL,
    "threadId" INTEGER NOT NULL,
    "creator" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "clientMessageId" VARCHAR(36),
    "originSeq" INTEGER,
    "originServerTime" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "digest" VARCHAR(64) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "refs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("digest")
);

-- CreateTable
CREATE TABLE "MediaMessage" (
    "messageId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaMessage_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "Notify" (
    "id" BIGSERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "NotifyType" NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notify_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" BIGSERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "device" TEXT,
    "userAgent" VARCHAR(255),
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(32),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginIp" VARCHAR(64),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRefreshToken" (
    "id" BIGSERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userAgent" VARCHAR(255),
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(32),

    CONSTRAINT "AdminRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedPeer" (
    "domain" VARCHAR(63) NOT NULL,
    "trustLevel" VARCHAR(15) NOT NULL DEFAULT 'pending',
    "addedBy" VARCHAR(31),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trustedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "demotedAt" TIMESTAMP(3),
    "demoteReason" VARCHAR(255),
    "demotionCount" INTEGER NOT NULL DEFAULT 0,
    "blockedAt" TIMESTAMP(3),

    CONSTRAINT "FederatedPeer_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "FederatedPeerEvent" (
    "id" BIGSERIAL NOT NULL,
    "domain" VARCHAR(63) NOT NULL,
    "type" VARCHAR(15) NOT NULL,
    "reason" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedPeerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "S2SKeyCache" (
    "domain" VARCHAR(63) NOT NULL,
    "keyId" VARCHAR(127) NOT NULL,
    "publicKey" VARCHAR(127) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "S2SKeyCache_pkey" PRIMARY KEY ("domain","keyId")
);

-- CreateTable
CREATE TABLE "S2SFriendOpSeen" (
    "origin" VARCHAR(63) NOT NULL,
    "opId" VARCHAR(127) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "S2SFriendOpSeen_pkey" PRIMARY KEY ("origin","opId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_account_domain_key" ON "User"("account", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");

-- CreateIndex
CREATE INDEX "PushToken_userId_idx" ON "PushToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationToken_tokenHash_key" ON "NotificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "NotificationToken_userId_idx" ON "NotificationToken"("userId");

-- CreateIndex
CREATE INDEX "ThreadParticipant_threadId_idx" ON "ThreadParticipant"("threadId");

-- CreateIndex
CREATE INDEX "ThreadParticipant_userId_idx" ON "ThreadParticipant"("userId");

-- CreateIndex
CREATE INDEX "ThreadParticipant_userId_pinned_idx" ON "ThreadParticipant"("userId", "pinned");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadParticipant_userId_threadId_key" ON "ThreadParticipant"("userId", "threadId");

-- CreateIndex
CREATE INDEX "Friendship_userBId_idx" ON "Friendship"("userBId");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_userAId_userBId_key" ON "Friendship"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlock_blockerId_blockedId_key" ON "UserBlock"("blockerId", "blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_federatedThreadId_key" ON "MessageThread"("federatedThreadId");

-- CreateIndex
CREATE INDEX "MessageThread_groupUserId_idx" ON "MessageThread"("groupUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message"("clientMessageId");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_creator_idx" ON "Message"("creator");

-- CreateIndex
CREATE INDEX "Message_threadId_creator_originSeq_idx" ON "Message"("threadId", "creator", "originSeq");

-- CreateIndex
CREATE UNIQUE INDEX "Message_threadId_seq_key" ON "Message"("threadId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key" ON "Message"("threadId", "creator", "originSeq");

-- CreateIndex
CREATE INDEX "MediaAsset_refs_idx" ON "MediaAsset"("refs");

-- CreateIndex
CREATE INDEX "MediaMessage_digest_idx" ON "MediaMessage"("digest");

-- CreateIndex
CREATE INDEX "MediaMessage_threadId_idx" ON "MediaMessage"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_jti_key" ON "RefreshToken"("jti");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_userId_key" ON "Admin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRefreshToken_tokenHash_key" ON "AdminRefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRefreshToken_jti_key" ON "AdminRefreshToken"("jti");

-- CreateIndex
CREATE INDEX "AdminRefreshToken_adminId_idx" ON "AdminRefreshToken"("adminId");

-- CreateIndex
CREATE INDEX "AdminRefreshToken_familyId_idx" ON "AdminRefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "FederatedPeer_trustLevel_idx" ON "FederatedPeer"("trustLevel");

-- CreateIndex
CREATE INDEX "FederatedPeer_lastSuccessAt_idx" ON "FederatedPeer"("lastSuccessAt");

-- CreateIndex
CREATE INDEX "FederatedPeerEvent_domain_createdAt_idx" ON "FederatedPeerEvent"("domain", "createdAt");

-- CreateIndex
CREATE INDEX "FederatedPeerEvent_createdAt_idx" ON "FederatedPeerEvent"("createdAt");

-- CreateIndex
CREATE INDEX "S2SKeyCache_domain_idx" ON "S2SKeyCache"("domain");

-- AddForeignKey
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationToken" ADD CONSTRAINT "NotificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_creator_fkey" FOREIGN KEY ("creator") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaMessage" ADD CONSTRAINT "MediaMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaMessage" ADD CONSTRAINT "MediaMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRefreshToken" ADD CONSTRAINT "AdminRefreshToken_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Database invariants carried in SQL so a fresh reset recreates them exactly.
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupUserId_type_check"
  CHECK (("type" = 'P2P') = ("groupUserId" IS NULL));
ALTER TABLE "User" ADD CONSTRAINT "User_isGroup_sigil_check"
  CHECK (("account" LIKE '!%') = "isGroup");

-- Source: 20260709120000_invite_model/migration.sql

-- Invite-based friend-add (unified table) + drop Friendship/Notify.
-- See docs + plan: one Invite table (kind FRIEND/GROUP) replaces the Friendship request model and
-- (eventually, follow-up) the group-invite JWT-in-message trick. The Notify table existed solely for
-- the friend-request badge (the badge column hasUrFriendReq stays, now driven by InviteService).
-- Dev DB is mid-WIP and will be reset, so pending Friendship data is dropped without backfill.

-- ── new types ────────────────────────────────────────────────────────────────
CREATE TYPE "InviteKind" AS ENUM ('FRIEND', 'GROUP');
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED');

-- ── Invite table ─────────────────────────────────────────────────────────────
CREATE TABLE "Invite" (
    "id" BIGSERIAL NOT NULL,
    "kind" "InviteKind" NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "note" VARCHAR(255) NOT NULL DEFAULT '',
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "origin" VARCHAR(63) NOT NULL,
    "originId" VARCHAR(127) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- ── foreign keys ─────────────────────────────────────────────────────────────
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_toUserId_fkey"
    FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── indexes ──────────────────────────────────────────────────────────────────
-- Delivery dedup (local + cross-server): (origin, originId).
CREATE UNIQUE INDEX "Invite_origin_originId_key" ON "Invite"("origin", "originId");
-- Incoming list (friend-pending panel): toUserId + status + kind.
CREATE INDEX "Invite_toUserId_status_kind_idx" ON "Invite"("toUserId", "status", "kind");
-- Outgoing list.
CREATE INDEX "Invite_fromUserId_status_kind_idx" ON "Invite"("fromUserId", "status", "kind");
-- GROUP dedup + roster queries.
CREATE INDEX "Invite_kind_threadId_toUserId_status_idx" ON "Invite"("kind", "threadId", "toUserId", "status");

-- Duplicate = new overwrites old. Two partial unique indexes enforce "at most one PENDING":
--   FRIEND: per directed pair (threadId IS NULL for friend invites).
--   GROUP: per (invitee, group) regardless of inviter (a second admin inviting the same friend
--          refreshes the existing PENDING row).
CREATE UNIQUE INDEX "invite_friend_pending_uq"
    ON "Invite"("fromUserId", "toUserId")
    WHERE "kind" = 'FRIEND' AND "status" = 'PENDING' AND "threadId" IS NULL;
CREATE UNIQUE INDEX "invite_group_pending_uq"
    ON "Invite"("toUserId", "threadId")
    WHERE "kind" = 'GROUP' AND "status" = 'PENDING';

-- ── drop the superseded tables + types ───────────────────────────────────────
DROP TABLE IF EXISTS "Friendship" CASCADE;
DROP TABLE IF EXISTS "Notify" CASCADE;
DROP TYPE IF EXISTS "FriendshipStatus";
DROP TYPE IF EXISTS "NotifyType";

-- Source: 20260710120000_admin_rbac_tokenversion_audit/migration.sql

-- Admin RBAC + tokenVersion (global session revocation) + AdminActionLog audit trail.
-- Phase 1 security foundations (see src/admin). Additive only — no data loss.
-- AdminRole defaults to SUPER_ADMIN so the existing seed admin keeps full access.

-- ── new type ─────────────────────────────────────────────────────────────────
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VIEWER');

-- ── Admin: role + tokenVersion ───────────────────────────────────────────────
ALTER TABLE "Admin" ADD COLUMN "role" "AdminRole" NOT NULL DEFAULT 'SUPER_ADMIN';
ALTER TABLE "Admin" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- ── AdminActionLog ───────────────────────────────────────────────────────────
CREATE TABLE "AdminActionLog" (
    "id" BIGSERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "adminRole" "AdminRole" NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32),
    "targetId" VARCHAR(64),
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(255),
    "route" VARCHAR(255),
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" VARCHAR(255),
    "meta" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminActionLog_adminId_idx" ON "AdminActionLog"("adminId");
CREATE INDEX "AdminActionLog_at_idx" ON "AdminActionLog"("at");
CREATE INDEX "AdminActionLog_action_idx" ON "AdminActionLog"("action");

ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260710130000_pull_until_cursor/migration.sql

-- Federation pull cursor (Step 3 Phase B): the REMOTE server's thread seq this server has pulled up to.
-- Seeded by the `sinceSeq` carried in invite/invite-accept; advanced to the response latestSeq after each
-- pull. Used by 1:1 (peer's thread seq) and a GROUP mirror (origin's thread seq) — the unified catch-up
-- cursor. -1 = nothing pulled yet (the head). See `src/database/schema.ts`.
ALTER TABLE "MessageThread" ADD COLUMN "pullUntil" INTEGER NOT NULL DEFAULT -1;

-- Source: 20260710140000_rename_fed_group_account/migration.sql

-- Rename MessageThread.federatedThreadId → fedGroupAccount: the column holds the group's `!account`
-- (a ULID), the cross-server identity + on-wire group address — NOT a thread id. The old name + its
-- stale comment described an abandoned "thr_<rand>@<domain>" design. Pure rename, no data change.
ALTER TABLE "MessageThread" RENAME COLUMN "federatedThreadId" TO "fedGroupAccount";

-- Source: 20260710150000_pending_media/migration.sql

-- PendingMedia: in-flight media send/localize staging. A media Message is committed only after its
-- bytes are confirmed (uploaded locally / localized for federation); until then only this row exists
-- (no Message, no seq, nothing visible in the thread). On success the row is deleted as the real
-- Message+MediaMessage are created (promote); on failure it is marked `failed` and left (no auto-retry).
-- Created BEFORE the file write so a crash between "intent recorded" and "bytes confirmed" always
-- leaves an attributable, GC-reclaimable record. See `docs/overview/database.md`.
CREATE TABLE "PendingMedia" (
    "id" BIGSERIAL NOT NULL,
    "threadId" INTEGER NOT NULL,
    "creatorId" INTEGER NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "content" TEXT NOT NULL,
    "digest" VARCHAR(64),
    "clientMessageId" VARCHAR(36),
    "originSeq" INTEGER,
    "originDomain" VARCHAR(63),
    "originServerTime" TIMESTAMP(3),
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "failReason" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingMedia_pkey" PRIMARY KEY ("id")
);

-- LOCAL idempotency: a retried send resumes the same stage (NULL clientMessageId for federated rows
-- is distinct under Postgres unique semantics, so the two paths never collide).
CREATE UNIQUE INDEX "PendingMedia_clientMessageId_key" ON "PendingMedia"("clientMessageId");
-- FEDERATED pull dedup, mirroring Message's (threadId, creator, originSeq). NULL originSeq (local
-- rows) are distinct, so local stages coexist.
CREATE UNIQUE INDEX "PendingMedia_threadId_creatorId_originSeq_key" ON "PendingMedia"("threadId", "creatorId", "originSeq");

CREATE INDEX "PendingMedia_threadId_idx" ON "PendingMedia"("threadId");
CREATE INDEX "PendingMedia_status_createdAt_idx" ON "PendingMedia"("status", "createdAt");

ALTER TABLE "PendingMedia" ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260711120000_group_table_dual_revision/migration.sql

-- Group table: group-exclusive state (owner + roster revision). Identity (name/avatar/bio) stays on User.
CREATE TABLE "Group" (
    "id" SERIAL PRIMARY KEY,
    "groupUserId" INTEGER NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "rosterRev" INTEGER NOT NULL DEFAULT 0,
    "remoteRosterRev" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Group_groupUserId_key" ON "Group"("groupUserId");
CREATE INDEX "Group_ownerId_idx" ON "Group"("ownerId");
ALTER TABLE "Group" ADD CONSTRAINT "Group_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE;

-- Backfill: one Group row per existing group !-User identity row (owner = the active OWNER participant).
INSERT INTO "Group" ("groupUserId", "ownerId")
SELECT t."groupUserId", p."userId"
FROM "MessageThread" t
JOIN "ThreadParticipant" p ON p."threadId" = t."id" AND p."role" = 'OWNER' AND p."leftAt" IS NULL
WHERE t."groupUserId" IS NOT NULL
ON CONFLICT ("groupUserId") DO NOTHING;

-- User: profile revision (Int counter; replaces remoteUpdatedAt DateTime). The old timestamp cursor is
-- NOT type-convertible to the new Int revision — stubs re-probe on next chat-open (remoteProfileRev null).
ALTER TABLE "User" ADD COLUMN "profileRev" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "remoteProfileRev" INTEGER;
ALTER TABLE "User" DROP COLUMN "remoteUpdatedAt";

-- MessageThread: fedGroupAccount/originDomain moved to groupUser.account/domain; groupUserId @unique
-- replaces fedGroupAccount @unique as the one-thread-per-group guarantee.
ALTER TABLE "MessageThread" DROP COLUMN "fedGroupAccount";
ALTER TABLE "MessageThread" DROP COLUMN "originDomain";
CREATE UNIQUE INDEX "MessageThread_groupUserId_key" ON "MessageThread"("groupUserId");

-- Source: 20260711130000_thread_revision/migration.sql

-- User: thread-list revision cursor (per-user, monotonic; bumped on thread add/delete).
ALTER TABLE "User" ADD COLUMN "threadRevision" INTEGER NOT NULL DEFAULT 0;

-- ThreadRevisionDirection enum
CREATE TYPE "ThreadRevisionDirection" AS ENUM ('ADD', 'DELETE');

-- Per-user thread-list operation log (one ADD + one DELETE per user×thread).
CREATE TABLE "ThreadRevision" (
    "id"        BIGSERIAL    PRIMARY KEY,
    "userId"    INTEGER      NOT NULL,
    "threadId"  INTEGER      NOT NULL,
    "direction" "ThreadRevisionDirection" NOT NULL,
    "revision"  INTEGER      NOT NULL,
    "isDelete"  BOOLEAN      NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ThreadRevision_userId_threadId_direction_key" ON "ThreadRevision"("userId", "threadId", "direction");
CREATE INDEX "ThreadRevision_userId_revision_idx" ON "ThreadRevision"("userId", "revision");
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE;

-- Backfill: seed an ADD record (revision=0) for every currently-active thread participation, so the
-- snapshot at revision=0 contains all existing threads. User.threadRevision stays 0 (the seed revision).
INSERT INTO "ThreadRevision" ("userId", "threadId", "direction", "revision", "isDelete")
SELECT tp."userId", tp."threadId", 'ADD', 0, false
FROM "ThreadParticipant" tp
WHERE tp."leftAt" IS NULL
ON CONFLICT ("userId", "threadId", "direction") DO NOTHING;

-- Source: 20260712000000_system_setting/migration.sql

-- Admin-managed runtime settings KV store (typed facade: src/settings/settings.service.ts).
-- Holds operator-configured values that are optional, runtime-toggleable, and UI-managed (e.g. the Web
-- Push VAPID keypair, key='vapid'). NOT for bootstrap/identity config (DATABASE_URL, SOMS_DOMAIN) —
-- those stay in env. The VAPID private key lives here in plaintext: the DB is already the trust root
-- (password hashes, refresh-token hashes, per-device push keys), and a VAPID-key compromise only lets an
-- attacker SEND pushes to existing subscribers, not decrypt payloads (RFC 8291 ECDH uses each
-- subscriber's p256dh/auth, not the VAPID key). Rotation breaks subscriptions → clients re-subscribe.
CREATE TABLE "SystemSetting" (
    "key"       VARCHAR(63) PRIMARY KEY,
    "value"     TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Source: 20260712111429_drop_message_thread_isdeleted/migration.sql

-- AlterTable
ALTER TABLE "MessageThread" DROP COLUMN "isDeleted";

-- Source: 20260712120000_daily_quotas/migration.sql

-- Unified daily-quota counters: one row per (node, UTC day, category). A node is a domain — the
-- local SOMS_DOMAIN (all local users share one bucket) or a federated peer domain. `date` is a UTC
-- calendar day, so the budget resets at 00:00 UTC with no cron. QuotaService.tick increments via
-- INSERT … ON CONFLICT DO UPDATE … RETURNING count (exact, not ±1).

CREATE TABLE "QuotaDailyUsage" (
    "domain" VARCHAR(63) NOT NULL,
    "date" DATE NOT NULL,
    "category" VARCHAR(15) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY ("domain", "date", "category")
);

CREATE INDEX "QuotaDailyUsage_date_idx" ON "QuotaDailyUsage"("date");

-- Per-peer daily-quota overrides (NULL = use the global default from loadQuotaConfig).
ALTER TABLE "FederatedPeer" ADD COLUMN "dailyMsgLimit" INTEGER,
    ADD COLUMN "dailyImageLimit" INTEGER,
    ADD COLUMN "dailyLargeFileLimit" INTEGER,
    ADD COLUMN "dailyRequestLimit" INTEGER,
    ADD COLUMN "maxImageBytes" INTEGER,
    ADD COLUMN "maxLargeFileBytes" INTEGER;

-- Source: 20260715120000_session_token/migration.sql

-- SessionToken: long-lived per-device session credential (Telegram-style). Supersedes the
-- access+refresh+notification trinity. `expiresAt` is NULL for the native app (no lifecycle,
-- revocation-only) or a sliding 30-day deadline for web. See `src/database/schema.ts`.

CREATE TABLE "SessionToken" (
    "id" BIGSERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(127) NOT NULL,
    "device" VARCHAR(127),
    "userAgent" VARCHAR(255),
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(32),

    CONSTRAINT "SessionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionToken_tokenHash_key" ON "SessionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SessionToken_userId_idx" ON "SessionToken"("userId");

-- AddForeignKey
ALTER TABLE "SessionToken" ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260715130000_message_created_at_index/migration.sql

-- Cross-thread "messages since T" index for the paginated /notifications/missed catch-up. Backs the
-- global createdAt range scan (joined to ThreadParticipant for membership). See Message.@@index([createdAt]).

CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- Source: 20260715140000_session_token_device_metadata/migration.sql

-- SessionToken: persist the client kind (app|web|desktop) for the device list, plus the most-recent
-- IP (updated on the throttled sliding touch). Mirrors industry session views (GitHub/Telegram/Slack).
ALTER TABLE "SessionToken" ADD COLUMN "client" VARCHAR(16) NOT NULL DEFAULT 'web';
ALTER TABLE "SessionToken" ADD COLUMN "lastSeenIp" VARCHAR(64);

-- Backfill `client` from existing rows: a no-expiry row (expiresAt IS NULL) was issued to the native
-- app; an expiring row was issued to web/desktop. Rows created before this migration carry no other
-- signal, so expiresAt nullness is the only discriminator.
UPDATE "SessionToken" SET "client" = 'app' WHERE "expiresAt" IS NULL;

-- Source: 20260715150000_session_token_id_int/migration.sql

-- SessionToken.id: narrow BigInt → Int. The id is now an EXPOSED public value (the device-list revoke
-- target), so it aligns with other exposed ids (User.id is Int). Session volume is bounded by the login
-- rate and will never approach Int's 2.1B ceiling — BigInt was over-cautious inheritance from the
-- token-table convention. No FK references this column (the User↔SessionToken relation is on userId),
-- so the narrowing is safe. Also removes the BigInt/JSON papercut (BigInt throws in JSON.stringify).
ALTER TABLE "SessionToken" ALTER COLUMN id TYPE INTEGER;

-- Source: 20260715220000_drop_notification_token/migration.sql

-- Drop the scoped notification-token table: the Android foreground service now consumes /events
-- directly (Kotlin-owned connection, session-token auth), so the separate /notifications/stream feed
-- and its scoped 30-day notification token are dead. Destructive — historical data not preserved.
DROP TABLE IF EXISTS "NotificationToken";

-- Source: 20260715230000_drop_refresh_and_tokenversion/migration.sql

-- Drop the user refresh-token family + the User.tokenVersion access-JWT revocation column: user auth is
-- now the single opaque session token (no access JWT, no refresh, no rotation). Admin auth is a separate
-- system (AdminRefreshToken + Admin.tokenVersion) and is untouched. Destructive — historical data not
-- preserved.
ALTER TABLE "User" DROP COLUMN IF EXISTS "tokenVersion";
DROP TABLE IF EXISTS "RefreshToken";

-- Source: 20260716000000_drop_last_message_sender_id/migration.sql

-- Drop MessageThread.lastMessageSenderId: the conversation-list DTO no longer embeds the sender id, and
-- the local-first web client derives the sender (name/id) from its own cached messages. The column had no
-- remaining reader. lastMessagePreview stays (still read by the admin group list); lastMessageAt +
-- lastMessageSeq stay (sort key + unread-count cursor). Destructive — historical data not preserved.
ALTER TABLE "MessageThread" DROP COLUMN IF EXISTS "lastMessageSenderId";

-- Source: 20260716010000_add_session_token_persistent/migration.sql

-- SessionToken.persistent: whether a web/desktop session's cookie is persistent (14-day sliding) or
-- session-scoped (dropped on browser close — the "don't keep me logged in" choice). The cookie-slide
-- path (re-issuing the cookie on activity) only refreshes PERSISTENT cookies; session cookies live for
-- the browser session and need no refresh. App tokens never expire, so this is moot for them (default
-- true, unused). The browser can't report persistence per-request (it sends only the cookie value, not
-- its maxAge/attributes), so it must live server-side. Default true so pre-existing rows behave as
-- persistent (matching the prior fixed 30-day cookie).
ALTER TABLE "SessionToken" ADD COLUMN "persistent" BOOLEAN NOT NULL DEFAULT true;

-- Source: 20260716020000_login_code/migration.sql

-- LoginCode: admin-issued one-time login codes for the Android long-term (app) session login method.
-- The code is argon2-hashed (codeHash); the plaintext is shown once at issue time and never stored.
-- producedSessionId links a consumed code to the SessionToken row it created (audit). Intentionally NOT a
-- foreign key — an audit row must outlive its session (and sessions are soft-revoked, never deleted).
CREATE TABLE "LoginCode" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "codeHash" VARCHAR(127) NOT NULL,
    "issuedBy" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedIp" VARCHAR(64),
    "consumedDevice" VARCHAR(127),
    "producedSessionId" INTEGER,
    "revokedAt" TIMESTAMP(3)
);

CREATE INDEX "LoginCode_userId_idx" ON "LoginCode"("userId");

ALTER TABLE "LoginCode" ADD CONSTRAINT "LoginCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260716030000_user_optional_password/migration.sql

-- hashPwd is now optional. An admin-provisioned OTP/QR-only account (loginMode APP_OTP_AND_QR) is created
-- with NO password — it bootstraps via the one-time login code the admin issues instead. Existing rows keep
-- their hash; only the NOT NULL constraint is dropped (additive, backward-compatible).
ALTER TABLE "User" ALTER COLUMN "hashPwd" DROP NOT NULL;

-- Source: 20260716040000_user_must_change_password/migration.sql

-- mustChangePassword: set when an admin generates (or re-initializes) a user's INITIAL password. While
-- true, the user is forced to set their own password on first login — the initial password is a one-time
-- bootstrap, not an ongoing credential. Cleared when the user sets their own password (auth/set-password).
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Source: 20260717000000_admin_two_factor/migration.sql

-- Admin TOTP two-factor authentication (RFC 6238). Opt-in per admin. The secret is stored
-- AES-256-GCM encrypted (twoFactorSecretCipher), never plaintext. twoFactorLastUsedCounter is the
-- highest accepted TOTP step (replay guard, RFC 6238 §5.2). All default to 2FA-off so existing admins
-- keep logging in with password only until they enroll.
ALTER TABLE "Admin" ADD COLUMN "twoFactorEnabled"         BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "twoFactorSecretCipher"    VARCHAR(255);
ALTER TABLE "Admin" ADD COLUMN "twoFactorEnabledAt"       TIMESTAMP(3);
ALTER TABLE "Admin" ADD COLUMN "twoFactorLastUsedCounter" INTEGER;

-- Single-use argon2-hashed backup (recovery) codes — the lockout escape hatch when an admin loses their
-- authenticator. Single-use is enforced at consume time via an updateMany(consumedAt IS NULL) guard.
CREATE TABLE "TwoFactorBackupCode" (
    "id"         BIGSERIAL NOT NULL,
    "adminId"    INTEGER   NOT NULL,
    "codeHash"   VARCHAR(127) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TwoFactorBackupCode_adminId_idx" ON "TwoFactorBackupCode"("adminId");

ALTER TABLE "TwoFactorBackupCode" ADD CONSTRAINT "TwoFactorBackupCode_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260717120000_add_session_token_trusted/migration.sql

-- Trusted-device flag: a device that stores its session token in OS secure storage may hold a
-- permanent (revocation-only) token. Lifetime is now driven by `trusted` instead of `client`:
-- trusted → expiresAt NULL; untrusted → sliding 14-day deadline (unchanged for web/desktop).
ALTER TABLE "SessionToken" ADD COLUMN "trusted" BOOLEAN NOT NULL DEFAULT false;

-- Existing `app` (native) rows already have expiresAt IS NULL (permanent); mark them trusted so the
-- new lifetime rule describes them correctly. No lifetime change for any row.
UPDATE "SessionToken" SET "trusted" = true WHERE "client" = 'app';

-- Source: 20260717130000_backup_code_hmac_index/migration.sql

-- Backup codes switched from argon2-hashed (slow KDF + 10× verify loop) to HMAC-SHA256 keyed by the 2FA
-- at-rest key: a deterministic blind that enables an O(1) indexed consume lookup and means a DB leak
-- alone cannot recover any code. codeHash now holds a 43-char base64url HMAC, so the column is tightened
-- to VARCHAR(64); the adminId-only index is replaced by a composite (adminId, codeHash) index so the
-- consume query (WHERE adminId AND codeHash AND consumedAt IS NULL) is a single indexed point lookup.
--
-- No data migration: the table holds only unreleased-feature enrollments and is treated as greenfield
-- (stale argon2 hashes, if any, are dropped rather than converted — they cannot be converted without the
-- plaintext, which is never stored).

DROP INDEX IF EXISTS "TwoFactorBackupCode_adminId_idx";

CREATE INDEX "TwoFactorBackupCode_adminId_codeHash_idx"
  ON "TwoFactorBackupCode"("adminId", "codeHash");

ALTER TABLE "TwoFactorBackupCode" ALTER COLUMN "codeHash" TYPE VARCHAR(64);

-- Source: 20260717140000_add_webauthn_credential/migration.sql

-- Admin WebAuthn (passkey) second factor. Adds Admin.webauthnEnabled (a denormalized "≥1 credential
-- exists" hint for the login branch + status card; the credential rows are the source of truth) and the
-- WebAuthnCredential table. credentialId + publicKey are PUBLIC authenticator values, so no at-rest
-- encryption (contrast TwoFactorBackupCode's HMAC and Admin.twoFactorSecretCipher's AES-GCM).
-- Greenfield: no data migration (no credentials exist yet).

ALTER TABLE "Admin" ADD COLUMN "webauthnEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WebAuthnCredential" (
    "id"            BIGSERIAL    NOT NULL,
    "adminId"       INTEGER      NOT NULL,
    "credentialId"  VARCHAR(510) NOT NULL,
    "publicKey"     BYTEA        NOT NULL,
    "counter"       INTEGER      NOT NULL DEFAULT 0,
    "transports"    TEXT,
    "deviceType"    VARCHAR(32),
    "backed"        BOOLEAN      NOT NULL DEFAULT false,
    "nickname"      VARCHAR(64),
    "lastUsedAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");
CREATE INDEX "WebAuthnCredential_adminId_idx" ON "WebAuthnCredential"("adminId");

ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260717150000_admin_login_challenge/migration.sql

-- Single-use admin login challenge tracker. Closes the WebAuthn assertion-replay window for counter=0
-- authenticators (platform passkeys): a row keyed by the challenge JWT's jti is minted at login and
-- flipped to consumed on the first successful second-factor verify; a second/cross-factor consume is
-- rejected. Greenfield: no data migration.
CREATE TABLE "AdminLoginChallenge" (
    "jti"        VARCHAR(36) NOT NULL,
    "adminId"    INTEGER     NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminLoginChallenge_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "AdminLoginChallenge_createdAt_idx" ON "AdminLoginChallenge"("createdAt");

ALTER TABLE "AdminLoginChallenge" ADD CONSTRAINT "AdminLoginChallenge_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Source: 20260719190000_add_diagnostics_report/migration.sql

-- Client-uploaded diagnostic log bundles (Rust logs + a webview console capture + a version manifest)
-- for field support. The reporter is pinned to the authenticated user; the bundle FILE lives under
-- data/diagnostics/ (sha256-addressed, atomic tmp+rename publish — no refcount; GC unlinks it only when
-- no row references it). Soft-deleted via isDeleted; the file itself is hard-unlinked by
-- DiagnosticsGcService (uploaded blobs are not subject to the no-hard-delete rule for DB rows).
-- Greenfield: no data migration.
CREATE TABLE "DiagnosticsReport" (
    "id"             SERIAL       NOT NULL,
    "reporterUserId" INTEGER      NOT NULL,
    "bundlePath"     VARCHAR(255) NOT NULL,
    "bundleBytes"    INTEGER      NOT NULL,
    "manifest"       JSONB        NOT NULL,
    "status"         VARCHAR(16)  NOT NULL DEFAULT 'new',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "isDeleted"      BOOLEAN      NOT NULL DEFAULT false,

    CONSTRAINT "DiagnosticsReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiagnosticsReport_reporterUserId_idx" ON "DiagnosticsReport"("reporterUserId");
CREATE INDEX "DiagnosticsReport_createdAt_idx" ON "DiagnosticsReport"("createdAt");
CREATE INDEX "DiagnosticsReport_status_idx" ON "DiagnosticsReport"("status");

ALTER TABLE "DiagnosticsReport" ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey"
  FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260719200000_cleanup_unused_columns_and_reconcile/migration.sql

-- Cleanup pass. Two parts:
--  (1) Drop three unused PendingMedia columns — failReason, originDomain, originServerTime — with zero
--      ORM reads/writes, zero raw-SQL references, and zero DTO exposure (PendingMedia is internal-
--      only). The 'failed' status they implied was never wired (the GC hard-deletes stale rows instead).
--  (2) Reconcile earlier migration/schema drift: drop stale column
--      DEFAULTs (Group/SystemSetting @updatedAt carried DEFAULT NOW() though @updatedAt is client-
--      managed; SessionToken.client carried DEFAULT 'web') and recreate the Group.groupUserId +
--      ThreadRevision FKs to their intended ON DELETE CASCADE action.
--  Non-destructive to row data (unused columns held none; defaults/constraints carry none). SQL generated
--  so constraint names and actions match the typed schema exactly.
-- Dropping the 3 columns is a model change (no data migration); the rest is schema/migrations alignment.

-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_groupUserId_fkey";

-- DropForeignKey
ALTER TABLE "ThreadRevision" DROP CONSTRAINT "ThreadRevision_threadId_fkey";

-- DropForeignKey
ALTER TABLE "ThreadRevision" DROP CONSTRAINT "ThreadRevision_userId_fkey";

-- AlterTable
ALTER TABLE "Group" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PendingMedia" DROP COLUMN "failReason",
DROP COLUMN "originDomain",
DROP COLUMN "originServerTime";

-- AlterTable
ALTER TABLE "SessionToken" ALTER COLUMN "client" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SystemSetting" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Source: 20260723120000_add_content_type_link/migration.sql

-- Add LINK to the ContentType enum (web link card / OpenGraph preview message kind).
-- Non-breaking: existing rows keep their values; new value defaults are not changed.
-- ADD VALUE is permitted inside a transaction block since PostgreSQL 12.
ALTER TYPE "ContentType" ADD VALUE IF NOT EXISTS 'LINK';

-- Source: 20260723130000_drop_has_ur_friend_req/migration.sql

-- Drop the denormalized `hasUrFriendReq` boolean. The friend-request badge is now derived from the
-- Invite data itself: the client compares the SSE HELLO/push-carried `friendReqRev` (= MAX(updatedAt) over
-- the user's incoming FRIEND invites — a monotonic, data-derived revision) to its IDB cursor, mirroring the
-- threadRevision delta model. No denormalized badge column to keep in sync; accept/decline/expiry advance
-- the derived revision automatically via the rows' own `updatedAt`.
ALTER TABLE "User" DROP COLUMN "hasUrFriendReq";

-- Source: 20260723140000_add_friend_req_ack_rev/migration.sql

-- Friend-request read cursor. The client derives the unread badge as friendReqRev (MAX(updatedAt) over
-- incoming FRIEND invites, SSE-carried) > friendReqAckRev; markRead advances this, clearing the badge on
-- all devices (server-state, multi-device consistent). TIMESTAMP(3) = same type as the derivation (no
-- 2038/overflow). Default epoch = "never acked" (existing unread requests show the badge until markRead).
-- The wire carries both as epoch-ms (JS Number); only the durable column is a Date.
ALTER TABLE "User" ADD COLUMN "friendReqAckRev" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00';

-- Source: 20260723140000_drop_firebase_config_setting/migration.sql

-- Drop the now-dead `firebase-config` SystemSetting row. The Firebase client config moved from a DB-backed
-- admin-web upload (stored under this key by the since-removed SettingsService.setFirebaseConfig /
-- parseFirebase / refresh-fbRow path) to a file on disk (FIREBASE_CLIENT_CONFIG / data/google-services.json)
-- on 2026-07-23. The row is no longer read or written by any code path. Idempotent — a no-op on deploys that
-- never used the old upload model (the row was never created there).
DELETE FROM "SystemSetting" WHERE key = 'firebase-config';

-- Source: 20260724120000_add_call/migration.sql

-- 1:1 WebRTC call lifecycle + history. The app server is signaling coordinator ONLY (never
-- carries media — P2P DTLS-SRTP; a separate coturn is the TURN relay fallback). One row per call
-- attempt; status is the authoritative state machine. callSid is the client-generated idempotency
-- key + the stable address every signaling frame carries (mirrors Message.clientMessageId).
--
-- Purely ADDITIVE: two enums + one table. The live DB carries pre-existing drift (columns/indexes
-- other migrations already dropped from the schema but never applied here) — that is intentionally
-- NOT reconciled by this migration.

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'ENDED', 'DECLINED', 'CANCELLED', 'MISSED');

-- CreateTable
CREATE TABLE "Call" (
    "id" SERIAL NOT NULL,
    "callSid" VARCHAR(36) NOT NULL,
    "threadId" INTEGER NOT NULL,
    "callerId" INTEGER NOT NULL,
    "calleeId" INTEGER NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" VARCHAR(31),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_callSid_key" ON "Call"("callSid");

-- CreateIndex
CREATE INDEX "Call_calleeId_status_idx" ON "Call"("calleeId", "status");

-- CreateIndex
CREATE INDEX "Call_callerId_status_idx" ON "Call"("callerId", "status");

-- CreateIndex
CREATE INDEX "Call_threadId_idx" ON "Call"("threadId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260724130000_call_to_message/migration.sql

-- Calls are now ContentType.CALL Message bubbles (server-authored by CallsService at the call's
-- terminal state), not a dedicated Call table. This reverses 20260724120000_add_call (drop the
-- Call model + its CallType/CallStatus enums) and adds the CALL content type the bubbles use.
-- Non-breaking on existing Message rows: a new enum value adds a kind, it does not alter any.

DROP TABLE IF EXISTS "Call";
DROP TYPE IF EXISTS "CallStatus";
DROP TYPE IF EXISTS "CallType";

-- ADD VALUE is permitted inside a transaction block since PostgreSQL 12 (this server is PG 16).
ALTER TYPE "ContentType" ADD VALUE IF NOT EXISTS 'CALL';

-- Source: 20260726120000_admin_opaque_session/migration.sql

-- Replace administrator access/refresh JWTs with one independently revocable
-- opaque session. Existing admin logins intentionally require re-authentication.
DROP TABLE IF EXISTS "AdminRefreshToken";

CREATE TABLE "AdminSession" (
    "id" BIGSERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" VARCHAR(255),
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(32),
    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession"("adminId");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Admin" DROP COLUMN IF EXISTS "tokenVersion";

-- Source: 20260726130000_optimize_hot_query_indexes/migration.sql

-- Remove indexes whose leading columns are already covered by another B-tree:
--   ThreadParticipant(userId)               -> unique(userId, threadId)
--   MessageThread(groupUserId)               -> unique(groupUserId)
--   Message(threadId, creator, originSeq)     -> unique(threadId, creator, originSeq)
--   S2SKeyCache(domain)                       -> primary key(domain, keyId)
--
-- PostgreSQL can use a composite B-tree for predicates on its leftmost columns,
-- so retaining both copies only adds storage and write amplification.
DROP INDEX "ThreadParticipant_userId_idx";
DROP INDEX "MessageThread_groupUserId_idx";
DROP INDEX "Message_threadId_creator_originSeq_idx";
DROP INDEX "S2SKeyCache_domain_idx";

-- Active session/device list for one user. The query filters revokedAt IS NULL,
-- applies the expiry predicate, and orders by lastSeenAt DESC.
CREATE INDEX "SessionToken_userId_lastSeenAt_active_idx"
ON "SessionToken" ("userId", "lastSeenAt" DESC)
WHERE "revokedAt" IS NULL;

-- Admin session list + dashboard active-session count. Keeping only active
-- rows makes this substantially smaller when revoked session history grows.
CREATE INDEX "SessionToken_lastSeenAt_active_idx"
ON "SessionToken" ("lastSeenAt" DESC)
WHERE "revokedAt" IS NULL;

-- Friend request panels always read pending FRIEND rows for one endpoint user,
-- newest first. These indexes also satisfy the createdAt range predicate.
CREATE INDEX "Invite_incoming_friend_pending_createdAt_idx"
ON "Invite" ("toUserId", "createdAt" DESC)
WHERE "kind" = 'FRIEND' AND "status" = 'PENDING';

CREATE INDEX "Invite_outgoing_friend_pending_createdAt_idx"
ON "Invite" ("fromUserId", "createdAt" DESC)
WHERE "kind" = 'FRIEND' AND "status" = 'PENDING';

-- Fan-out, roster reads, and active-member counts all exclude soft-left rows;
-- joinedAt supplies the roster ordering without a separate sort.
CREATE INDEX "ThreadParticipant_threadId_joinedAt_active_idx"
ON "ThreadParticipant" ("threadId", "joinedAt")
WHERE "leftAt" IS NULL;

-- Source: 20260726140000_pending_media_failed_state/migration.sql

-- Complete the local media staging state machine:
-- pending -> failed -> pending (explicit retry), with a bounded diagnostic reason.
ALTER TABLE "PendingMedia" ADD COLUMN "failReason" VARCHAR(255);

-- Source: 20260731160000_forward_bundles/migration.sql

ALTER TYPE "ContentType" ADD VALUE 'FORWARD';

CREATE TABLE "ForwardBundle" (
    "id" VARCHAR(26) NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "depth" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestDigest" VARCHAR(64) NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "assetCount" INTEGER NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "sourceDomain" VARCHAR(63),
    "sourceBundleId" VARCHAR(26),
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForwardBundle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ForwardMessage" (
    "messageId" BIGINT NOT NULL,
    "bundleId" VARCHAR(26) NOT NULL,
    CONSTRAINT "ForwardMessage_pkey" PRIMARY KEY ("messageId")
);

CREATE TABLE "ForwardBundleDependency" (
    "parentBundleId" VARCHAR(26) NOT NULL,
    "childBundleId" VARCHAR(26) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    CONSTRAINT "ForwardBundleDependency_pkey" PRIMARY KEY ("parentBundleId","childBundleId")
);

CREATE TABLE "ForwardBundleAsset" (
    "bundleId" VARCHAR(26) NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "extension" VARCHAR(16) NOT NULL,
    "filename" TEXT,
    "mime" TEXT,
    "bytes" BIGINT NOT NULL,
    CONSTRAINT "ForwardBundleAsset_pkey" PRIMARY KEY ("bundleId","ordinal")
);

CREATE UNIQUE INDEX "ForwardBundle_sourceDomain_sourceBundleId_key" ON "ForwardBundle"("sourceDomain","sourceBundleId");
CREATE INDEX "ForwardBundle_createdBy_idx" ON "ForwardBundle"("createdBy");
CREATE INDEX "ForwardMessage_bundleId_idx" ON "ForwardMessage"("bundleId");
CREATE UNIQUE INDEX "ForwardBundleDependency_parentBundleId_ordinal_key" ON "ForwardBundleDependency"("parentBundleId","ordinal");
CREATE INDEX "ForwardBundleDependency_childBundleId_idx" ON "ForwardBundleDependency"("childBundleId");
CREATE UNIQUE INDEX "ForwardBundleAsset_bundleId_digest_kind_key" ON "ForwardBundleAsset"("bundleId","digest","kind");
CREATE INDEX "ForwardBundleAsset_digest_idx" ON "ForwardBundleAsset"("digest");

ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_bundleId_fkey"
FOREIGN KEY ("bundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_parentBundleId_fkey"
FOREIGN KEY ("parentBundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_childBundleId_fkey"
FOREIGN KEY ("childBundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleAsset" ADD CONSTRAINT "ForwardBundleAsset_bundleId_fkey"
FOREIGN KEY ("bundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source: 20260731170000_forward_bundle_constraints/migration.sql

ALTER TABLE "ForwardBundle"
  ADD CONSTRAINT "ForwardBundle_depth_check"
    CHECK ("depth" BETWEEN 1 AND 3),
  ADD CONSTRAINT "ForwardBundle_schema_version_check"
    CHECK ("schemaVersion" = 1),
  ADD CONSTRAINT "ForwardBundle_message_count_check"
    CHECK ("messageCount" BETWEEN 1 AND 100),
  ADD CONSTRAINT "ForwardBundle_asset_count_check"
    CHECK ("assetCount" >= 0),
  ADD CONSTRAINT "ForwardBundle_total_bytes_check"
    CHECK ("totalBytes" >= 0),
  ADD CONSTRAINT "ForwardBundle_manifest_shape_check"
    CHECK (
      jsonb_typeof("manifest") = 'object'
      AND jsonb_typeof("manifest"->'children') = 'array'
      AND jsonb_typeof("manifest"->'messages') = 'array'
      AND ("manifest"->>'schemaVersion')::integer = 1
    );

-- Source: 20260731223000_group_dissolved_state/migration.sql

ALTER TABLE "Group" ADD COLUMN "dissolvedAt" TIMESTAMP(3);

-- ============================================================================
-- Squashed from 0001_thread_clear_seq.sql
-- ============================================================================

ALTER TABLE "ThreadParticipant" ADD COLUMN "clearedSeq" INTEGER;

UPDATE "ThreadParticipant" AS participant
SET "clearedSeq" = COALESCE(
  (
    SELECT MAX(message.seq)
    FROM "Message" AS message
    WHERE message."threadId" = participant."threadId"
      AND message."createdAt" <= participant."clearedAt"
  ),
  -1
)
WHERE participant."clearedAt" IS NOT NULL;

ALTER TABLE "ThreadParticipant" DROP COLUMN "clearedAt";

ALTER TABLE "ThreadParticipant"
  ADD CONSTRAINT "ThreadParticipant_cleared_seq_check"
  CHECK ("clearedSeq" IS NULL OR "clearedSeq" >= -1);

-- ============================================================================
-- Squashed from 0002_read_revision.sql
-- ============================================================================

ALTER TABLE "User"
ADD COLUMN "readRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ThreadParticipant"
ADD COLUMN "readRevision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ThreadParticipant_userId_readRevision_idx"
ON "ThreadParticipant" ("userId", "readRevision");

-- ============================================================================
-- Squashed from 0003_user_preference.sql
-- ============================================================================

CREATE TABLE "UserPreference" (
  "userId" INTEGER NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "value" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId", "key"),
  CONSTRAINT "UserPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserPreference_value_not_json_null_check"
    CHECK ("value" <> 'null'::jsonb),
  CONSTRAINT "UserPreference_revision_check"
    CHECK ("revision" >= 0)
);

ALTER TABLE "SessionToken"
  ADD COLUMN "autoTerminateDays" INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT "SessionToken_auto_terminate_days_check"
    CHECK ("autoTerminateDays" IN (7, 30, 90, 180, 365));

DELETE FROM "SessionToken";

ALTER TABLE "SessionToken"
  ALTER COLUMN "expiresAt" SET NOT NULL,
  DROP COLUMN "persistent",
  DROP COLUMN "trusted";

-- ============================================================================
-- Squashed from 0004_media_asset_status.sql
-- ============================================================================

DELETE FROM "ForwardBundleAsset";
DELETE FROM "MediaMessage";
DELETE FROM "PendingMedia" WHERE digest IS NOT NULL;
DELETE FROM "MediaAsset";

CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'DELETING', 'DELETED');

ALTER TABLE "MediaAsset"
  ADD COLUMN "status" "MediaAssetStatus" NOT NULL DEFAULT 'READY',
  ADD COLUMN "stateChangedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX "MediaAsset_refs_idx";
ALTER TABLE "MediaAsset" DROP COLUMN "refs";

CREATE INDEX "MediaAsset_status_createdAt_idx"
  ON "MediaAsset" USING btree ("status", "stateChangedAt");

-- ============================================================================
-- Squashed from 0005_remove_local_server_quota.sql
-- ============================================================================

-- Local accounts are no longer aggregated into the server-domain quota bucket. Federated peers remain
-- domain-scoped; local accounts receive a separate userId-scoped quota model in a subsequent migration.
DELETE FROM "SystemSetting" WHERE "key" = 'quota:local';

-- ============================================================================
-- Squashed from 0006_user_quota.sql
-- ============================================================================

CREATE TABLE "UserQuotaPolicy" (
  "userId" integer PRIMARY KEY NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "dailyMsgLimit" integer,
  "dailyImageLimit" integer,
  "dailyLargeFileLimit" integer,
  "dailyRequestLimit" integer,
  "maxImageBytes" integer,
  "maxLargeFileBytes" integer,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "UserQuotaPolicy_nonnegative_check" CHECK (
    ("dailyMsgLimit" IS NULL OR "dailyMsgLimit" >= 0) AND
    ("dailyImageLimit" IS NULL OR "dailyImageLimit" >= 0) AND
    ("dailyLargeFileLimit" IS NULL OR "dailyLargeFileLimit" >= 0) AND
    ("dailyRequestLimit" IS NULL OR "dailyRequestLimit" >= 0) AND
    ("maxImageBytes" IS NULL OR "maxImageBytes" >= 0) AND
    ("maxLargeFileBytes" IS NULL OR "maxLargeFileBytes" >= 0)
  )
);

CREATE TABLE "UserQuotaDailyUsage" (
  "userId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "category" varchar(15) NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "UserQuotaDailyUsage_pkey" PRIMARY KEY("userId", "date", "category"),
  CONSTRAINT "UserQuotaDailyUsage_count_check" CHECK ("count" >= 0),
  CONSTRAINT "UserQuotaDailyUsage_category_check" CHECK (
    "category" IN ('messages', 'images', 'largeFiles', 'requests')
  )
);

CREATE INDEX "UserQuotaDailyUsage_date_idx" ON "UserQuotaDailyUsage" USING btree ("date");

-- ============================================================================
-- Squashed from 0007_media_asset_failed.sql
-- ============================================================================

ALTER TYPE "MediaAssetStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- ============================================================================
-- Squashed from 0008_resumable_upload.sql
-- ============================================================================

CREATE TYPE "UploadSessionStatus" AS ENUM (
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTED'
);

CREATE TABLE "UploadSession" (
  "id" BIGSERIAL PRIMARY KEY,
  "uploadId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientMessageId" VARCHAR(36) NOT NULL,
  "creatorId" INTEGER NOT NULL,
  "contentType" "ContentType" NOT NULL,
  "originalName" VARCHAR(100) NOT NULL,
  "mimeType" VARCHAR(255) NOT NULL,
  "totalBytes" BIGINT NOT NULL,
  "receivedBytes" BIGINT NOT NULL DEFAULT 0,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'UPLOADING',
  "tmpKey" UUID NOT NULL DEFAULT gen_random_uuid(),
  "digest" VARCHAR(64),
  "result" JSONB,
  "errorReason" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "abortedAt" TIMESTAMP(3),
  CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UploadSession_totalBytes_check" CHECK ("totalBytes" > 0),
  CONSTRAINT "UploadSession_receivedBytes_check"
    CHECK ("receivedBytes" >= 0 AND "receivedBytes" <= "totalBytes")
);

CREATE UNIQUE INDEX "UploadSession_uploadId_key" ON "UploadSession"("uploadId");
CREATE UNIQUE INDEX "UploadSession_clientMessageId_key" ON "UploadSession"("clientMessageId");
CREATE INDEX "UploadSession_creatorId_status_idx" ON "UploadSession"("creatorId", "status");
CREATE INDEX "UploadSession_status_updatedAt_idx" ON "UploadSession"("status", "updatedAt");
CREATE INDEX "UploadSession_digest_idx" ON "UploadSession"("digest") WHERE "digest" IS NOT NULL;

-- ============================================================================
-- Squashed from 0009_link_card_rules.sql
-- ============================================================================

CREATE TABLE "LinkCardRule" (
  "id" SERIAL PRIMARY KEY,
  "matchUrl" VARCHAR(2048) NOT NULL,
  "hostname" VARCHAR(255) NOT NULL,
  "displayName" VARCHAR(100) NOT NULL,
  "includeSubdomains" BOOLEAN NOT NULL DEFAULT TRUE,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "LinkCardRule_hostname_key" ON "LinkCardRule"("hostname");
CREATE INDEX "LinkCardRule_enabled_priority_idx" ON "LinkCardRule"("enabled", "priority" DESC);

CREATE TABLE "LinkFavicon" (
  "ruleId" INTEGER PRIMARY KEY,
  "sourceUrl" VARCHAR(2048) NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LinkFavicon_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "LinkCardRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LinkFavicon_digest_fkey" FOREIGN KEY ("digest") REFERENCES "MediaAsset"("digest") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "LinkFavicon_digest_idx" ON "LinkFavicon"("digest");
