import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
  type ThreadListRecord,
} from './model';

/** Merge only structural state; feed previews and local read progress have independent
 *  ownership. Profile selection is not projected here: the attention snapshot carries the
 *  selected revision into storage feed-gated, and the in-memory list adopts it in
 *  `applyThreadFeedOrder`. */
export function applyThreadStateSnapshot(
  current: ThreadListRecord | undefined,
  snapshot: ThreadFeedSnapshot,
  feedId: number,
): ConversationItem {
  if (!Number.isSafeInteger(feedId) || feedId < 1)
    throw new Error('invalid thread state snapshot');
  if (current?.threadFeedId && current.threadFeedId >= feedId) return current;
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
  return {
    ...base,
    threadFeedId: feedId,
    visible: true,
    publisherNamespaceId: snapshot.publisherNamespaceId,
    selfMentionNamespaceId: snapshot.selfMentionNamespaceId,
    conversationState: snapshot.conversationState,
    blocked: snapshot.blocked,
    role: snapshot.role,
    friendshipActive:
      snapshot.type === 'P2P'
        ? snapshot.conversationState === 'ACTIVE'
        : undefined,
  };
}
