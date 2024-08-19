/*
  Warnings:

  - You are about to drop the column `creator` on the `Message` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Message" DROP COLUMN "creator";

-- AddForeignKey
ALTER TABLE "UserChatThread" ADD CONSTRAINT "UserChatThread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
