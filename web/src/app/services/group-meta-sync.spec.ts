import { describe, expect, it, vi } from 'vitest';
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import {
  syncGroupMetaThread,
  type GroupMetaSyncStorage,
} from './group-meta-sync';
import { createGroupConversation } from './model';
import { threadStructure } from './thread-feed.test-helper';

function fixture() {
  const thread = createGroupConversation({
    threadId: 12,
    account: 'room',
    publisherNamespaceId: 7,
    profileRev: 1,
    profile: { name: 'Room', bio: '', avatarDigest: null },
  });
  const state: LocalThreadAttention = {
    ...threadStructure(12, {
      type: 'GROUP',
      publisherNamespaceId: 7,
      profileAccount: 'room',
      profileRev: 1,
    }),
    threadId: 12,
    localReadSeq: 0,
    threadFeedId: 1,
    messageEndSeq: 0,
    tombstoneEndSeq: 0,
    alias: null,
    profileRev: 1,
    groupMetaFeedEndId: '3',
    joinRequestEndFeedId: 0,
    joinRequestReadFeedId: -1,
    groupInviteEndFeedId: 0,
    announcementReadFeedId: 0,
    lastReadSeq: 0,
    unreadCount: 0,
    lastMentionSeq: null,
  };
  const storage: GroupMetaSyncStorage = {
    getThreads: vi.fn(async () => [structuredClone(thread)]),
    getThreadStates: vi.fn(async () => [state]),
    beginGroupMetaRecovery: vi.fn(async (_threadId, through) => {
      thread.meta.groupMetaFeedId = '0';
      thread.meta.recoveryThrough = through;
    }),
    applyGroupMetaPage: vi.fn(async ({ page }) => {
      thread.meta.groupMetaFeedId = page.scannedThrough;
      thread.meta.recoveryThrough = page.hasMore ? '3' : null;
      return {
        threadId: thread.threadId,
        memberCount: thread.meta.memberCount,
        groupMetaFeedId: page.scannedThrough,
        announcementFeedId: null,
        announcementCreatedAt: null,
        announcementOriginCreatedAt: null,
        announcementText: null,
        groupMetaRecoveryThrough: thread.meta.recoveryThrough,
      };
    }),
  };
  return { storage, thread, state };
}

function page(scannedThrough: string, hasMore: boolean) {
  return {
    code: 0,
    data: {
      account: 'room',
      mode: 'full',
      items: [],
      scannedThrough,
      groupMetaFeedEndId: '3',
      hasMore,
    },
  };
}

