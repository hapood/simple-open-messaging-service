/*
  Warnings:

  - The values [PENDING] on the enum `UserMessageThreadStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "UserMessageThreadStatus_new" AS ENUM ('FROM_PENDING', 'TO_PENDING', 'APPROVED', 'BLOCKED', 'DELETED');
ALTER TABLE "UserMessageThread" ALTER COLUMN "status" TYPE "UserMessageThreadStatus_new" USING ("status"::text::"UserMessageThreadStatus_new");
ALTER TYPE "UserMessageThreadStatus" RENAME TO "UserMessageThreadStatus_old";
ALTER TYPE "UserMessageThreadStatus_new" RENAME TO "UserMessageThreadStatus";
DROP TYPE "UserMessageThreadStatus_old";
COMMIT;
