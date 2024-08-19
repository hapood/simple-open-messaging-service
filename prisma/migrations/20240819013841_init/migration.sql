/*
  Warnings:

  - You are about to drop the column `hostUserId` on the `ChatThread` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ChatThread" DROP COLUMN "hostUserId";

-- CreateTable
CREATE TABLE "UserChatThread" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,

    CONSTRAINT "UserChatThread_pkey" PRIMARY KEY ("id")
);
