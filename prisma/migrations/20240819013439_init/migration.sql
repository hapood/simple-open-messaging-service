/*
  Warnings:

  - You are about to drop the column `selfUserId` on the `Friend` table. All the data in the column will be lost.
  - You are about to drop the column `fromUserId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `toUserId` on the `Message` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[hostUserId,friendUserId]` on the table `Friend` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `friendUserId` to the `Friend` table without a default value. This is not possible if the table is not empty.
  - Added the required column `creator` to the `Message` table without a default value. This is not possible if the table is not empty.
  - Added the required column `threadId` to the `Message` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Friend_hostUserId_selfUserId_key";

-- AlterTable
ALTER TABLE "Friend" DROP COLUMN "selfUserId",
ADD COLUMN     "friendUserId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "fromUserId",
DROP COLUMN "toUserId",
ADD COLUMN     "creator" INTEGER NOT NULL,
ADD COLUMN     "threadId" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" SERIAL NOT NULL,
    "hostUserId" INTEGER NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Friend_hostUserId_friendUserId_key" ON "Friend"("hostUserId", "friendUserId");
