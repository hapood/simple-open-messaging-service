-- Both origins and mirrors retain one current operation per stable key. The
-- newest coordinate survives; older same-member operations are obsolete.
WITH ranked AS (
  SELECT "threadId", "feedId",
    row_number() OVER (
      PARTITION BY "threadId", "memberAccount", "memberDomain",
        "memberNamespaceId" ORDER BY "feedId" DESC
    ) AS position
  FROM "GroupMetaMemberFeed"
)
DELETE FROM "GroupMetaMemberFeed" f USING ranked old
WHERE f."threadId" = old."threadId" AND f."feedId" = old."feedId"
  AND old.position > 1;

-- A mirror's DEPART removes its member projection; an origin keeps DEPART as
-- its one current operation so delta readers can observe the departure.
DELETE FROM "GroupMetaMemberFeed" f USING "MessageThread" t
WHERE t.id = f."threadId" AND t.type = 'GROUP'
  AND t."groupDomain" <> 'local' AND f.operation = 'DEPART';

DROP INDEX "GroupMetaMemberFeed_member_feed_idx";

CREATE UNIQUE INDEX "GroupMetaMemberFeed_member_key"
  ON "GroupMetaMemberFeed" (
    "threadId", "memberAccount", "memberDomain", "memberNamespaceId"
  );