describe('Group Meta per-thread drain', () => {
  it('reads the target from durable state and commits each full-recovery page', async () => {
    const { storage, thread } = fixture();
    const firstRun = vi
      .fn()
      .mockResolvedValueOnce(page('1', true))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(
      syncGroupMetaThread(storage, firstRun, 12),
    ).rejects.toMatchObject({
      message: 'group room (namespace 7, thread 12): offline',
      threadIds: [12],
      patches: [{ threadId: 12, groupMetaFeedId: '1' }],
    });
    expect(thread.meta.groupMetaFeedId).toBe('1');
    expect(thread.meta.recoveryThrough).toBe('3');

    const request = vi
      .fn()
      .mockResolvedValueOnce(page('2', true))
      .mockResolvedValueOnce(page('3', false));
    await expect(
      syncGroupMetaThread(storage, request, 12),
    ).resolves.toMatchObject({ threadIds: [12] });
    expect(request.mock.calls.map(([input]) => input.after)).toEqual([
      '1',
      '2',
    ]);
    expect(storage.beginGroupMetaRecovery).toHaveBeenCalledTimes(1);
    expect(thread.meta.recoveryThrough).toBeNull();
  });

  it('opens one replacement full window when the server rejects the cursor', async () => {
    const { storage } = fixture();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 30006,
        data: { resumeAfter: '0', resumeBefore: '3' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          ...page('2', false).data,
          groupMetaFeedEndId: '2',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          ...page('3', false).data,
          mode: 'delta',
        },
      });

    await syncGroupMetaThread(storage, request, 12);
    expect(storage.beginGroupMetaRecovery).toHaveBeenNthCalledWith(1, 12, '3');
    expect(storage.beginGroupMetaRecovery).toHaveBeenNthCalledWith(2, 12, '2');
    expect(request.mock.calls.map(([input]) => input.through)).toEqual([
      '3',
      '2',
      '3',
    ]);
  });

  it('does no work when the fact cursor is already current', async () => {
    const { storage, thread } = fixture();
    thread.meta.groupMetaFeedId = '3';
    const request = vi.fn();
    await expect(syncGroupMetaThread(storage, request, 12)).resolves.toEqual({
      threadIds: [],
      patches: [],
    });
    expect(request).not.toHaveBeenCalled();
    expect(storage.applyGroupMetaPage).not.toHaveBeenCalled();
  });

  it('commits group profile facts without resolving presentation', async () => {
    const { storage, thread } = fixture();
    thread.profile.name = '';
    thread.profile.bio = '';
    thread.meta.groupMetaFeedId = '0';
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          account: 'room',
          mode: 'full',
          items: [
            {
              feedId: '1',
              createdAt: 1_000,
              originCreatedAt: null,
              operation: 'GROUP_PROFILE',
              body: { account: 'room', namespaceId: 7, profileRev: 1 },
            },
          ],
          scannedThrough: '1',
          groupMetaFeedEndId: '3',
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          account: 'room',
          mode: 'full',
          items: [],
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
        },
      });
    await expect(
      syncGroupMetaThread(storage, request, 12),
    ).resolves.toMatchObject({ threadIds: [12] });
    expect(thread.profile.name).toBe('');
    expect(thread.profile.bio).toBe('');
    expect(thread.meta.groupMetaFeedId).toBe('3');
  });

  it('continues with delta after finishing an older persisted recovery window', async () => {
    const { storage, thread } = fixture();
    thread.meta.groupMetaFeedId = '1';
    thread.meta.recoveryThrough = '2';
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          ...page('2', false).data,
          groupMetaFeedEndId: '3',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          ...page('3', false).data,
          mode: 'delta',
        },
      });

    await syncGroupMetaThread(storage, request, 12);
    expect(
      request.mock.calls.map(([input]) => [
        input.mode,
        input.after,
        input.through,
      ]),
    ).toEqual([
      ['full', '1', '2'],
      ['delta', '2', '3'],
    ]);
  });

  it('surfaces the business code of a rejected page', async () => {
    const { storage } = fixture();
    const request = vi.fn().mockResolvedValueOnce({ code: 30001 });
    await expect(syncGroupMetaThread(storage, request, 12)).rejects.toThrow(
      'group-meta pull failed (code 30001)',
    );
  });
});

describe('Group Meta per-thread fact delivery', () => {
  it('keeps the latest committed patch when a later fact page fails', async () => {
    const { storage, thread } = fixture();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page('1', true))
      .mockResolvedValueOnce(page('2', true))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(
      syncGroupMetaThread(storage, request, 12),
    ).rejects.toMatchObject({
      threadIds: [12],
      patches: [
        { threadId: 12, groupMetaFeedId: '2', groupMetaRecoveryThrough: '3' },
      ],
      message: 'group room (namespace 7, thread 12): offline',
    });
    expect(thread.meta.groupMetaFeedId).toBe('2');
    const resumed = vi.fn().mockResolvedValueOnce(page('3', false));
    await expect(
      syncGroupMetaThread(storage, resumed, 12),
    ).resolves.toMatchObject({
      threadIds: [12],
      patches: [{ groupMetaFeedId: '3', groupMetaRecoveryThrough: null }],
    });
    expect(resumed.mock.calls[0][0].after).toBe('2');
  });

  it('delivers a committed page when the open-thread guard stops the drain', async () => {
    const { storage } = fixture();
    let active = true;
    const request = vi.fn(async () => {
      active = false;
      return page('1', true);
    });
    await expect(
      syncGroupMetaThread(storage, request, 12, () => active),
    ).resolves.toMatchObject({
      threadIds: [12],
      patches: [{ groupMetaFeedId: '1' }],
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
