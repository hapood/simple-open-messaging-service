import type { ThreadStateSnapshot } from '../../../../shared/thread-state';
import type { ClientStateFeedItem } from './user.service';

export function threadStateEvent(
  feedId: number,
  threadId: number,
  overrides: Partial<ThreadStateSnapshot> = {},
): Extract<ClientStateFeedItem, { eventType: 'THREAD_STATE' }> {
  return {
    feedId,
    eventType: 'THREAD_STATE',
    namespaceId: 0,
    account: '',
    domain: 'local',
    subjectAccount: String(threadId),
    subjectDomain: 'local',
    body: {
      threadId,
      type: 'P2P',
      authorityNamespaceId: 0,
      conversationState: 'ACTIVE',
      establishedAt: 1,
      blocked: false,
      role: null,
      profile: {
        account: 'bob',
        domain: 'local',
        namespaceId: 0,
        profileRev: 0,
      },
      ...overrides,
    },
  };
}
