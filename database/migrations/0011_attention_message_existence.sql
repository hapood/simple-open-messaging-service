-- Message existence is independent of attachment download/materialization state.
CREATE OR REPLACE FUNCTION attention_message_eligible(m "Message", s "AccountThreadState", cleared integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT m."threadId" = s."threadId"
    AND NOT m."isDeleted" AND m.seq > COALESCE(cleared, 0)
    AND (s."messageVisibleThroughSeq" IS NULL OR m.seq <= s."messageVisibleThroughSeq")
    AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = s."accountId"
      AND a.account = m."creatorAccount" AND a.domain = m."creatorDomain"
      AND a."namespaceId" = m."creatorNamespaceId")
    AND NOT (s.blocked AND EXISTS (SELECT 1 FROM "MessageThread" t
      WHERE t.id = s."threadId" AND t.type = 'P2P'));
$$;

-- Recalculate existing snapshots using the new predicate and allocate attention IDs.
UPDATE "AccountThreadState" SET "attentionFeedId" = 0;
