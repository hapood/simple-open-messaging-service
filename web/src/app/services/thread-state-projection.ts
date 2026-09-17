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
  const threadFeedId = current?.threadFeedId;
  if (current?.type === 'PENDING') current = undefined;
  if (current?.threadStateFeedId && current.threadStateFeedId >= feedId)
    return current;
  if (current && current.type !== snapshot.type)
    throw new Error('thread type changed');
  const identity = {
    id: 0,
    ...snapshot.profile,
    name: '',
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
    ...(threadFeedId !== undefined ? { threadFeedId } : {}),
    visible: true,
    threadStateFeedId: feedId,
    authorityNamespaceId: snapshot.authorityNamespaceId,
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
  }
  return next;
}
