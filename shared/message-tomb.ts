export type MessageDeletionType = 'USER_RETRACTION' | 'MODERATION_REMOVAL';

export interface MessageSlotIdentity {
  threadId: number;
  seq: number;
  creator: { account: string; namespaceId: number } | null;
  profileRev: number;
  createdAt: number;
  updatedAt: number;
}

/** A coordinate-only permanent deletion marker, not a visible message slot. */
export interface MessageDeletionMarker {
  threadId: number;
  seq: number;
  contentType: 'TOMB';
  isDeleted: true;
  deletionType: MessageDeletionType;
}

/** A wire-only history tomb with its original slot identity, never a local display row.
 * Persistent caches retain only MessageDeletionMarker; mounted UI rows own their presentation. */
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

/** Construct a permanent deletion marker using only its coordinates and reason. */
export function createMessageDeletionMarker(
  threadId: number,
  seq: number,
  deletionType: MessageDeletionType,
): MessageDeletionMarker {
  if (
    deletionType !== 'USER_RETRACTION' &&
    deletionType !== 'MODERATION_REMOVAL'
  )
    throw new Error('Invalid message deletion type');
  return { threadId, seq, contentType: 'TOMB', isDeleted: true, deletionType };
}
