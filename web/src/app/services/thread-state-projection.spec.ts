import { describe, expect, it } from 'vitest';
import { applyThreadStateSnapshot } from './thread-state-projection';
import { threadFeedSnapshot } from './thread-feed.test-helper';

describe('complete thread-feed structure projection', () => {
  it('preserves the remote group origin viewer namespace rather than substituting a local zero', () => {
    const snapshot = threadFeedSnapshot(9, {
      type: 'GROUP',
      profileAccount: '!team',
      publisherNamespaceId: 7,
      selfMentionNamespaceId: 12,
      profileRev: 1,
    });
    expect(
      applyThreadStateSnapshot(undefined, snapshot, 1).selfMentionNamespaceId,
    ).toBe(12);
    expect(
      applyThreadStateSnapshot(
        undefined,
        { ...snapshot, selfMentionNamespaceId: null },
        1,
      ).selfMentionNamespaceId,
    ).toBeNull();
  });
  it('creates a thread and retains content across block changes and stale replays', () => {
    const firstSnapshot = threadFeedSnapshot(9, {
      threadFeedId: 2,
      profileAccount: 'bob',
      publisherNamespaceId: 0,
      profileRev: 1,
    });
    const first = applyThreadStateSnapshot(undefined, firstSnapshot, 2);
    expect(first).toMatchObject({
      type: 'P2P',
      threadFeedId: 2,
      visible: true,
    });
    const withContent = {
      ...first,
      lastMessageSeq: 5,
      lastMessageAt: 100,
      unreadCount: 4,
      lastMessagePreview: 'hello',
    };
    const blocked = applyThreadStateSnapshot(
      withContent,
      { ...firstSnapshot, threadFeedId: 3, blocked: true },
      3,
    );
    expect(blocked).toMatchObject({
      blocked: true,
      lastMessageSeq: 5,
      unreadCount: 4,
      lastMessagePreview: 'hello',
    });
    expect(applyThreadStateSnapshot(blocked, firstSnapshot, 2)).toBe(blocked);
  });

  it('retains a newer group-meta profile, roster and cursor across lifecycle changes', () => {
    const initial = threadFeedSnapshot(9, {
      threadFeedId: 2,
      type: 'GROUP',
      profileAccount: '!group',
      publisherNamespaceId: 0,
      profileRev: 1,
    });
    const first = applyThreadStateSnapshot(undefined, initial, 2);
    if (first.type !== 'GROUP') throw new Error('group expected');
    const latest = {
      ...first,
      group: {
        ...first.group,
        profileRev: 3,
        name: 'Current group',
        memberCount: 4,
        groupMetaFeedId: '20',
      },
    };
    expect(
      applyThreadStateSnapshot(
        latest,
        { ...initial, threadFeedId: 3, blocked: true },
        3,
      ),
    ).toMatchObject({ group: { profileRev: 3, name: 'Current group' } });
    expect(
      applyThreadStateSnapshot(
        latest,
        { ...initial, threadFeedId: 6, conversationState: 'READ_ONLY' },
        6,
      ),
    ).toMatchObject({ group: { memberCount: 4, groupMetaFeedId: '20' } });
  });
});
