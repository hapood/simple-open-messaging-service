import { describe, expect, it } from 'vitest';
import { createGroupConversation, createGroupMeta } from './model';
import {
  restoreThread,
  applyLocalThreadPatch,
  createStoredThread,
  type StoredThread,
} from './thread-record';
import { threadFeedSnapshot } from './thread-feed.test-helper';

const group = () =>
  createGroupConversation({
    threadId: 7,
    account: '!room',
    publisherNamespaceId: 4,
    profileRev: 3,
    profile: { name: 'Room', bio: 'About', avatarDigest: 'digest' },
    meta: {
      memberCount: 5,
      groupMetaFeedId: '8',
      announcementFeedId: '6',
      announcementText: 'Notice',
    },
  });

function row(): StoredThread {
  const { previews: _, ...state } = threadFeedSnapshot(7, {
    type: 'GROUP',
    publisherNamespaceId: 4,
    profileAccount: '!room',
    profileRev: 3,
    groupMetaFeedEndId: '8',
  });
  return createStoredThread({ ...state, localReadSeq: 0 });
}

describe('field-scoped local thread writes', () => {
  it('changes only pin fields and preserves concurrently committed feed facts', () => {
    const current = row();
    const next = applyLocalThreadPatch(current, {
      pinned: true,
      pinnedAt: 123,
    });
    expect(next).toEqual({ ...current, pinned: true, pinnedAt: 123 });
    expect(current.pinned).toBe(false);
  });

  it('does not roll back read acknowledgements or exceed the current join head', () => {
    const current = {
      ...row(),
      announcementReadFeedId: 8,
      joinRequestReadFeedId: 2,
      joinRequestEndFeedId: 5,
    };
    const next = applyLocalThreadPatch(current, {
      announcementReadFeedId: 3,
      joinRequestReadFeedId: 20,
    });
    expect(next).toEqual({ ...current, joinRequestReadFeedId: 5 });
  });

  it('preserves disabled manager attention when a stale acknowledgement arrives', () => {
    const current = { ...row(), joinRequestReadFeedId: -1 };
    expect(
      applyLocalThreadPatch(current, { joinRequestReadFeedId: 3 }),
    ).toEqual(current);
  });
});

describe('separate thread and group meta records', () => {
  it('initializes only local columns alongside the supplied feed facts', () => {
    const { previews: _, ...state } = threadFeedSnapshot(7, {
      profileAccount: 'peer',
      publisherNamespaceId: 0,
      profileRev: 1,
    });
    expect(createStoredThread({ ...state, localReadSeq: 0 })).toEqual({
      ...state,
      localReadSeq: 0,
      lastMessageAt: null,
      muted: false,
      pinned: false,
      pinnedAt: null,
      lastMessagePreview: null,
      lastMessageSenderAccount: null,
      lastMessageSenderNamespaceId: null,
      projectedUnreadCount: 0,
      mentionMe: false,
      mentionAll: false,
    });
  });

  it('initializes Meta without constructing a conversation', () => {
    expect(createGroupMeta()).toEqual({
      memberCount: 0,
      groupMetaFeedId: '0',
      announcementFeedId: null,
      announcementText: null,
      recoveryThrough: null,
      recoveryAnnouncementFeedId: null,
      recoveryAnnouncementText: null,
    });
  });

  it('joins identity, the selected profile group, and meta without copying identity into slots', () => {
    const item = group();
    const restored = restoreThread(
      row(),
      { profile: item.profile },
      { threadId: item.threadId, ...item.meta },
    );
    expect(restored.account).toBe('!room');
    expect(restored.publisherNamespaceId).toBe(4);
    expect(restored.profileRev).toBe(3);
    expect(restored.profile).toEqual(item.profile);
    if (restored.type !== 'GROUP') throw new Error('group expected');
    expect(restored.meta).toEqual(item.meta);
  });

  it('rejects a missing meta row rather than fabricating a recovered group', () => {
    expect(() => restoreThread(row(), {})).toThrow('missing its meta row');
  });
});
