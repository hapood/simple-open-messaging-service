ALTER TABLE "GroupMetaMemberFeed"
  DROP CONSTRAINT "GroupMetaMemberFeed_body_check";

ALTER TABLE "GroupMetaMemberFeed"
  ADD CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (
    jsonb_typeof(body) = 'object'
    AND (
      (operation = 'MEMBER_UPSERT' AND body <> '{}'::jsonb)
      OR (operation = 'MEMBER_DEPART' AND body <> '{}'::jsonb)
      OR (operation = 'GROUP_PROFILE' AND body <> '{}'::jsonb)
    )
  );
