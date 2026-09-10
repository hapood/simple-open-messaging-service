-- System notification authors use the reserved local account. Event content has
-- no legacy decoder; this migration changes only the sender invariant.
ALTER TABLE "Message" DROP CONSTRAINT "Message_system_creator_check";
UPDATE "Message" SET "creatorAccount" = '$system', "creatorDomain" = 'local',
  "creatorNamespaceId" = 0, "profileRev" = 0
WHERE "contentType" = 'SYSTEM';
ALTER TABLE "Message" ADD CONSTRAINT "Message_system_creator_check" CHECK (
  "creatorAccount" IS NOT NULL AND "creatorDomain" IS NOT NULL AND (
    ("contentType" = 'SYSTEM' AND "creatorAccount" = '$system'
      AND "creatorDomain" = 'local' AND "creatorNamespaceId" = 0
      AND "profileRev" = 0 AND "sourceNamespaceId" = 0)
    OR ("contentType" <> 'SYSTEM' AND "creatorAccount" <> '$system')
  )
);
