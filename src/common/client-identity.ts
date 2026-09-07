export interface NamespacedAddress {
  account: string;
  domain: string;
  namespaceId: number;
}

/** Project a subject address, without changing the enclosing fact's publisher coordinate.
 * Locality is determined by the address, never by whether an Account row exists. */
export function toClientIdentity(
  identity: NamespacedAddress,
  localDomain: string,
): NamespacedAddress {
  return identity.domain === 'local' || identity.domain === localDomain
    ? { account: identity.account, domain: 'local', namespaceId: 0 }
    : { ...identity };
}
