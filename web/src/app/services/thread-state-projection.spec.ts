import { describe, expect, it } from 'vitest';
import { applyThreadStateSnapshot } from './thread-state-projection';
import { threadStateEvent } from './thread-state.test-helper';

describe('thread state projection', () => {
  it('promotes a pending item and retains content when blocking or replaying a state', () => {
    const body = threadStateEvent(2, 9).body;
    const first = applyThreadStateSnapshot(
      { type: 'PENDING', threadId: 9, threadFeedId: 1, visible: false },
      body,
      2,
    );
    expect(first.visible).toBe(true);
    expect(first.threadFeedId).toBe(1);
    const withContent = {
      ...first,
      lastMessageSeq: 5,
      lastMessageAt: 100,
      unreadCount: 4,
      lastMessagePreview: 'hello',
    };
    const blocked = applyThreadStateSnapshot(
      withContent,
      { ...body, blocked: true },
      3,
    );
    expect(blocked).toMatchObject({
      blocked: true,
      lastMessageSeq: 5,
      unreadCount: 4,
      lastMessagePreview: 'hello',
    });
    expect(applyThreadStateSnapshot(blocked, body, 2)).toBe(blocked);
  });
  it('changes the default reference on re-establishment while retaining a message-selected peer profile', () => {
    const body = threadStateEvent(2, 9, {
      profile: {
        account: 'bob',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
      },
    }).body;
    const first = applyThreadStateSnapshot(undefined, body, 2);
    if (first.type !== 'P2P') throw new Error('P2P expected');
    const messageProfile = {
      ...first,
      peerProfileMessageSeq: 5,
      peerUser: { ...first.peerUser, name: 'Message author', profileRev: 2 },
    };
    const reopened = applyThreadStateSnapshot(
      messageProfile,
      {
        ...body,
        establishedAt: 20,
        profile: { ...body.profile, profileRev: 3 },
      },
      4,
    );
    expect(reopened).toMatchObject({
      peerUser: { name: 'Message author', profileRev: 2 },
    });
  });
  it('does not rewind the group-meta display profile on an unrelated thread update', () => {
    const body = threadStateEvent(2, 9, {
      type: 'GROUP',
      profile: {
        account: '!group',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
      },
    }).body;
    const first = applyThreadStateSnapshot(undefined, body, 2);
    if (first.type !== 'GROUP') throw new Error('group expected');
    const latest = {
      ...first,
      group: { ...first.group, profileRev: 3, name: 'Current group' },
    };
    expect(
      applyThreadStateSnapshot(latest, { ...body, blocked: true }, 3),
    ).toMatchObject({
      group: { profileRev: 3, name: 'Current group' },
    });
  });
  it('preserves the roster and its cursor across read-only and re-establishment states', () => {
    const body = threadStateEvent(2, 9, {
      type: 'GROUP',
      profile: {
        account: '!group',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
      },
    }).body;
    const first = applyThreadStateSnapshot(undefined, body, 2);
    if (first.type !== 'GROUP') throw new Error('group expected');
    const latest = {
      ...first,
      group: { ...first.group, memberCount: 4, groupMetaFeedId: '20' },
    };
    expect(
      applyThreadStateSnapshot(latest, { ...body, establishedAt: 30 }, 6),
    ).toMatchObject({ group: { memberCount: 4, groupMetaFeedId: '20' } });
    expect(
      applyThreadStateSnapshot(
        latest,
        { ...body, conversationState: 'READ_ONLY' },
        5,
      ),
    ).toMatchObject({ group: { memberCount: 4, groupMetaFeedId: '20' } });
  });
});
