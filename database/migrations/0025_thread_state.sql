-- Publish complete conversation snapshots in the transaction that changes their facts.
CREATE FUNCTION publish_client_thread_state(owner_id integer, thread_id integer, activation_at bigint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE facts record;
DECLARE previous jsonb;
DECLARE snapshot jsonb;
DECLARE profile_ref jsonb;
DECLARE compact_key text;
DECLARE position integer;
DECLARE activated boolean;
BEGIN
  -- Serialize each owner's snapshot before reading any source facts.
  PERFORM 1 FROM "Account" WHERE id = owner_id FOR UPDATE;
  SELECT t.type, t."authorityNamespaceId", s.blocked, s.role, s."createdAt", p.active,
    CASE WHEN t.type = 'GROUP' THEN t."groupAccount"
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBAccount" ELSE p."endpointAAccount" END AS account,
    CASE WHEN t.type = 'GROUP' THEN t."groupDomain"
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBDomain" ELSE p."endpointADomain" END AS domain,
    CASE WHEN t.type = 'GROUP' THEN t."authorityNamespaceId"
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBNamespaceId" ELSE p."endpointANamespaceId" END AS namespace_id,
    COALESCE(i."profileRev", 0) AS profile_rev
  INTO facts
  FROM "AccountThreadState" s
  JOIN "Account" a ON a.id = s."accountId"
  JOIN "MessageThread" t ON t.id = s."threadId"
  JOIN "RelationshipPair" p ON p."threadId" = t.id AND p.established
    AND ((p."endpointAType" = 'USER' AND p."endpointAAccount" = a.account AND p."endpointADomain" = 'local')
      OR (p."endpointBType" = 'USER' AND p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'))
  LEFT JOIN "RelationshipIntent" i ON i."pairId" = p.id AND i."authorSide" =
    CASE WHEN p."endpointAType" = 'USER' AND p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN 'B' ELSE 'A' END
  WHERE s."accountId" = owner_id AND s."threadId" = thread_id;
  IF NOT FOUND THEN RETURN; END IF;
  compact_key := '["THREAD_STATE",0,"","local","' || thread_id::text || '","local"]';
  SELECT body INTO previous FROM "ClientStateFeed" WHERE "userId" = owner_id AND "compactionKey" = compact_key;
  activated := facts.active AND (previous IS NULL OR previous->>'conversationState' <> 'ACTIVE');
  profile_ref := CASE WHEN previous IS NOT NULL AND NOT activated THEN previous->'profile'
    ELSE jsonb_build_object('account', facts.account, 'domain', facts.domain,
      'namespaceId', CASE WHEN facts.domain = 'local' THEN 0 ELSE facts.namespace_id END,
      'profileRev', facts.profile_rev) END;
  snapshot := jsonb_build_object('threadId', thread_id, 'type', facts.type,
    'authorityNamespaceId', facts."authorityNamespaceId", 'blocked', facts.blocked,
    'role', CASE WHEN facts.active THEN facts.role ELSE NULL END,
    'conversationState', CASE WHEN facts.active THEN 'ACTIVE' ELSE 'READ_ONLY' END,
    'establishedAt', CASE WHEN activated AND activation_at IS NOT NULL THEN activation_at
      ELSE COALESCE((previous->>'establishedAt')::bigint, floor(extract(epoch FROM facts."createdAt") * 1000)::bigint) END,
    'profile', profile_ref);
  IF snapshot IS NOT DISTINCT FROM previous THEN RETURN; END IF;
  UPDATE "Account" SET "stateFeedAllocatedThrough" = "stateFeedAllocatedThrough" + 1
    WHERE id = owner_id RETURNING "stateFeedAllocatedThrough" INTO position;
  INSERT INTO "ClientStateFeed" ("userId", account, domain, "eventType", "subjectAccount", "subjectDomain", "namespaceId", "feedId", body, "compactionKey")
    VALUES (owner_id, '', 'local', 'THREAD_STATE', thread_id::text, 'local', 0, position, snapshot, compact_key)
    ON CONFLICT ("userId", "compactionKey") DO UPDATE SET body = EXCLUDED.body, "feedId" = EXCLUDED."feedId", "updatedAt" = CURRENT_TIMESTAMP;
END;
$$;

CREATE FUNCTION client_thread_state_after_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant record;
BEGIN
  IF NEW."threadId" IS NULL OR NOT NEW.established THEN RETURN NEW; END IF;
  FOR participant IN
    SELECT s."accountId" FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
    WHERE s."threadId" = NEW."threadId"
      AND ((NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account AND NEW."endpointADomain" = 'local')
        OR (NEW."endpointBType" = 'USER' AND NEW."endpointBAccount" = a.account AND NEW."endpointBDomain" = 'local'))
    ORDER BY s."accountId"
  LOOP
    PERFORM publish_client_thread_state(participant."accountId", NEW."threadId",
      CASE WHEN NEW.active AND (TG_OP = 'INSERT' OR NOT OLD.active)
        THEN floor(extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint ELSE NULL END);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_thread_state_after_pair AFTER INSERT OR UPDATE OF active, established, "threadId" ON "RelationshipPair"
  FOR EACH ROW EXECUTE FUNCTION client_thread_state_after_pair();

CREATE FUNCTION client_thread_state_after_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM publish_client_thread_state(NEW."accountId", NEW."threadId");
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_thread_state_after_participant AFTER INSERT OR UPDATE OF blocked, role ON "AccountThreadState"
  FOR EACH ROW EXECUTE FUNCTION client_thread_state_after_participant();

-- Rebuild all established conversations, including empty and retained read-only threads.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT "accountId", "threadId" FROM "AccountThreadState" ORDER BY "accountId", "threadId" LOOP
    PERFORM publish_client_thread_state(item."accountId", item."threadId");
  END LOOP;
END;
$$;
DELETE FROM "ClientStateFeed" WHERE "eventType" = 'THREAD_BLOCK';
