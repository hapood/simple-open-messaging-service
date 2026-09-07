-- Repair compacted client facts created from authoring defaults. Reallocate changed facts so
-- existing clients receive the correction through their normal state-feed delta on reconnect.
WITH selected AS (
  SELECT feed.id, feed."userId", feed.body,
    jsonb_set(feed.body, '{peer}', (feed.body -> 'peer') || jsonb_build_object(
      'profileRev', COALESCE(intent."profileRev", 0),
      'name', COALESCE(profile."displayName", peer.account),
      'avatar', COALESCE(profile.avatar, ''),
      'bio', COALESCE(profile.bio, '')
    )) AS corrected
  FROM "ClientStateFeed" feed
  JOIN "User" self ON self.id = feed."userId"
  JOIN "User" peer ON peer.account = feed.body #>> '{peer,account}'
    AND peer.domain = feed.body #>> '{peer,domain}'
    AND peer."namespaceId" = CASE WHEN peer.domain = 'local' THEN 0 ELSE feed."namespaceId" END
  JOIN "RelationshipPair" pair ON pair.kind = 'P2P'
  CROSS JOIN LATERAL (VALUES
    ('A', pair."endpointAAccount", pair."endpointADomain", pair."endpointANamespaceId", pair."endpointBAccount", pair."endpointBNamespaceId"),
    ('B', pair."endpointBAccount", pair."endpointBDomain", pair."endpointBNamespaceId", pair."endpointAAccount", pair."endpointANamespaceId")
  ) side(author, peer_account, peer_domain, peer_namespace, self_account, self_namespace)
  LEFT JOIN "RelationshipIntent" intent ON intent."pairId" = pair.id AND intent."authorSide" = side.author
  LEFT JOIN "ProfileVersion" profile ON profile."userId" = peer.id AND profile."profileRev" = intent."profileRev"
  WHERE feed."eventType" = 'RELATIONSHIP_INTENT'
    AND jsonb_typeof(feed.body -> 'peer') = 'object'
    AND side.peer_account = peer.account AND side.peer_namespace = peer."namespaceId"
    AND (peer.domain = 'local' OR side.peer_domain = peer.domain)
    AND side.self_account = self.account AND side.self_namespace = 0
), changed AS (
  SELECT id, "userId", corrected,
    row_number() OVER (PARTITION BY "userId" ORDER BY id)::integer AS position
  FROM selected WHERE body IS DISTINCT FROM corrected
), counts AS (
  SELECT "userId", count(*)::integer AS amount FROM changed GROUP BY "userId"
), allocated AS (
  UPDATE "Account" owner
  SET "stateFeedAllocatedThrough" = owner."stateFeedAllocatedThrough" + counts.amount,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM counts WHERE owner.id = counts."userId"
  RETURNING owner.id, owner."stateFeedAllocatedThrough" - counts.amount AS base
)
UPDATE "ClientStateFeed" feed
SET body = changed.corrected, "feedId" = allocated.base + changed.position,
  "updatedAt" = CURRENT_TIMESTAMP
FROM changed JOIN allocated ON allocated.id = changed."userId"
WHERE feed.id = changed.id;
