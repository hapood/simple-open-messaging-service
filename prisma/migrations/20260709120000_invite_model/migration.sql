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
