/** Author of the exact outer messageEndSeq, never an independent preview slot. */
export interface ThreadAuthor {
  account: string;
  /** Author namespace in the existing message/profile coordinate space. */
  namespaceId: number;
}

/** Validate before publishing or committing a complete thread snapshot. Zero is
 * the only head without an author; null and obsolete preview selectors are invalid. */
export function assertThreadAuthor(
  messageEndSeq: number,
  author: unknown,
): asserts author is ThreadAuthor | undefined {
  if (
    !Number.isInteger(messageEndSeq) ||
    messageEndSeq < 0 ||
    messageEndSeq > 2_147_483_647
  )
    throw new Error('Invalid thread author message head');
  if (messageEndSeq === 0) {
    if (author !== undefined)
      throw new Error('Zero message head must omit author');
    return;
  }
  if (!author || typeof author !== 'object' || Array.isArray(author))
    throw new Error('Nonzero message head requires an author');
  const value = author as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    typeof value['account'] !== 'string' ||
    value['account'].trim().length === 0 ||
    typeof value['namespaceId'] !== 'number' ||
    !Number.isSafeInteger(value['namespaceId']) ||
    value['namespaceId'] < 0
  )
    throw new Error('Invalid thread author identity');
}
