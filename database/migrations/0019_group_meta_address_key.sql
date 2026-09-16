-- Group Meta is compacted by member Address, regardless of namespace rollover.
WITH ranked AS (
  SELECT "threadId", "feedId",
    row_number() OVER (
      PARTITION BY "threadId", "memberAccount", "memberDomain"
      ORDER BY "feedId" DESC
    ) AS position
  FROM "GroupMetaMemberFeed"
)
DELETE FROM "GroupMetaMemberFeed" fact USING ranked old
WHERE fact."threadId" = old."threadId" AND fact."feedId" = old."feedId"
  AND old.position > 1;

DROP INDEX "GroupMetaMemberFeed_member_key";

ALTER TABLE "GroupMetaMemberFeed" DROP COLUMN "memberNamespaceId";

CREATE UNIQUE INDEX "GroupMetaMemberFeed_member_key"
  ON "GroupMetaMemberFeed" ("threadId", "memberAccount", "memberDomain");

-- Namespace belongs to the relationship or the mirrored group's source,
-- rather than to a Group Meta member fact.
CREATE FUNCTION group_meta_member_namespace(
  p_thread_id integer, p_account text, p_domain text
) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT pair."endpointBNamespaceId"
    FROM "RelationshipPair" pair
    WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = p_thread_id
      AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = p_account
      AND pair."endpointBDomain" = p_domain
    ORDER BY pair.active DESC, pair."updatedAt" DESC, pair.id DESC
    LIMIT 1
  ), CASE WHEN p_domain = 'local' THEN 0 ELSE (
    SELECT thread."authorityNamespaceId"
    FROM "MessageThread" thread WHERE thread.id = p_thread_id
  ) END);
$$;
