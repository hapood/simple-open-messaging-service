-- DropForeignKey
ALTER TABLE "UserMessageThread" DROP CONSTRAINT "UserMessageThread_threadId_fkey";

-- AlterTable
ALTER TABLE "UserMessageThread" ALTER COLUMN "threadId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "UserMessageThread" ADD CONSTRAINT "UserMessageThread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
