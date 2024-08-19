/*
  Warnings:

  - You are about to drop the column `selfId` on the `Friend` table. All the data in the column will be lost.
  - You are about to drop the column `firendUserId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `isHostSent` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `selfUserId` on the `Message` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[hostUserId,selfUserId]` on the table `Friend` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `selfUserId` to the `Friend` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromUserId` to the `Message` table without a default value. This is not possible if the table is not empty.
  - Added the required column `toUserId` to the `Message` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Friend" DROP CONSTRAINT "Friend_hostUserId_fkey";

-- DropIndex
DROP INDEX "Friend_hostUserId_selfId_key";

-- AlterTable
ALTER TABLE "Friend" DROP COLUMN "selfId",
ADD COLUMN     "selfUserId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "firendUserId",
DROP COLUMN "isHostSent",
DROP COLUMN "selfUserId",
ADD COLUMN     "fromUserId" INTEGER NOT NULL,
ADD COLUMN     "toUserId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Friend_hostUserId_selfUserId_key" ON "Friend"("hostUserId", "selfUserId");
