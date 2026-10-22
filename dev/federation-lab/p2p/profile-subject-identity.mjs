/** Resolve an audit identity from a complete publisher-scoped subject reference. */
export function profileSubjectIdentityJoins(
  publisherNamespaceId,
  profileNamespaceId,
  alias,
) {
  const native = `(${publisherNamespaceId} = 0 OR ${profileNamespaceId} = 0)`;
  return `
    LEFT JOIN "ProfileNamespace" ${alias}_binding
      ON ${alias}_binding."publisherNamespaceId" = ${publisherNamespaceId}
      AND ${alias}_binding."profileNamespaceId" = ${profileNamespaceId}
    LEFT JOIN "IdentityNamespace" ${alias}_native
      ON ${alias}_native.id = CASE
        WHEN ${publisherNamespaceId} = 0 THEN ${profileNamespaceId}
        WHEN ${profileNamespaceId} = 0 THEN ${publisherNamespaceId}
      END
    LEFT JOIN LATERAL (
      SELECT ns.id FROM "IdentityNamespace" ns
      WHERE ns.domain = ${alias}_binding.domain
      ORDER BY ns.id LIMIT 1
    ) ${alias}_subject ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN ${native} THEN ${alias}_native.id
        ELSE ${alias}_subject.id END AS id,
        CASE WHEN ${native} THEN ${alias}_native.domain
        ELSE ${alias}_binding.domain END AS domain
    ) ${alias} ON true
  `;
}
