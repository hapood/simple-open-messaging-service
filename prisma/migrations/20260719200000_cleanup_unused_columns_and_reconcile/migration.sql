-- Cleanup pass. Two parts:
--  (1) Drop three unused PendingMedia columns — failReason, originDomain, originServerTime — with zero
--      Prisma reads/writes, zero raw-SQL references, and zero DTO exposure (PendingMedia is internal-
--      only). The 'failed' status they implied was never wired (the GC hard-deletes stale rows instead).
--  (2) Reconcile migrations ↔ schema.prisma drift left from earlier schema edits: drop stale column
--      DEFAULTs (Group/SystemSetting @updatedAt carried DEFAULT NOW() though @updatedAt is client-
--      managed; SessionToken.client carried DEFAULT 'web') and recreate the Group.groupUserId +
--      ThreadRevision FKs to the ON DELETE CASCADE action schema.prisma declares.
--  Non-destructive to row data (unused columns held none; defaults/constraints carry none). SQL generated
--  via `prisma migrate diff` so constraint names + actions match Prisma's schema intent exactly.
-- Dropping the 3 columns is a model change (no data migration); the rest is schema/migrations alignment.

-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_groupUserId_fkey";

-- DropForeignKey
ALTER TABLE "ThreadRevision" DROP CONSTRAINT "ThreadRevision_threadId_fkey";

-- DropForeignKey
ALTER TABLE "ThreadRevision" DROP CONSTRAINT "ThreadRevision_userId_fkey";

-- AlterTable
ALTER TABLE "Group" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PendingMedia" DROP COLUMN "failReason",
DROP COLUMN "originDomain",
DROP COLUMN "originServerTime";

-- AlterTable
ALTER TABLE "SessionToken" ALTER COLUMN "client" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SystemSetting" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
