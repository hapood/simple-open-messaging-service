/*
  Warnings:

  - You are about to drop the column `groupId` on the `MessageThread` table. All the data in the column will be lost.
  - Added the required column `threadId` to the `Group` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "MessageThread" DROP CONSTRAINT "MessageThread_groupId_fkey";

-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "threadId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "MessageThread" DROP COLUMN "groupId";

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
