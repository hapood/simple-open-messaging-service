-- A local account always belongs to namespace zero. Mirrored group relations
-- can carry the remote group namespace on their endpoints, so they must not
-- override the local account's profile namespace.
CREATE OR REPLACE FUNCTION group_meta_member_namespace(
  p_thread_id integer, p_account text, p_domain text
) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_domain = 'local' THEN 0 ELSE COALESCE((
    SELECT pair."endpointBNamespaceId"
    FROM "RelationshipPair" pair
    WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = p_thread_id
      AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = p_account
      AND pair."endpointBDomain" = p_domain
    ORDER BY pair.active DESC, pair."updatedAt" DESC, pair.id DESC
    LIMIT 1
  ), (
    SELECT thread."authorityNamespaceId"
    FROM "MessageThread" thread WHERE thread.id = p_thread_id
  )) END;
$$;
