-- CreateEnum
CREATE TYPE "MessageThreadType" AS ENUM ('P2P', 'GROUP');

-- CreateEnum
CREATE TYPE "UserMessageThreadStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PURE_TEXT');

-- CreateEnum
CREATE TYPE "NotifyType" AS ENUM ('FRIEND_REQUEST');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "uniqName" VARCHAR(31) NOT NULL,
    "hashPwd" VARCHAR(31) NOT NULL,
    "isForeigner" BOOLEAN NOT NULL,
    "domain" VARCHAR(63),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "userExtraId" INTEGER NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserExtra" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(127) NOT NULL,
    "hasUrFriendReq" BOOLEAN NOT NULL DEFAULT false,
    "avatar" TEXT NOT NULL,

    CONSTRAINT "UserExtra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(127) NOT NULL,
    "threadId" INTEGER NOT NULL,
    "GroupExtraId" INTEGER NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupExtra" (
    "id" SERIAL NOT NULL,
    "memberIdList" INTEGER[],
    "adminIdList" INTEGER[],
    "avatar" TEXT NOT NULL,

    CONSTRAINT "GroupExtra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMessageThread" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "UserMessageThreadStatus" NOT NULL,
    "toObjType" "MessageThreadType" NOT NULL,
    "toObjId" INTEGER NOT NULL,
    "reqMessage" TEXT NOT NULL,
    "threadId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserMessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" SERIAL NOT NULL,
    "type" "MessageThreadType" NOT NULL,
    "info" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" BIGSERIAL NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "content" TEXT NOT NULL,
    "threadId" INTEGER NOT NULL,
    "creator" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notify" (
    "id" BIGSERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "NotifyType" NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "Notify_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_uniqName_key" ON "User"("uniqName");

-- CreateIndex
CREATE UNIQUE INDEX "User_userExtraId_key" ON "User"("userExtraId");

-- CreateIndex
CREATE UNIQUE INDEX "User_uniqName_domain_key" ON "User"("uniqName", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "Group_threadId_key" ON "Group"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_GroupExtraId_key" ON "Group"("GroupExtraId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMessageThread_userId_toObjType_toObjId_key" ON "UserMessageThread"("userId", "toObjType", "toObjId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMessageThread_userId_threadId_key" ON "UserMessageThread"("userId", "threadId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_userExtraId_fkey" FOREIGN KEY ("userExtraId") REFERENCES "UserExtra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_GroupExtraId_fkey" FOREIGN KEY ("GroupExtraId") REFERENCES "GroupExtra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMessageThread" ADD CONSTRAINT "UserMessageThread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
