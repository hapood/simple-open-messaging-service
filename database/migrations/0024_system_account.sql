-- Internal automation has a local identity, but cannot authenticate or publish a profile.
ALTER TABLE "Account" ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'USER';
ALTER TABLE "Account" ADD CONSTRAINT "Account_kind_check" CHECK (
  (kind = 'USER' AND account <> '$system') OR
  (kind = 'SYSTEM' AND account = '$system' AND "hashPwd" IS NULL
    AND "disabledAt" IS NOT NULL AND "defaultProfileRev" = 0)
);
INSERT INTO "Account" (account, kind, "disabledAt")
VALUES ('$system', 'SYSTEM', CURRENT_TIMESTAMP);

-- Preserve the relationship author separately when attributing pending or historical
-- query-denial work to automation. Queue direction keys already identify that author.
UPDATE "DurableTask"
SET payload = payload || jsonb_build_object('intentAuthorUserId', "actorUserId"),
    "actorUserId" = (SELECT id FROM "Account" WHERE kind = 'SYSTEM')
WHERE "taskType" IN ('END_FRIENDSHIP', 'REVOKE_USER_RELATIONSHIP')
  AND payload ? 'expectedAuthorizationEpoch'
  AND "actorUserId" IS NOT NULL;
UPDATE "DurableTask"
SET "actorUserId" = (SELECT id FROM "Account" WHERE kind = 'SYSTEM')
WHERE "taskType" = 'REVOKE_FORBIDDEN_GROUP'
   OR ("taskType" = 'FORCE_REVOKE_GROUP_MEMBER' AND payload ? 'peerDomain');
