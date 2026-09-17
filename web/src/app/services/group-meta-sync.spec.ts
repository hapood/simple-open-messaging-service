import { describe, expect, it, vi } from 'vitest';
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import { syncGroupMeta, type GroupMetaSyncStorage } from './group-meta-sync';
import { createGroupConversation } from './model';

function fixture() {
  const thread = createGroupConversation(12, {
    id: 21,
    account: 'room',
    domain: 'remote.test',
    namespaceId: 7,
    name: 'Room',
    avatar: '',
    description: '',
    profileRev: 1,
    ownerId: 1,
  });
  const state: LocalThreadAttention = {
    threadId: 12,
    localReadSeq: 0,
    server: {
      threadId: 12,
      threadFeedId: 1,
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      groupMetaFeedEndId: '3',
      joinRequestEndFeedId: 0,
      joinRequestReadFeedId: -1,
      groupInviteEndFeedId: 0,
      lastReadSeq: 0,
      unreadCount: 0,
      lastMentionSeq: null,
    },
  };
  const unresolved = {
    type: 'GROUP' as const,
    threadId: 12,
    account: 'room',
    domain: 'remote.test',
    namespaceId: 7,
    rev: 1,
  };
  const storage: GroupMetaSyncStorage = {
    getThreads: vi.fn(async () => [structuredClone(thread)]),
    getThreadStates: vi.fn(async () => [state]),
    getUnresolvedGroupMetaProfiles: vi.fn(async () => [unresolved]),
    beginGroupMetaRecovery: vi.fn(async (_threadId, through) => {
      thread.group.groupMetaFeedId = '0';
      thread.groupMetaRecoveryThrough = through;
    }),
    applyGroupMetaPage: vi.fn(async ({ page }) => {
      thread.group.groupMetaFeedId = page.scannedThrough;
      thread.groupMetaRecoveryThrough = page.hasMore ? '3' : null;
    }),
  };
  return { storage, thread, unresolved };
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
    const { storage, thread, unresolved } = fixture();
    const firstRun = vi
      .fn()
      .mockResolvedValueOnce(page('1', true))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(
      syncGroupMeta(storage, firstRun, vi.fn()),
    ).rejects.toMatchObject({ message: 'offline', threadIds: [12] });
    expect(thread.group.groupMetaFeedId).toBe('1');
    expect(thread.groupMetaRecoveryThrough).toBe('3');

    const request = vi
      .fn()
      .mockResolvedValueOnce(page('2', true))
      .mockResolvedValueOnce(page('3', false));
    const resolve = vi.fn(async () => false);
    await expect(syncGroupMeta(storage, request, resolve)).resolves.toEqual([
      12,
    ]);
    expect(request.mock.calls.map(([input]) => input.after)).toEqual([
      '1',
      '2',
    ]);
    expect(storage.beginGroupMetaRecovery).toHaveBeenCalledTimes(1);
    expect(thread.groupMetaRecoveryThrough).toBeNull();
    expect(resolve).toHaveBeenCalledWith(unresolved);
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

    await syncGroupMeta(
      storage,
      request,
      vi.fn(async () => false),
    );
    expect(storage.beginGroupMetaRecovery).toHaveBeenNthCalledWith(1, 12, '3');
    expect(storage.beginGroupMetaRecovery).toHaveBeenNthCalledWith(2, 12, '2');
    expect(request.mock.calls.map(([input]) => input.through)).toEqual([
      '3',
      '2',
      '3',
    ]);
  });

  it('reports a profile-only commit after the meta cursor is already current', async () => {
    const { storage, thread } = fixture();
    thread.group.groupMetaFeedId = '3';
    const request = vi.fn();

    await expect(
      syncGroupMeta(
        storage,
        request,
        vi.fn(async () => true),
      ),
    ).resolves.toEqual([12]);
    expect(request).not.toHaveBeenCalled();
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

    await syncGroupMeta(
      storage,
      request,
      vi.fn(async () => false),
    );
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
