/*
  Warnings:

  - You are about to drop the column `GroupExtraId` on the `Group` table. All the data in the column will be lost.
  - You are about to drop the column `threadId` on the `Group` table. All the data in the column will be lost.
  - You are about to drop the `GroupExtra` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `avatar` to the `Group` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Group` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_GroupExtraId_fkey";

-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_threadId_fkey";

-- DropIndex
DROP INDEX "Group_GroupExtraId_key";

-- DropIndex
DROP INDEX "Group_threadId_key";

-- AlterTable
ALTER TABLE "Group" DROP COLUMN "GroupExtraId",
DROP COLUMN "threadId",
ADD COLUMN     "adminIdList" INTEGER[],
ADD COLUMN     "avatar" TEXT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "memberIdList" INTEGER[],
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "MessageThread" ADD COLUMN     "groupId" INTEGER;

-- DropTable
DROP TABLE "GroupExtra";

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
