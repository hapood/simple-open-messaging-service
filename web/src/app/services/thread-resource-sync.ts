/** Durable download targets; a row may precede its conversation record. */
export interface ThreadResourceTargets {
  threadId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: string;
}

/** Merge inside the same transaction as the producing feed's cursor. */
export function advanceThreadResourceTargets(
  current: ThreadResourceTargets | undefined,
  threadId: number,
  incoming: Partial<Omit<ThreadResourceTargets, 'threadId'>>,
): ThreadResourceTargets {
  if (!Number.isSafeInteger(threadId) || threadId <= 0)
    throw new Error('invalid resource target thread');
  if (current && current.threadId !== threadId)
    throw new Error('resource target belongs to another thread');
  const message = incoming.messageEndSeq ?? 0;
  const tomb = incoming.tombstoneEndSeq ?? 0;
  for (const value of [message, tomb]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('invalid resource sequence target');
  }
  const meta = incoming.groupMetaFeedEndId ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(meta))
    throw new Error('invalid group meta target');
  return {
    threadId,
    messageEndSeq: Math.max(current?.messageEndSeq ?? 0, message),
    tombstoneEndSeq: Math.max(current?.tombstoneEndSeq ?? 0, tomb),
    groupMetaFeedEndId:
      BigInt(meta) > BigInt(current?.groupMetaFeedEndId ?? '0')
        ? meta
        : (current?.groupMetaFeedEndId ?? '0'),
  };
}
