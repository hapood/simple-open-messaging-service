const requiredPairsSql = `
  SELECT DISTINCT reference."publisherNamespaceId", reference."profileNamespaceId"
  FROM (
    SELECT thread."authorityNamespaceId" AS "publisherNamespaceId",
      (fact.body ->> 'namespaceId')::integer AS "profileNamespaceId"
    FROM "GroupMetaMemberFeed" fact
    JOIN "MessageThread" thread ON thread.id = fact."threadId"
    WHERE fact.operation = 'MEMBER_UPSERT'
    UNION
    SELECT message."publisherNamespaceId", message."profileNamespaceId"
    FROM "Message" message
    WHERE message."contentType" <> 'SYSTEM' AND message."localState" = 'READY'
  ) reference
  JOIN "IdentityNamespace" publisher ON publisher.id = reference."publisherNamespaceId"
  WHERE reference."publisherNamespaceId" > 0
    AND reference."profileNamespaceId" IS NOT NULL
    AND reference."profileNamespaceId" IS DISTINCT FROM publisher."peerAssignedLocalNamespaceId"
  ORDER BY reference."publisherNamespaceId", reference."profileNamespaceId"
`;

export async function resolveNamespaceUntilReady(
  actor,
  pair,
  timeoutMs,
  intervalMs = 100,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await actor.post(
      '/profile-namespaces/resolve',
      pair,
      `resolve profile namespace ${JSON.stringify(pair)}`,
    );
    if (result?.status === 'READY') {
      const entry = result.entry;
      if (
        entry?.publisherNamespaceId !== pair.publisherNamespaceId ||
        entry?.profileNamespaceId !== pair.profileNamespaceId
      )
        throw new Error(
          `namespace resolver returned a different pair for ${JSON.stringify(pair)}`,
        );
      if (!entry.expired && entry.domain && entry.rootPublicKey) return entry;
    } else if (result?.status !== 'PENDING') {
      throw new Error(
        `invalid namespace resolution result ${JSON.stringify(result)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${actor.address}: timed out resolving namespace ${JSON.stringify(pair)}`,
  );
}

/** Exercise lazy client namespace demand before comparing domain-based facts.
 * Read-only auditing cannot itself populate an unrequested binding cache. */
export async function resolveWorkloadNamespaces({
  connections,
  actors,
  timeoutMs,
  onProgress = console.log,
}) {
  const checks = [];
  for (const { node, client } of connections.values()) {
    const { rows: pairs } = await client.query(requiredPairsSql);
    const actor = actors.nodes.get(node.name)?.users.values().next().value;
    if (pairs.length && !actor)
      throw new Error(`no namespace resolver actor on ${node.name}`);
    for (const pair of pairs) {
      const entry = await resolveNamespaceUntilReady(actor, pair, timeoutMs);
      checks.push({ nodeName: node.name, pair, entry });
    }
  }
  onProgress(`[namespace] resolved ${checks.length} publisher-scoped bindings`);
  return checks;
}
