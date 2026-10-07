import { describe, expect, it } from 'vitest';
import {
  advanceLocalAttentionRead,
  attentionCountRange,
  mergeThreadAttention,
  projectThreadAttention,
  type ThreadFeedSnapshot,
} from './thread-attention.js';

const snapshot: ThreadFeedSnapshot = {
  type: 'P2P',
  publisherNamespaceId: 0,
  profileAccount: 'peer',
  profileRev: 0,
  conversationState: 'ACTIVE',
  blocked: false,
  role: null,
  threadId: 7,
  threadFeedId: 1,
  messageEndSeq: 200,
  tombstoneEndSeq: 0,
  alias: null,
  groupMetaFeedEndId: null,
  joinRequestEndFeedId: 0,
  joinRequestReadFeedId: -1,
  groupInviteEndFeedId: 0,
  announcementReadFeedId: 0,
  lastReadSeq: 100,
  unreadCount: 8,
  lastMentionSeq: 104,
};
const initial = () =>
  mergeThreadAttention(undefined, snapshot);

describe('shared attention reconciliation', () => {
  it('rejects missing announcement coordinates', () => {
    const missing = { ...snapshot } as Record<string, unknown>;
    delete missing['announcementReadFeedId'];
    expect(() => mergeThreadAttention(undefined, missing as unknown as ThreadFeedSnapshot))
      .toThrow('announcement read position');
  });
  it('bounds corrections by the published message head, even when local history is newer', () => {
    const state = advanceLocalAttentionRead(initial(), 250);
    expect(attentionCountRange(state)).toEqual({
      threadId: 7,
      afterSeq: 100,
      throughSeq: 200,
    });
    const beyond = mergeThreadAttention(state, {
      ...snapshot,
      threadFeedId: 2,
      lastReadSeq: 240,
    });
    expect(attentionCountRange(beyond)).toEqual({
      threadId: 7,
      afterSeq: 200,
      throughSeq: 200,
    });
    expect(projectThreadAttention(beyond, 0)?.lastReadSeq).toBe(250);
  });
  it('initializes the local position only once', () => {
    const state = initial();
    expect(state).toEqual({
      ...snapshot,
      localReadSeq: 100,
    });
    expect(projectThreadAttention(state, 0)).toMatchObject({
      unreadCount: 8,
      hasUnreadMention: true,
    });
  });
  it('subtracts known message-slot count rather than seq distance', () => {
    const state = advanceLocalAttentionRead(initial(), 105);
    expect(attentionCountRange(state)).toEqual({
      threadId: 7,
      afterSeq: 100,
      throughSeq: 105,
    });
    expect(projectThreadAttention(state, 3)).toMatchObject({
      unreadCount: 5,
      hasUnreadMention: false,
    });
  });
  it('rebases each newer snapshot without double subtraction', () => {
    const state = advanceLocalAttentionRead(initial(), 105);
    const next = mergeThreadAttention(state, {
      ...snapshot,
      threadFeedId: 2,
      messageEndSeq: 200,
      tombstoneEndSeq: 0,
      alias: null,
      groupMetaFeedEndId: null,
      lastReadSeq: 103,
      unreadCount: 6,
    });
    expect(projectThreadAttention(state, 3)?.unreadCount).toBe(5);
    expect(projectThreadAttention(next, 1)?.unreadCount).toBe(5);
    expect(next.localReadSeq).toBe(105);
  });
  it('adds messages back when the remote read position is ahead, without overwriting local progress', () => {
    const state = advanceLocalAttentionRead(initial(), 105);
    const next = mergeThreadAttention(state, {
      ...snapshot,
      threadFeedId: 2,
      messageEndSeq: 200,
      tombstoneEndSeq: 0,
      alias: null,
      groupMetaFeedEndId: null,
      lastReadSeq: 110,
      unreadCount: 2,
      lastMentionSeq: 108,
    });
    expect(next.localReadSeq).toBe(105);
    expect(projectThreadAttention(next, 3)).toMatchObject({
      unreadCount: 5,
      hasUnreadMention: true,
    });
  });
  it('accepts a server rollback by feed ID, not by read seq', () => {
    const next = mergeThreadAttention(initial(), {
      ...snapshot,
      threadFeedId: 2,
      messageEndSeq: 200,
      tombstoneEndSeq: 0,
      alias: null,
      groupMetaFeedEndId: null,
      lastReadSeq: 95,
      unreadCount: 12,
    });
    expect(next.localReadSeq).toBe(100);
    expect(projectThreadAttention(next, 4)?.unreadCount).toBe(8);
  });
  it('ignores duplicate and older snapshots even with a greater read position', () => {
    const state = advanceLocalAttentionRead(initial(), 105);
    for (const threadFeedId of [1])
      expect(
        mergeThreadAttention(state, {
          ...snapshot,
          threadFeedId,
          lastReadSeq: 200,
        }),
      ).toBe(state);
    expect(state.localReadSeq).toBe(105);
  });
  it('requires a positive server feed ID before creating local state', () => {
    expect(() => mergeThreadAttention(undefined, { ...snapshot, threadFeedId: 0 }))
      .toThrow('feed ID');
  });
  it('advances local progress independently of the server position and never regresses it', () => {
    const state = mergeThreadAttention(initial(), {
      ...snapshot,
      threadFeedId: 2,
      messageEndSeq: 200,
      tombstoneEndSeq: 0,
      alias: null,
      groupMetaFeedEndId: null,
      lastReadSeq: 110,
    });
    const next = advanceLocalAttentionRead(state, 105);
    expect(next).toEqual({
      ...state,
      localReadSeq: 105,
    });
    expect(advanceLocalAttentionRead(next, 105)).toBe(next);
    expect(advanceLocalAttentionRead(next, 104)).toBe(next);
  });
  it('clamps only the lower bound and never applies the old 1000 cap', () => {
    const state = mergeThreadAttention(initial(), {
      ...snapshot,
      threadFeedId: 2,
      unreadCount: 1205,
    });
    expect(projectThreadAttention(state, 0)?.unreadCount).toBe(1205);
    expect(
      projectThreadAttention(advanceLocalAttentionRead(initial(), 120), 10)
        ?.unreadCount,
    ).toBe(0);
  });
  it('can recompute against changed local deletion facts without changing either position', () => {
    const state = advanceLocalAttentionRead(initial(), 105);
    expect(projectThreadAttention(state, 3)?.unreadCount).toBe(5);
    expect(projectThreadAttention(state, 2)?.unreadCount).toBe(6);
  });
  it('rejects cross-thread snapshots and invalid interval counts', () => {
    expect(() =>
      mergeThreadAttention(initial(), { ...snapshot, threadId: 8 }),
    ).toThrow('another thread');
    expect(() => projectThreadAttention(initial(), 1)).toThrow(
      'interval count',
    );
    expect(() => advanceLocalAttentionRead(initial(), -1)).toThrow(
      'local read position',
    );
  });
});
