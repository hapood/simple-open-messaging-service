import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
  type ThreadListRecord,
} from './model';

/** Merge only structural state; feed previews and local read progress have independent ownership. */
export function applyThreadStateSnapshot(
  current: ThreadListRecord | undefined,
  snapshot: ThreadFeedSnapshot,
  feedId: number,
): ConversationItem {
  if (
    !Number.isSafeInteger(feedId) ||
    feedId < 1
  )
    throw new Error('invalid thread state snapshot');
  if (current?.threadFeedId && current.threadFeedId >= feedId)
    return current;
  if (current && current.type !== snapshot.type)
    throw new Error('thread type changed');
  const identity = {
    account: snapshot.profileAccount,
    namespaceId: snapshot.publisherNamespaceId,
    profileRev: snapshot.profileRev,
    name: '',
  };
  const base =
    current ??
    (snapshot.type === 'P2P'
      ? createP2PConversation(snapshot.threadId, identity)
      : createGroupConversation(snapshot.threadId, {
          ...identity,
          id: snapshot.threadId,
        }));
  const next = {
    ...base,
    threadFeedId: feedId,
    visible: true,
    publisherNamespaceId: snapshot.publisherNamespaceId,
    conversationState: snapshot.conversationState,
    blocked: snapshot.blocked,
    role: snapshot.role,
    friendshipActive:
      snapshot.type === 'P2P'
        ? snapshot.conversationState === 'ACTIVE'
        : undefined,
  };
  if (next.type === 'P2P') {
    const sameAddress =
      next.peerUser.account === identity.account &&
      next.peerUser.namespaceId === identity.namespaceId;
    if (!sameAddress) {
      next.peerProfileMessageSeq = undefined;
      next.profileRev = identity.profileRev;
    } else if (next.peerProfileMessageSeq == null) {
      next.profileRev = Math.max(next.profileRev, identity.profileRev);
    }
    if (next.peerProfileMessageSeq == null) {
      const { profileRev: _rev, ...peerIdentity } = identity;
      next.peerUser = {
        ...next.peerUser,
        ...peerIdentity,
        ...(sameAddress && next.profileRev === identity.profileRev
          ? { name: next.peerUser.name }
          : { avatar: '', bio: '' }),
      };
    }
  }
  return next;
}
