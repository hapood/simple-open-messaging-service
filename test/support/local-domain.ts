/**
 * This node's configured identity domain. The namespace-zero row in the test
 * database is seeded with exactly this value, so it is the correct wire
 * `domain` hint whenever a test addresses a local account alongside
 * `namespaceId: 0`.
 */
export function localIdentityDomain(): string {
  return process.env.SOMS_DOMAIN ?? 'e2e-local.test';
}
