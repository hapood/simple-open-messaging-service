export interface HistoryEdgeCandidate {
  optimistic: boolean;
  transient: boolean;
  leaving: boolean;
}

/** Pending and exiting rows never stand in for a history boundary. */
export function selectHistoryEdges<T extends HistoryEdgeCandidate>(
  entries: readonly T[],
  isHistory: (entry: T) => boolean,
): { older: T | null; newer: T | null } {
  let older: T | null = null;
  let newer: T | null = null;
  for (const entry of entries) {
    if (
      entry.optimistic ||
      entry.transient ||
      entry.leaving ||
      !isHistory(entry)
    )
      continue;
    older ??= entry;
    newer = entry;
  }
  return { older, newer };
}
