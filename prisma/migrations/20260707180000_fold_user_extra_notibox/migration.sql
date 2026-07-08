-- Fold the UserExtra (name/avatar/bio) and userNotiBox (hasUrFriendReq) 1:1 tables into User as
-- inline columns. Both were always-co-loaded 1:1 children with no sparse/multi-profile justification,
-- so the split was over-engineering — see the User model comment in schema.prisma.

-- 1. Add the new columns. name/avatar are nullable for now (set NOT NULL after backfill); the rest
--    carry their defaults so existing rows survive the ADD.
ALTER TABLE "User"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "avatar" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "bio" VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN "hasUrFriendReq" BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill from the 1:1 tables (every User row has exactly one of each, via userExtraId/userNotiBoxId).
UPDATE "User" u
SET "name" = ue."name",
    "avatar" = ue."avatar",
    "bio" = COALESCE(ue."bio", ''),
    "hasUrFriendReq" = COALESCE(nb."hasUrFriendReq", false)
FROM "UserExtra" ue, "userNotiBox" nb
WHERE u."userExtraId" = ue."id" AND u."userNotiBoxId" = nb."id";

-- 3. name/avatar were required on UserExtra → enforce NOT NULL now that every row is backfilled.
ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "avatar" SET NOT NULL;

-- 4. Drop the FK columns (cascades their unique indexes + the FK constraints) then the empty tables.
ALTER TABLE "User" DROP COLUMN "userExtraId";
ALTER TABLE "User" DROP COLUMN "userNotiBoxId";
DROP TABLE "UserExtra";
DROP TABLE "userNotiBox";
