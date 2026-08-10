/** Federation v1 has one mandatory wire surface and no capability branches. */
export const FEDERATION_PROTOCOL_VERSION = 1 as const;
export const FEDERATION_PROTOCOL_VERSIONS = [
  FEDERATION_PROTOCOL_VERSION,
] as const;
export const CLIENT_API_PREFIX = 'api/v1' as const;
export const FEDERATION_API_PREFIX =
  `s2s/v${FEDERATION_PROTOCOL_VERSION}` as const;
export const FEDERATION_WELL_KNOWN_PATH = '.well-known/soms' as const;

/** Pick the highest mutually supported major. Invalid/duplicate peer lists have no negotiation result. */
export function selectFederationProtocolVersion(
  peerVersions: unknown,
): number | null {
  if (
    !Array.isArray(peerVersions) ||
    peerVersions.length === 0 ||
    peerVersions.some(
      (value, index) =>
        !Number.isSafeInteger(value) ||
        value < 1 ||
        (index > 0 && value <= peerVersions[index - 1]),
    )
  ) {
    return null;
  }
  const supported = new Set<number>(FEDERATION_PROTOCOL_VERSIONS);
  return (
    [...peerVersions]
      .reverse()
      .find((version): version is number => supported.has(version)) ?? null
  );
}
