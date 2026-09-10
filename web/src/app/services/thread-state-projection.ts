import {
  isThreadStateSnapshot,
  type ThreadStateSnapshot,
} from '../../../../shared/thread-state';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
  type ThreadListRecord,
} from './model';

/** Merge only structural state; feed previews and local read progress have independent ownership. */
export function applyThreadStateSnapshot(
  current: ThreadListRecord | undefined,
  snapshot: ThreadStateSnapshot,
  feedId: number,
): ConversationItem {
  if (
    !isThreadStateSnapshot(snapshot) ||
    !Number.isSafeInteger(feedId) ||
    feedId < 1
  )
    throw new Error('invalid thread state snapshot');
  if (current?.type === 'PENDING') current = undefined;
  if (current?.threadStateFeedId && current.threadStateFeedId >= feedId)
    return current;
  if (current && current.type !== snapshot.type)
    throw new Error('thread type changed');
  const identity = {
    id: 0,
    ...snapshot.profile,
    name: snapshot.profile.account,
  };
  const base =
    current ??
    (snapshot.type === 'P2P'
      ? createP2PConversation(snapshot.threadId, identity)
      : createGroupConversation(snapshot.threadId, {
          ...identity,
          id: snapshot.threadId,
          ownerId: 0,
        }));
  const next = {
    ...base,
    defaultProfileResolved:
      current?.defaultProfileResolved === true &&
      JSON.stringify(current.defaultProfile) ===
        JSON.stringify(snapshot.profile),
    visible: true,
    threadStateFeedId: feedId,
    authorityNamespaceId: snapshot.authorityNamespaceId,
    establishedAt: snapshot.establishedAt,
    defaultProfile: snapshot.profile,
    conversationState: snapshot.conversationState,
    blocked: snapshot.blocked,
    role: snapshot.role,
    friendshipActive:
      snapshot.type === 'P2P'
        ? snapshot.conversationState === 'ACTIVE'
        : undefined,
  };
  if (next.type === 'P2P' && next.peerProfileMessageSeq == null) {
    const same =
      next.peerUser.account === identity.account &&
      next.peerUser.domain === identity.domain &&
      next.peerUser.namespaceId === identity.namespaceId &&
      next.peerUser.profileRev === identity.profileRev;
    next.peerUser = {
      ...next.peerUser,
      ...identity,
      ...(same ? { name: next.peerUser.name } : { avatar: '', bio: '' }),
    };
  } else if (
    next.type === 'GROUP' &&
    (!current?.defaultProfile ||
      JSON.stringify(current.defaultProfile) !==
        JSON.stringify(snapshot.profile))
  ) {
    const same =
      next.group.account === identity.account &&
      next.group.domain === identity.domain &&
      next.group.namespaceId === identity.namespaceId &&
      next.group.profileRev === identity.profileRev;
    next.group = {
      ...next.group,
      ...identity,
      id: snapshot.threadId,
      ...(same ? { name: next.group.name } : { avatar: '', description: '' }),
    };
  }
  return next;
}
