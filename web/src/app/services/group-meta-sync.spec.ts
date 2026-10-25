import { describe, expect, it, vi } from 'vitest';
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import {
  syncGroupMeta,
  syncGroupMetaThread,
  type GroupMetaSyncStorage,
} from './group-meta-sync';
import { createGroupConversation } from './model';
import { threadStructure } from './thread-feed.test-helper';

function fixture() {
  const thread = createGroupConversation(12, {
    id: 21,
    account: 'room',
    namespaceId: 7,
    name: 'Room',
    description: '',
    profileRev: 1,
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
      thread.group.groupMetaFeedId = '0';
      thread.groupMetaRecoveryThrough = through;
    }),
    applyGroupMetaPage: vi.fn(async ({ page }) => {
      thread.group.groupMetaFeedId = page.scannedThrough;
      thread.groupMetaRecoveryThrough = page.hasMore ? '3' : null;
      return {
        threadId: thread.threadId,
        memberCount: thread.group.memberCount,
        groupMetaFeedId: page.scannedThrough,
        announcement: null,
        groupMetaRecoveryThrough: thread.groupMetaRecoveryThrough,
        groupMetaRecoveryAnnouncement: null,
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

describe('Group Meta background synchronization', () => {
  it('commits each full-recovery page and resumes from the durable cursor', async () => {
    const { storage, thread } = fixture();
    const firstRun = vi
      .fn()
      .mockResolvedValueOnce(page('1', true))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(syncGroupMeta(storage, firstRun)).rejects.toMatchObject({
      message: 'group room (namespace 7, thread 12): offline',
      threadIds: [12],
      patches: [{ threadId: 12, groupMetaFeedId: '1' }],
    });
    expect(thread.group.groupMetaFeedId).toBe('1');
    expect(thread.groupMetaRecoveryThrough).toBe('3');

    const request = vi
      .fn()
      .mockResolvedValueOnce(page('2', true))
      .mockResolvedValueOnce(page('3', false));
    await expect(syncGroupMeta(storage, request)).resolves.toEqual([12]);
    expect(request.mock.calls.map(([input]) => input.after)).toEqual([
      '1',
      '2',
    ]);
    expect(storage.beginGroupMetaRecovery).toHaveBeenCalledTimes(1);
    expect(thread.groupMetaRecoveryThrough).toBeNull();
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

    await syncGroupMeta(storage, request);
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
    thread.group.groupMetaFeedId = '3';
    const request = vi.fn();
    await expect(syncGroupMeta(storage, request)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(storage.applyGroupMetaPage).not.toHaveBeenCalled();
  });

  it('commits group profile facts without resolving presentation', async () => {
    const { storage, thread } = fixture();
    thread.group.name = '';
    thread.group.description = '';
    thread.group.groupMetaFeedId = '0';
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
    await expect(syncGroupMeta(storage, request)).resolves.toEqual([12]);
    expect(thread.group.name).toBe('');
    expect(thread.group.description).toBe('');
    expect(thread.group.groupMetaFeedId).toBe('3');
  });

  it('continues with delta after finishing an older persisted recovery window', async () => {
    const { storage, thread } = fixture();
    thread.group.groupMetaFeedId = '1';
    thread.groupMetaRecoveryThrough = '2';
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

    await syncGroupMeta(storage, request);
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
      syncGroupMetaThread(storage, request, 12, '3'),
    ).rejects.toMatchObject({
      threadIds: [12],
      patches: [
        { threadId: 12, groupMetaFeedId: '2', groupMetaRecoveryThrough: '3' },
      ],
      message: 'group room (namespace 7, thread 12): offline',
    });
    expect(thread.group.groupMetaFeedId).toBe('2');
    const resumed = vi.fn().mockResolvedValueOnce(page('3', false));
    await expect(
      syncGroupMetaThread(storage, resumed, 12, '3'),
    ).resolves.toMatchObject({
      threadIds: [12],
      patches: [{ groupMetaFeedId: '3', groupMetaRecoveryThrough: null }],
    });
    expect(resumed.mock.calls[0][0].after).toBe('2');
  });

  it.each(['page', 'recovery', 'error'] as const)(
    'discards an in-flight %s after membership permission is revoked',
    async (response) => {
      const { storage } = fixture();
      let permitted = true;
      const request = vi.fn(async () => {
        permitted = false;
        if (response === 'error') throw new Error('forbidden');
        return response === 'page'
          ? page('1', true)
          : {
              code: 30006,
              data: { resumeAfter: '0', resumeBefore: '4' },
            };
      });
      await expect(
        syncGroupMetaThread(
          storage,
          request,
          12,
          '3',
          () => true,
          () => permitted,
        ),
      ).resolves.toEqual({ threadIds: [12], patches: [] });
      expect(storage.applyGroupMetaPage).not.toHaveBeenCalled();
      expect(storage.beginGroupMetaRecovery).toHaveBeenCalledTimes(1);
      expect(storage.getThreads).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not clear cached metadata when permission was already revoked', async () => {
    const { storage } = fixture();
    const request = vi.fn();
    await expect(
      syncGroupMetaThread(
        storage,
        request,
        12,
        '3',
        () => true,
        () => false,
      ),
    ).resolves.toEqual({ threadIds: [], patches: [] });
    expect(storage.beginGroupMetaRecovery).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('delivers a committed page when the open-thread guard stops the drain', async () => {
    const { storage } = fixture();
    let active = true;
    const request = vi.fn(async () => {
      active = false;
      return page('1', true);
    });
    await expect(
      syncGroupMetaThread(storage, request, 12, '3', () => active),
    ).resolves.toMatchObject({
      threadIds: [12],
      patches: [{ groupMetaFeedId: '1' }],
    });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('Group Meta failure isolation', () => {
  it('continues past a failing group instead of starving later groups', async () => {
    const { storage, thread, state } = fixture();
    const healthy = structuredClone(thread);
    healthy.threadId = 13;
    healthy.group = { ...thread.group };
    (storage.getThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      thread,
      healthy,
    ]);
    (storage.getThreadStates as ReturnType<typeof vi.fn>).mockResolvedValue([
      structuredClone(state),
      { ...structuredClone(state), threadId: 13 },
    ]);
    // The fixture closures write to the original thread; route by threadId.
    (
      storage.beginGroupMetaRecovery as ReturnType<typeof vi.fn>
    ).mockImplementation(async (threadId: number, through: string) => {
      const target = threadId === 13 ? healthy : thread;
      target.group.groupMetaFeedId = '0';
      target.groupMetaRecoveryThrough = through;
    });
    (storage.applyGroupMetaPage as ReturnType<typeof vi.fn>).mockImplementation(
      async ({
        threadId,
        page,
      }: {
        threadId: number;
        page: { scannedThrough: string; hasMore: boolean };
      }) => {
        const target = threadId === 13 ? healthy : thread;
        target.group.groupMetaFeedId = page.scannedThrough;
        target.groupMetaRecoveryThrough = page.hasMore ? '3' : null;
      },
    );
    // First group's request fails; the second group must still drain.
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
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
    await expect(syncGroupMeta(storage, request)).rejects.toThrow(
      'group room (namespace 7, thread 12): offline',
    );
    expect(healthy.group.groupMetaFeedId).toBe('3');
  });

  it('surfaces the business code of a rejected page', async () => {
    const { storage } = fixture();
    const request = vi.fn().mockResolvedValueOnce({ code: 30001 });
    await expect(syncGroupMeta(storage, request)).rejects.toThrow(
      'group-meta pull failed (code 30001)',
    );
  });
});
