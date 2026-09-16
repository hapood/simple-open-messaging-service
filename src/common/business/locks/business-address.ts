/** Canonical address representation used only for relationship-pair advisory
 * lock keys. Persisted endpoint identity remains account/domain columns. */
export type PairEndpointAddress = `${string}@${string}`;

export function completeBusinessAddress(
  account: string,
  domain: string,
): PairEndpointAddress {
  return `${account}@${domain}`.toLowerCase() as PairEndpointAddress;
}
