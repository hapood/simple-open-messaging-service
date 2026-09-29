export function toFederationWireDomain(domain: string): string {
  return domain;
}

export function toProfileWireDomain(
  domain: string,
  profileNamespaceId: number,
): string {
  return profileNamespaceId === 0 ? 'local' : domain;
}
