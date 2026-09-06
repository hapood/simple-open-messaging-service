/** Exactly one coordinate, relative to the current sender/receiver, never a namespace ID on the wire. */
export type FederationQuoteTarget =
  | { seq: number; originSeq?: never }
  | { originSeq: number; seq?: never };

export function isFederationQuoteTarget(
  value: unknown,
): value is FederationQuoteTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== 'seq' && keys[0] !== 'originSeq'))
    return false;
  const seq = (value as Record<string, unknown>)[keys[0]];
  return (
    Number.isSafeInteger(seq) &&
    Number(seq) > 0 &&
    Number(seq) < Number.MAX_SAFE_INTEGER
  );
}

/** Translate the coordinate kind, not the number; no target lookup is needed on receipt. */
export function storeFederationQuote(
  target: FederationQuoteTarget,
  namespaceId: number,
): { seq: number; namespaceId: number } {
  return target.seq !== undefined
    ? { seq: target.seq, namespaceId }
    : { seq: target.originSeq, namespaceId: 0 };
}

/** Publication changes coordinate spaces only when the required mapping is known. */
export function publishFederationQuote(
  coordinate: { seq: number; namespaceId: number },
  target:
    | {
        seq: number;
        originSeq: number | null;
        sourceNamespaceId: number;
        creatorDomain: string | null;
      }
    | undefined,
  groupAuthority: boolean,
  peerNamespaceId: number,
): FederationQuoteTarget {
  if (target) {
    if (groupAuthority || target.creatorDomain === 'local')
      return { seq: target.seq };
    if (
      target.sourceNamespaceId === peerNamespaceId &&
      target.originSeq !== null
    )
      return { originSeq: target.originSeq };
  } else if (coordinate.seq > 0) {
    if (groupAuthority && coordinate.namespaceId === 0)
      return { seq: coordinate.seq };
    if (!groupAuthority && coordinate.namespaceId === peerNamespaceId)
      return { originSeq: coordinate.seq };
  }
  // A missing body is normal; losing the mapping needed to publish in another
  // namespace is a local data invariant violation. Never fabricate or drop a quote.
  throw new Error(
    'quote coordinate cannot be represented in the outgoing peer namespace',
  );
}
