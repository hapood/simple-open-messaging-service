ALTER TABLE "GroupMetaMemberFeed"
  DROP CONSTRAINT "GroupMetaMemberFeed_body_check";

UPDATE "GroupMetaMemberFeed" departed
SET body = (
  SELECT prior.body
  FROM "GroupMetaMemberFeed" prior
  WHERE prior."targetPeerDomain" = departed."targetPeerDomain"
    AND prior."groupId" = departed."groupId"
    AND prior."memberDomain" = departed."memberDomain"
    AND prior."memberAccount" = departed."memberAccount"
    AND prior.operation = 'UPSERT'
    AND prior."feedId" < departed."feedId"
  ORDER BY prior."feedId" DESC
  LIMIT 1
)
WHERE departed.operation = 'DEPART'
  AND departed.body = '{}'::jsonb
  AND EXISTS (
    SELECT 1
    FROM "GroupMetaMemberFeed" prior
    WHERE prior."targetPeerDomain" = departed."targetPeerDomain"
      AND prior."groupId" = departed."groupId"
      AND prior."memberDomain" = departed."memberDomain"
      AND prior."memberAccount" = departed."memberAccount"
      AND prior.operation = 'UPSERT'
      AND prior."feedId" < departed."feedId"
  );

ALTER TABLE "GroupMetaMemberFeed"
  ADD CONSTRAINT "GroupMetaMemberFeed_body_check"
  CHECK ("body" <> '{}'::jsonb);
