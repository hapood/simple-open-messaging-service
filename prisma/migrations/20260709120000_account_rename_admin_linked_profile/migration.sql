-- Phase 1: rename the account handle uniqName→account on User, and restructure Admin into a linked
-- profile on User (single account namespace → no user/admin name collision possible).
--
-- (a) User.uniqName → account (metadata-only rename of column + its compound unique index).
ALTER TABLE "User" RENAME COLUMN "uniqName" TO "account";
ALTER INDEX "User_uniqName_domain_key" RENAME TO "User_account_domain_key";

-- (b) Give each admin a User identity. Find-or-create: if a local user with that account already
--     exists, keep it (ON CONFLICT DO NOTHING) — that user becomes the admin's identity and its
--     existing password stands; otherwise seed a User from the old Admin row.
ALTER TABLE "Admin" ADD COLUMN "userId" INTEGER;
INSERT INTO "User" ("account", "hashPwd", "name", "avatar", "bio", "isForeigner", "domain", "tokenVersion", "hasUrFriendReq", "isDeleted", "remoteUpdatedAt", "createdAt", "updatedAt")
SELECT a."username", a."hashPwd", a."username", '', '', false, 'local', 0, false, false, NULL, now(), now()
FROM "Admin" a
ON CONFLICT ("account", "domain") DO NOTHING;

-- (c) Link every admin to its (now-existing) user by account, then lock the FK + unique.
UPDATE "Admin" a SET "userId" = (
  SELECT u.id FROM "User" u WHERE u."account" = a."username" AND u."domain" = 'local'
);
ALTER TABLE "Admin" ALTER COLUMN "userId" SET NOT NULL;
CREATE UNIQUE INDEX "Admin_userId_key" ON "Admin"("userId");
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id");

-- (d) Drop the old Admin identity columns + indexes (identity now lives on the linked User).
DROP INDEX "Admin_username_key";
DROP INDEX "Admin_username_idx";
ALTER TABLE "Admin" DROP COLUMN "username";
ALTER TABLE "Admin" DROP COLUMN "hashPwd";
