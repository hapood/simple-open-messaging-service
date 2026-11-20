/** A window-local skipped interval, never durable coverage evidence. */
export interface EntrySkippedInterval {
  readonly after: number;
  readonly through: number;
}

export interface EntrySuffixPlan<T> {
  /** Only identities absent from the delivery-time mounted window. */
  readonly additions: readonly T[];
  readonly skipped: EntrySkippedInterval | undefined;
}

/** Decide the entry join from raw identities before album aggregation.
 * Non-message rows remain renderable but provide no message coverage evidence.
 * The caller owns the atomic mutation, geometry, and demand lifetimes. */
export function planEntrySuffix<T>(
  mounted: readonly T[],
  response: readonly T[],
  readSeq: number,
  identity: (item: T) => number,
  messageSeqs: (item: T) => readonly number[],
): EntrySuffixPlan<T> {
  const seen = new Set(mounted.map(identity));
  const mountedMessages = new Set(
    mounted.flatMap((item) => [...messageSeqs(item)]),
  );
  const additions: T[] = [];
  let overlaps = false;
  for (const item of response) {
    const seqs = messageSeqs(item);
    if (seqs.some((seq) => mountedMessages.has(seq))) overlaps = true;
    if (seen.has(identity(item))) continue;
    // Raw source messages may already be represented by a mounted album.
    if (seqs.length > 0 && seqs.every((seq) => mountedMessages.has(seq)))
      continue;
    seen.add(identity(item));
    additions.push(item);
  }
  let mountedTail: number | undefined;
  for (const seq of mountedMessages)
    if (mountedTail === undefined || seq > mountedTail) mountedTail = seq;
  const hasSuffix = additions.some((item) =>
    messageSeqs(item).some((seq) => seq > readSeq),
  );
  return {
    additions,
    skipped:
      !overlaps &&
      mountedTail !== undefined &&
      mountedTail < readSeq &&
      hasSuffix
        ? { after: mountedTail, through: readSeq }
        : undefined,
  };
}

/** Successful gap replacement discards the old prefix even for an empty page.
 * The suffix supplied here must be the suffix still mounted at delivery time.
 * Failure never calls this planner and therefore cannot discard the prefix. */
export function planEntryGapReplacement<T>(
  suffix: readonly T[],
  page: readonly T[],
  identity: (item: T) => number,
  messageSeqs: (item: T) => readonly number[],
): { readonly prepend: readonly T[]; readonly suffix: readonly T[] } {
  const seen = new Set(suffix.map(identity));
  const suffixMessages = new Set(
    suffix.flatMap((item) => [...messageSeqs(item)]),
  );
  const prepend: T[] = [];
  for (const item of page) {
    const seqs = messageSeqs(item);
    if (
      seen.has(identity(item)) ||
      (seqs.length > 0 && seqs.every((seq) => suffixMessages.has(seq)))
    )
      continue;
    seen.add(identity(item));
    prepend.push(item);
  }
  return { prepend, suffix };
}
