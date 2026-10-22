/** Canonical address representation used only for relationship-pair advisory
 * lock keys. Persisted endpoint identity remains account/namespace columns. */
export interface PairEndpointAddress {
  readonly profileNamespaceId: number;
  readonly account: string;
}

export function completeBusinessAddress(
  account: string,
  profileNamespaceId: number,
): PairEndpointAddress {
  return { account: account.toLowerCase(), profileNamespaceId };
}
