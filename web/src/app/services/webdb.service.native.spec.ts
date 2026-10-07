import 'fake-indexeddb/auto';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ConversationItem, Message } from './model';
import type { ProfileSnapshot } from './webdb.service';
import { WebdbService } from './webdb.service';

describe('WebdbService native SQLite routing', () => {
  type TauriWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: {
        invoke: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
  };
  const tauriWindow = (): TauriWindow => window as unknown as TauriWindow;

  let service: WebdbService;
  let calls: Array<{
    cmd: string;
    args?: Record<string, unknown>;
  }>;
  let responses: Map<string, unknown>;

  beforeEach(async () => {
    calls = [];
    responses = new Map();
    tauriWindow().__TAURI_INTERNALS__ = {};
    tauriWindow().__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          calls.push({ cmd, args });
          return responses.get(cmd) ?? null;
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), WebdbService],
    });
    service = TestBed.inject(WebdbService);
    await service.openForUser('42');
  });

  afterEach(async () => {
    await service.close();
    tauriWindow().__TAURI_INTERNALS__ = undefined;
    tauriWindow().__TAURI__ = undefined;
  });

  it('routes thread reads and writes to typed native commands with the active user id', async () => {
    const thread = {
      threadId: 9,
      publisherNamespaceId: 0,
      profileRev: 0,
      role: null,
      lastMessageAt: null,
      lastMessageSeq: null,
      muted: false,
      blocked: false,
      pinned: false,
      pinnedAt: null,
      conversationState: 'ACTIVE',
      lastReadSeq: null,
      unreadCount: 0,
      mentionUnread: [],
      lastMessagePreview: null,
      lastMessageSenderId: null,
      type: 'P2P',
      peerUser: {
        account: 'peer',
        name: '',
        avatar: '',
        bio: '',
        isGroup: false,
        domain: 'chat.test',
        namespaceId: 0,
        createdAt: 0,
        updatedAt: 0,
        isDeleted: false,
      },
    } as ConversationItem;
    responses.set('native_db_threads', [thread]);

    expect(await service.getThreads()).toEqual([thread]);
    await service.putThread(thread);
    await service.replaceThreads([thread]);
    await service.deleteThread(9);

    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_threads',
        args: { userId: 42 },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_put_thread',
        args: expect.objectContaining({
          userId: 42,
          threadId: 9,
          item: thread,
        }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_replace_threads',
        args: { userId: 42, items: [thread] },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_delete_thread',
        args: { userId: 42, threadId: 9 },
      }),
    );
  });

  it('does not allow a renderer to submit native state-feed pages', async () => {
    await expect(service.applyStateFeedPage([], 81, true)).rejects.toThrow('Rust SSE executor');
    expect(calls).not.toContainEqual(expect.objectContaining({ cmd: 'native_db_apply_state_feed_page' }));
  });

  it('routes revisioned profiles and meta state without falling back to IndexedDB', async () => {
    const profile: ProfileSnapshot = {
      name: 'Alice',
      account: 'alice',
      avatarDigest: null,
      bio: '',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 6,
    };
    responses.set('native_db_get_profile', profile);
    responses.set('native_db_get_meta', 12);

    expect(await service.getProfile({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 6 },
    })).toEqual(profile);
    await service.putSyncState('stateFeedId', 12);
    expect(await service.getSyncState('stateFeedId')).toBe(12);
  });

  it('queries a paginated group roster through native SQLite', async () => {
    const member = {
      threadId: 9,
      account: 'alice',
      domain: 'home.example',
      namespaceId: 12,
      profileRev: 6,
      profileBio: '',
      role: 'MEMBER',
      left: false,
      user: {
        account: 'alice',
        domain: 'home.example',
        namespaceId: 12,
        name: 'Alice',
        avatar: '/a.webp',
        bio: '',
        availability: 'AVAILABLE',
        profileRev: 6,
        createdAt: 0,
        updatedAt: 0,
      },
    };
    responses.set('native_db_query_group_members', [member]);

    expect(
      await service.queryGroupMembers({
        threadId: 9,
        afterIdentity: JSON.stringify([12, 'aaron']),
        take: 20,
        search: 'ali',
      }),
    ).toEqual([member]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_query_group_members',
        args: {
          userId: 42,
          threadId: 9,
          afterIdentity: JSON.stringify([12, 'aaron']),
          take: 20,
          search: 'ali',
        },
      }),
    );
  });

  it('reads a digest-selected native file as a Blob', async () => {
    const digest = 'a'.repeat(64);
    responses.set('native_db_get_profile_avatar', Array.from(new TextEncoder().encode('cached')));
    const blob = await service.getProfileAvatarBlob(digest);
    expect(blob?.type).toBe('image/webp');
    expect(await blob?.text()).toBe('cached');
    expect(calls).toContainEqual(expect.objectContaining({
      cmd: 'native_db_get_profile_avatar',
      args: expect.objectContaining({ userId: 42, digest }),
    }));
  });

  it('routes message cache maintenance, point reads, newest reads and thread cleanup to SQLite', async () => {
    const message = {
      threadId: 9,
      namespaceId: 0,
      seq: 3,
      createdAt: 100,
      updatedAt: 100,
      creator: { account: 'alice', namespaceId: 0 },
      profileRev: 2,
      localState: 'READY',
      isDeleted: false,
      content: 'hello',
      contentType: 'PURE_TEXT',
    } satisfies Message;
    responses.set('native_db_query_messages', [message]);
    responses.set('native_db_get_message', message);
    responses.set('native_db_newest_messages', [message]);

    expect(await service.queryCachedMessages(9, 'desc', 20, 10)).toEqual([
      message,
    ]);
    await service.putCachedMessages([message]);
    await service.putMessageHead(9, 8);
    expect(await service.getMessage(9, 3)).toEqual(message);
    expect(await service.getNewestMessages([9])).toEqual([message]);
    await service.deleteMessagesByThread(9);

    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_query_messages',
        args: {
          userId: 42,
          threadId: 9,
          anchor: 10,
          orderBy: 'desc',
          take: 20,
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_put_cached_messages',
        args: {
          userId: 42,
          messages: [message],
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_put_message_head',
        args: {
          userId: 42,
          threadId: 9,
          knownNewestSeq: 8,
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_get_message',
        args: { userId: 42, threadId: 9, seq: 3 },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_newest_messages',
        args: { userId: 42, threadIds: [9] },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_delete_messages_by_thread',
        args: { userId: 42, threadId: 9 },
      }),
    );
  });

  it('deletes the native user partition on logout cleanup', async () => {
    await service.closeAndDelete('42');
    expect(calls.at(-1)).toEqual({
      cmd: 'native_db_clear_user',
      args: { userId: 42 },
    });
  });

  it('counts cached messages in the active native user partition', async () => {
    responses.set('native_db_count_messages', 23);

    expect(await service.countCachedMessages()).toBe(23);
    expect(calls.at(-1)).toEqual({
      cmd: 'native_db_count_messages',
      args: { userId: 42 },
    });
  });
});
