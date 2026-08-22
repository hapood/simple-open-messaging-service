import 'fake-indexeddb/auto';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ConversationItem, Message } from './model';
import type { ProfileRecord } from './webdb.service';
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
    const thread = { threadId: 9, type: 'P2P' } as ConversationItem;
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

  it('sends the complete delta and revision through one atomic native command', async () => {
    const item = { threadId: 7, type: 'GROUP' } as ConversationItem;
    const delta = [
      { threadId: 3, direction: 'DELETE' as const },
      { threadId: 7, direction: 'ADD' as const, item },
    ];

    await service.applyThreadDelta(delta, 81);

    expect(calls.at(-1)).toEqual({
      cmd: 'native_db_apply_thread_delta',
      args: { userId: 42, revision: 81, delta },
    });
  });

  it('sends missed-summary rows and cursor through one atomic native command', async () => {
    const items = [{ threadId: 7, type: 'GROUP' }] as ConversationItem[];
    const cursor = 9;

    await service.applyCatchUp(items, cursor);

    expect(calls.at(-1)).toEqual({
      cmd: 'native_db_apply_catch_up',
      args: { userId: 42, items, cursor },
    });
  });

  it('routes revisioned profiles and meta state without falling back to IndexedDB', async () => {
    const profile: ProfileRecord = {
      identity: 'u8',
      id: 8,
      kind: 'user',
      name: 'Alice',
      account: 'alice',
      avatar: '/a.webp',
      bio: '',
      domain: '',
      profileRev: 6,
    };
    responses.set('native_db_put_profile', true);
    responses.set('native_db_get_profile', profile);
    responses.set('native_db_get_meta', 12);

    expect(await service.putProfile(profile)).toBe(true);
    expect(await service.getProfile('u8')).toEqual(profile);
    await service.putMeta('stateRevision', 12);
    expect(await service.getMeta('stateRevision')).toBe(12);

    expect(
      calls.find((call) => call.cmd === 'native_db_put_profile')?.args,
    ).toEqual(expect.objectContaining({ userId: 42, profileRev: 6, profile }));
  });

  it('reads source-scoped member profiles through native SQLite commands', async () => {
    const profile = {
      threadId: 9,
      userId: 8,
      sourcePeerDomain: 'group.example',
      memberAccount: 'alice',
      memberDomain: 'home.example',
      displayName: 'Alice',
      avatar: '/a.webp',
      profileRevision: 6,
    };
    responses.set('native_db_get_member_profile', profile);
    responses.set('native_db_list_member_profiles', [profile]);

    expect(await service.getMemberProfile(9, 8)).toEqual(profile);
    expect(await service.listMemberProfiles(9)).toEqual([profile]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_get_member_profile',
        args: { userId: 42, threadId: 9, memberUserId: 8 },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_list_member_profiles',
        args: { userId: 42, threadId: 9 },
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

  it('routes message windows, writes, point reads, newest reads and thread cleanup to SQLite', async () => {
    const message = {
      threadId: 9,
      seq: 3,
      createdAt: 100,
      updatedAt: 100,
      creator: 42,
      isDeleted: false,
      content: 'hello',
      contentType: 'PURE_TEXT',
    } satisfies Message;
    responses.set('native_db_query_messages', [message]);
    responses.set('native_db_get_message', message);
    responses.set('native_db_newest_messages', [message]);
    responses.set('native_db_message_section', {
      threadId: 9,
      left: 3,
      right: 8,
    });
    responses.set('native_db_message_coverage', {
      threadId: 9,
      knownNewestSeq: 8,
      coveredTail: { left: 3, right: 8 },
    });

    expect(await service.queryCachedMessages(9, 'desc', 20, 10)).toEqual([
      message,
    ]);
    await service.putMessages([message]);
    await service.putMessages([message], { threadId: 9, left: 3, right: 8 });
    expect(await service.getMessage(9, 3)).toEqual(message);
    expect(await service.getMessageSection(9, 5)).toEqual({
      left: 3,
      right: 8,
    });
    expect(await service.getMessageCoverage(9)).toEqual({
      threadId: 9,
      knownNewestSeq: 8,
      coveredTail: { left: 3, right: 8 },
    });
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
        cmd: 'native_db_put_messages',
        args: {
          userId: 42,
          messages: [message],
          confirmedSection: null,
          knownNewestSeq: null,
          coverageThreadId: null,
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_put_messages',
        args: {
          userId: 42,
          messages: [message],
          confirmedSection: { threadId: 9, left: 3, right: 8 },
          knownNewestSeq: null,
          coverageThreadId: null,
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: 'native_db_message_section',
        args: { userId: 42, threadId: 9, seq: 5 },
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
