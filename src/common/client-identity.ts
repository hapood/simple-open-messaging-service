import { isValidSomfpDomain } from './account.js';

export interface NamespacedAddress {
  account: string;
  domain: string;
  namespaceId: number;
}

/** Validate a namespaced subject address without rewriting its real domain. */
export function validateNamespacedAddressOrNull(
  identity: NamespacedAddress,
): NamespacedAddress | null {
  if (
    !isValidSomfpDomain(identity.domain) ||
    !Number.isSafeInteger(identity.namespaceId) ||
    identity.namespaceId < 0
  ) {
    return null;
  }
  return { ...identity };
}

export function validateNamespacedAddress(
  identity: NamespacedAddress,
): NamespacedAddress {
  const validated = validateNamespacedAddressOrNull(identity);
  if (!validated) throw new Error('invalid namespaced subject address');
  return validated;
}
