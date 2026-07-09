-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
    "content" TEXT NOT NULL,
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


-- Invariants Prisma cannot express (raw SQL): the baseline carries them so a fresh reset recreates them.
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupUserId_type_check"
  CHECK (("type" = 'P2P') = ("groupUserId" IS NULL));
ALTER TABLE "User" ADD CONSTRAINT "User_isGroup_sigil_check"
  CHECK (("account" LIKE '!%') = "isGroup");
