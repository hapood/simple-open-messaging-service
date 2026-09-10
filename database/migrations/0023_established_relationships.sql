ALTER TABLE "RelationshipPair" ADD COLUMN established boolean NOT NULL DEFAULT false;

-- Recover completed relationships from retained activation/departure evidence.
-- A request shell alone is not evidence of a conversation.
UPDATE "RelationshipPair" pair SET established = true
WHERE pair.active OR EXISTS (
  SELECT 1 FROM "AccountThreadState" state JOIN "Account" a ON a.id = state."accountId"
  WHERE state."threadId" = pair."threadId" AND state."messageVisibleThroughSeq" IS NOT NULL
    AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = a.account AND pair."endpointADomain" = 'local')
      OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = a.account AND pair."endpointBDomain" = 'local'))
) OR (pair.kind = 'P2P' AND EXISTS (
  SELECT 1 FROM "Message" m WHERE m."threadId" = pair."threadId" AND m."contentType" = 'SYSTEM'
    AND m.content->>'type' IN ('FRIEND_ADDED', 'FRIEND_REMOVED')
)) OR (pair.kind = 'GROUP_MEMBER' AND EXISTS (
  SELECT 1 FROM "GroupMetaMemberFeed" member WHERE member."threadId" = pair."threadId"
    AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = member."memberAccount"
      AND pair."endpointADomain" = member."memberDomain" AND pair."endpointANamespaceId" = member."memberNamespaceId")
      OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = member."memberAccount"
      AND pair."endpointBDomain" = member."memberDomain" AND pair."endpointBNamespaceId" = member."memberNamespaceId"))
));

-- Keep the fact monotonic even for other transactional relationship writers.
CREATE FUNCTION relationship_establishment_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.established := NEW.established OR NEW.active;
  IF TG_OP = 'UPDATE' THEN NEW.established := NEW.established OR OLD.established; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER relationship_establishment_before_write
BEFORE INSERT OR UPDATE ON "RelationshipPair"
FOR EACH ROW EXECUTE FUNCTION relationship_establishment_before_write();

-- Reindex retained client facts so existing devices receive the new lifecycle fact.
DO $$
DECLARE item record;
DECLARE new_id integer;
BEGIN
  FOR item IN
    SELECT feed.id, feed."userId", EXISTS (
      SELECT 1 FROM "RelationshipPair" pair JOIN "Account" a ON a.id = feed."userId"
      WHERE pair.established AND pair."threadId" = COALESCE((feed.body->>'localThreadId')::integer, (feed.body->>'threadId')::integer)
        AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = a.account AND pair."endpointADomain" = 'local')
          OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = a.account AND pair."endpointBDomain" = 'local'))
    ) AS established
    FROM "ClientStateFeed" feed WHERE feed."eventType" = 'RELATIONSHIP_INTENT'
    ORDER BY feed."userId", feed."feedId"
  LOOP
    UPDATE "Account" SET "stateFeedAllocatedThrough" = "stateFeedAllocatedThrough" + 1
      WHERE id = item."userId" RETURNING "stateFeedAllocatedThrough" INTO new_id;
    UPDATE "ClientStateFeed" SET body = body || jsonb_build_object('established', item.established),
      "feedId" = new_id WHERE id = item.id;
  END LOOP;
END;
$$;
