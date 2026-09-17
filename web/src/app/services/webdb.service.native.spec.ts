import 'fake-indexeddb/auto';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ConversationItem, Message } from './model';
import type { ProfileWriteRecord } from './webdb.service';
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

  it('delegates the complete thread feed sync to Rust in one invocation', async () => {
    const result = { cursor: 12, states: [] };
    responses.set('native_thread_feed_sync', result);
    expect(await service.syncThreadFeed(12, 3)).toEqual(result);
    expect(calls.at(-1)).toEqual({
      cmd: 'native_thread_feed_sync',
      args: { userId: 42, target: 12, after: 3 },
    });
  });

  it('routes thread reads and writes to typed native commands with the active user id', async () => {
    const thread = {
      threadId: 9,
      authorityNamespaceId: 0,
      type: 'P2P',
      peerUser: { account: 'peer', domain: 'local', namespaceId: 0 },
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

  it('sends a state-feed page through the native background command', async () => {
    const items = [
      {
        feedId: 81,
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        eventType: 'PROFILE' as const,
        subjectAccount: '' as const,
        subjectDomain: 'local' as const,
        body: { displayName: 'Alice', avatar: '', bio: '', profileRev: 2 },
      },
    ];
    await service.applyStateFeedPage(items, 81, true);

    expect(calls.at(-1)).toEqual({
      cmd: 'native_db_apply_state_feed_page',
      args: {
        userId: 42,
        feedId: 81,
        items,
        resetProjection: true,
      },
    });
  });

  it('routes revisioned profiles and meta state without falling back to IndexedDB', async () => {
    const profile: ProfileWriteRecord = {
      identity: 'u8',
      id: 8,
      kind: 'user',
      name: 'Alice',
      account: 'alice',
      avatar: '/a.webp',
      bio: '',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      profileRev: 6,
    };
    responses.set('native_db_put_profile', true);
    responses.set('native_db_get_profile', profile);
    responses.set('native_db_get_meta', 12);

    expect(await service.putProfile(profile)).toBe(true);
    expect(await service.getProfile(profile)).toEqual(profile);
    await service.putMeta('stateFeedId', 12);
    expect(await service.getMeta('stateFeedId')).toBe(12);

    expect(
      calls.find((call) => call.cmd === 'native_db_put_profile')?.args,
    ).toEqual(expect.objectContaining({ userId: 42, profile }));
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
        afterIdentity: JSON.stringify([12, 'home.example', 'aaron']),
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
          afterIdentity: JSON.stringify([12, 'home.example', 'aaron']),
          take: 20,
          search: 'ali',
        },
      }),
    );
  });

  it('converts avatar blobs at the IPC boundary and reconstructs a Blob on read', async () => {
    await service.putAvatar({
      identity: 'u8',
      path: '/a.webp',
      blob: new Blob(['avatar'], { type: 'image/webp' }),
      lastRender: 10,
    });
    const put = calls.find((call) => call.cmd === 'native_db_put_avatar');
    expect(put?.args).toEqual(
      expect.objectContaining({
        userId: 42,
        identity: 'u8',
        path: '/a.webp',
        mime: 'image/webp',
        data: Array.from(new TextEncoder().encode('avatar')),
      }),
    );

    responses.set('native_db_get_avatar', {
      identity: 'u8',
      path: '/a.webp',
      mime: 'image/webp',
      data: Array.from(new TextEncoder().encode('cached')),
      lastRender: 11,
    });
    const avatar = await service.getAvatar('u8');
    expect(avatar?.blob.type).toBe('image/webp');
    expect(await avatar?.blob.text()).toBe('cached');
  });

  it('routes message cache maintenance, point reads, newest reads and thread cleanup to SQLite', async () => {
    const message = {
      threadId: 9,
      seq: 3,
      createdAt: 100,
      updatedAt: 100,
      creator: { account: 'alice', domain: 'local', namespaceId: 0 },
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
