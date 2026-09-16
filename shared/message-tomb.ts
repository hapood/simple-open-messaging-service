export type MessageDeletionType = 'USER_RETRACTION' | 'MODERATION_REMOVAL';

export interface MessageSlotIdentity {
  threadId: number;
  seq: number;
  creator: { account: string; domain: string; namespaceId: number } | null;
  profileRev: number;
  createdAt: number;
  updatedAt: number;
}

/** A deletion learned before its message. Unknown identity must never be invented. */
export interface MessageDeletionMarker {
  threadId: number;
  seq: number;
  contentType: 'TOMB';
  isDeleted: true;
  deletionType: MessageDeletionType;
}

export type MessageTomb = MessageSlotIdentity & MessageDeletionMarker;

export function messageTomb(
  identity: MessageSlotIdentity,
  deletionType: MessageDeletionType,
): MessageTomb {
  if (
    deletionType !== 'USER_RETRACTION' &&
    deletionType !== 'MODERATION_REMOVAL'
  )
    throw new Error('Invalid message deletion type');
  return {
    threadId: identity.threadId,
    seq: identity.seq,
    creator: identity.creator,
    profileRev: identity.profileRev,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    contentType: 'TOMB',
    isDeleted: true,
    deletionType,
  };
}

type LiveSlot = MessageSlotIdentity & {
  contentType: string;
  isDeleted: boolean;
};

/** One merge for page commits and individual writes. Deletions win, identity can arrive later. */
export function mergeMessageSlot<T extends LiveSlot>(
  // NoInfer: the slot type is determined by the incoming message alone —
  // current may legitimately be a tomb (or absent), which must not constrain T.
  current: NoInfer<T> | MessageDeletionMarker | undefined,
  incoming: T | MessageTomb,
): T | MessageTomb {
  if (incoming.isDeleted && incoming.contentType !== 'TOMB')
    throw new Error('Deleted messages must use the TOMB contract');
  if (current?.contentType === 'TOMB')
    return messageTomb(
      incoming,
      (current as MessageDeletionMarker).deletionType,
    );
  if (incoming.contentType === 'TOMB')
    return messageTomb(incoming, (incoming as MessageTomb).deletionType);
  return incoming;
}

/** Erase all body fields while retaining an existing slot's original identity. */
export function deleteMessageSlot(
  current: MessageSlotIdentity | MessageDeletionMarker | undefined,
  threadId: number,
  seq: number,
  deletionType: MessageDeletionType,
): MessageTomb | MessageDeletionMarker {
  if (current && 'creator' in current)
    return messageTomb(current, deletionType);
  if (
    deletionType !== 'USER_RETRACTION' &&
    deletionType !== 'MODERATION_REMOVAL'
  )
    throw new Error('Invalid message deletion type');
  return { threadId, seq, contentType: 'TOMB', isDeleted: true, deletionType };
}
