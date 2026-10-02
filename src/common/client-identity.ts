export interface NamespacedAddress {
  account: string;
  domain: string;
  namespaceId: number;
}

/**
 * Project a publisher-scoped subject address to local storage coordinates.
 * Locality is decided only by the protocol marker plus namespace coordinate;
 * the configured local domain is not an identity signal.
 */
export function toClientIdentityOrNull(
  identity: NamespacedAddress,
): NamespacedAddress | null {
  if (identity.domain === 'local') {
    return identity.namespaceId === 0
      ? { account: identity.account, domain: 'local', namespaceId: 0 }
      : null;
  }
  return identity.namespaceId === 0 ? null : { ...identity };
}

/** Compatibility wrapper for call sites that still treat an invalid wire subject
 * as an operation-level validation failure. Inbound page processors should prefer
 * toClientIdentityOrNull when they can warn and drop one enclosing item. */
export function toClientIdentity(
  identity: NamespacedAddress,
): NamespacedAddress {
  const projected = toClientIdentityOrNull(identity);
  if (!projected) throw new Error('invalid local subject namespace');
  return projected;
}
