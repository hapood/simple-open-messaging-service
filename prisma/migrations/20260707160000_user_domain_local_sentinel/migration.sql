-- Federation: drop the standalone uniqName unique. It blocked foreign stubs that shared a localpart
-- with a local user (a local "bob" prevented creating the "bob@bbb.com" stub). The compound
-- @@unique([uniqName, domain]) (index User_uniqName_domain_key) handles both local + stub uniqueness.
--
-- Local users now carry domain='local' (was NULL); making the column NOT NULL with this default means
-- the compound enforces local-user uniqueness too — NULLs are distinct in Postgres unique indexes, so
-- the compound alone could not enforce uniqueness among domain-NULL rows. "local" is an internal
-- sentinel (federation handles/display use the real config.domain at runtime).
DROP INDEX "User_uniqName_key";
UPDATE "User" SET "domain" = 'local' WHERE "domain" IS NULL;
ALTER TABLE "User" ALTER COLUMN "domain" SET DEFAULT 'local';
ALTER TABLE "User" ALTER COLUMN "domain" SET NOT NULL;
