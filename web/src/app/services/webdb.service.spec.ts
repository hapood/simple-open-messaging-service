import { TestBed } from '@angular/core/testing';
import { SessionLifecycleService } from './session-lifecycle.service';
import { provideZonelessChangeDetection } from '@angular/core';
import { deleteDB, openDB } from 'idb';
import { createMessageDeletionMarker } from '../../../../shared/message-tomb';
import {
  advanceLocalAttentionRead,
  attentionCountRange,
  attentionSnapshot,
  mergeThreadAttention,
  projectThreadAttention,
} from '../../../../shared/thread-attention';
import { threadFeedSnapshot, threadStructure } from './thread-feed.test-helper';
import type { Message } from './model';
import type { ClientStateFeedItem } from './user.service';
import {
  LocalCacheVersionMismatchError,
  LocalCacheUnavailableError,
  STATE_FEED_WORKER_FACTORY,
  WebdbService,
  provideWebdbService,
} from './webdb.service';
import { WebdbStorage } from './webdb-storage';
import {
  createSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session/session-identity';

const peerProfile = {
  account: 'peer',
  domain: 'chat.example.test',
  namespaceId: 0,
  profileRev: 0,
};

async function seedGroupFeed(
  webdb: WebdbService,
  publisherNamespaceId = 0,
): Promise<void> {
  await webdb.mergeThreadStates([
    threadFeedSnapshot(9, {
      type: 'GROUP',
      role: 'OWNER',
      profileAccount: '!team',
      publisherNamespaceId,
      profileRev: 0,
    }),
  ]);
}

describe('WebdbService', () => {
  describe('IDB-backed storage (browser IndexedDB)', () => {
    let webdb: WebdbService;
    let session: SessionCacheDescriptor;

    async function groupMeta() {
      const restored = (await webdb.getThreads())[0];
      if (restored?.type !== 'GROUP') throw new Error('group expected');
      return restored.meta;
    }

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideWebdbService(),
          { provide: STATE_FEED_WORKER_FACTORY, useValue: () => null },
        ],
      });
      webdb = TestBed.inject(WebdbService);
      session = createSessionCacheDescriptor();
      webdb.bindSessionCache(session);
    });

    afterEach(async () => {
      try {
        await webdb.closeAndDelete('1');
      } catch {
        /* already closed */
      }
    });

    it('rejects cache opens without a login-session binding', async () => {
      const unbound = new WebdbStorage();
      await expect(unbound.openForUser('1')).rejects.toThrow(
        'no login-session cache is bound',
      );
      await unbound.close();
    });

    it('binds a transferable port only after the database worker acknowledges the account', async () => {
      await webdb.close();
      const worker = {
        onmessage: null,
        onerror: null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
      } as unknown as Worker;
      const workerStorage = new WebdbStorage(
        () => worker,
        new SessionLifecycleService(),
      );
      workerStorage.bindSessionCache(session);
      await workerStorage.openForUser('1');
      let port: MessagePort | null = null;
      let workerPort: MessagePort | undefined;
      try {
        const binding = workerStorage.createThreadFeedPort();
        const [request, transfer] = vi.mocked(worker.postMessage).mock
          .calls[0] as unknown as [
          { id: number; port: MessagePort },
          Transferable[],
        ];
        workerPort = request.port;
        expect(request).toMatchObject({
          type: 'bind-thread-feed',
          userId: '1',
        });
        expect(transfer).toEqual([workerPort]);
        worker.onmessage!.call(worker, {
          data: { id: request.id, ok: true },
        } as MessageEvent);
        port = await binding;
        expect(port).not.toBeNull();
      } finally {
        port?.close();
        workerPort?.close();
        await workerStorage.closeAndDelete('1');
      }
    });

    it('creates a conversation from the complete feed snapshot without advancing the cursor', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadId: 7,
        threadFeedId: 10,
        messageEndSeq: 200,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 100,
        unreadCount: 8,
        lastMentionSeq: 104,
        announcementReadFeedId: 0,
        previews: [],
      };
      await webdb.mergeThreadStates([snapshot]);
      expect(await webdb.getThreadStates()).toEqual([
        { ...snapshot, localReadSeq: 100 },
      ]);
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({ threadId: 7, type: 'P2P', threadFeedId: 10 }),
      ]);
      expect((await webdb.readAccountState()).threadFeedCursor).toBeNull();
    });

    it('projects a counterpart-only thread revision and preserves it across stale list writes', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        {
          ...threadStructure(7, {
            profileAccount: peerProfile.account,
            publisherNamespaceId: peerProfile.namespaceId,
            profileRev: 2,
          }),
          threadId: 7,
          threadFeedId: 10,
          messageEndSeq: 6,
          alias: null,
          profileRev: 2,
          joinRequestEndFeedId: 0,
          joinRequestReadFeedId: -1,
          groupInviteEndFeedId: 0,
          lastReadSeq: 0,
          unreadCount: 0,
          lastMentionSeq: null,
          previews: [],
          announcementReadFeedId: 0,
        },
      ]);
      expect((await webdb.getThreads())[0]?.profileRev).toBe(2);
      await webdb.patchThread(7, { muted: true });
      const stored = (await webdb.getThreads())[0];
      expect(stored?.profileRev).toBe(2);
      if (stored?.type !== 'P2P') throw new Error('expected P2P thread');
      expect('profileRev' in stored.profile).toBe(false);
    });

    it('preserves optimistic progress across snapshots and accepts remote rollback by feed ID', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadId: 7,
        threadFeedId: 10,
        messageEndSeq: 200,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 110,
        announcementReadFeedId: 0,
        unreadCount: 2,
        lastMentionSeq: null,
        previews: [],
      };
      await webdb.mergeThreadStates(
        [{ ...snapshot, threadFeedId: 8, lastReadSeq: 100 }],
        8,
      );
      await webdb.advanceThreadRead(7, 105);
      await webdb.mergeThreadStates([snapshot], 10);
      await webdb.mergeThreadStates([
        { ...snapshot, threadFeedId: 9, lastReadSeq: 120 },
      ]);
      await webdb.mergeThreadStates([{ ...snapshot, lastReadSeq: 130 }]);
      expect((await webdb.getThreadStates())[0]).toEqual({
        ...snapshot,
        localReadSeq: 110,
      });
      const rolledBack = { ...snapshot, threadFeedId: 11, lastReadSeq: 95 };
      await webdb.mergeThreadStates([rolledBack]);
      expect(await webdb.advanceThreadRead(7, 104)).toEqual({
        ...rolledBack,
        localReadSeq: 110,
      });
      expect((await webdb.readAccountState()).threadFeedCursor).toBe(10);
    });

    it('serializes concurrent local progress and snapshots without losing either', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadId: 7,
        threadFeedId: 1,
        messageEndSeq: 200,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 100,
        unreadCount: 8,
        lastMentionSeq: null,
        announcementReadFeedId: 0,
        previews: [],
      };
      await webdb.mergeThreadStates([snapshot], 1);
      const newer = { ...snapshot, threadFeedId: 2, lastReadSeq: 101 };
      await Promise.all([
        webdb.advanceThreadRead(7, 105),
        webdb.mergeThreadStates([newer], 2),
        webdb.advanceThreadRead(7, 110),
      ]);
      expect(await webdb.getThreadStates()).toEqual([
        { ...newer, localReadSeq: 110 },
      ]);
    });

    it('keeps attention across message-only resets but clears it on account cache deletion', async () => {
      await webdb.openForUser('1');
      const snapshot = threadFeedSnapshot(7, {
        profileAccount: peerProfile.account,
        publisherNamespaceId: peerProfile.namespaceId,
        profileRev: peerProfile.profileRev,
        lastReadSeq: 100,
      });
      await webdb.mergeThreadStates([snapshot], 1);
      await webdb.advanceThreadRead(7, 105);
      await webdb.recreateMessageCache();
      expect(await webdb.getThreadStates()).toEqual([
        { ...snapshot, localReadSeq: 105 },
      ]);
      await webdb.closeAndDelete('1');
      await webdb.openForUser('1');
      expect(await webdb.getThreadStates()).toEqual([]);
    });

    it('advances the cursor on empty pages without regressing it', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([], 20);
      await webdb.mergeThreadStates([], 10);
      expect((await webdb.readAccountState()).threadFeedCursor).toBe(20);
    });

    it('rejects an invalid batch before writing any snapshot or cursor', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadId: 7,
        threadFeedId: 1,
        messageEndSeq: 200,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 100,
        unreadCount: 8,
        lastMentionSeq: null,
        announcementReadFeedId: 0,
        previews: [],
      };
      await expect(
        webdb.mergeThreadStates(
          [snapshot, { ...snapshot, threadId: 8, unreadCount: -1 }],
          1,
        ),
      ).rejects.toThrow('unread count');
      expect(await webdb.getThreadStates()).toEqual([]);
      expect((await webdb.readAccountState()).threadFeedCursor).toBeNull();
    });

    it('rejects incomplete profile text without pinning a placeholder', async () => {
      const db = await webdb.openForUser('1');
      for (const missing of ['name', 'bio']) {
        const profile = {
          account: 'alice',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          rev: 1,
          name: 'Alice',
          bio: '',
          avatarBase64: null,
        };
        delete (profile as Record<string, unknown>)[missing];
        await expect(webdb.commitResolvedProfile(profile)).rejects.toThrow(
          'profile snapshot text is incomplete',
        );
      }
      expect(await db!.getAll('profiles')).toEqual([]);
    });

    it('rejects a different avatar for an immutable profile revision', async () => {
      await webdb.openForUser('1');
      const profile = {
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 1,
        name: 'Alice',
        bio: '',
      };
      await webdb.commitResolvedProfile({ ...profile, avatarBase64: 'YQ==' });
      await expect(
        webdb.commitResolvedProfile({ ...profile, avatarBase64: null }),
      ).rejects.toThrow('conflicting cached profile revision');
      const snapshot = await webdb.getProfile({
        publisherNamespaceId: 0,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 0, account: 'alice', rev: 1 },
      });
      expect(
        await (
          await webdb.getProfileAvatarBlob(snapshot!.avatarDigest!)
        )?.text(),
      ).toBe('a');
    });

    it('caches exact profile versions independently and normalizes namespace-zero subjects', async () => {
      const db = await webdb.openForUser('1');
      const base = {
        publisherNamespaceId: 9,
        profileNamespaceId: 9,
        account: 'alice',
        name: 'New',
        bio: '',
      };
      await webdb.commitResolvedProfile({
        ...base,
        rev: 3,
        avatarBase64: null,
      });
      await webdb.commitResolvedProfile({
        ...base,
        rev: 2,
        name: 'Old',
        avatarBase64: null,
      });
      await webdb.commitResolvedProfile({
        ...base,
        profileNamespaceId: 8,
        rev: 3,
        name: 'Mirror',
        avatarBase64: null,
      });
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 9,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 9, account: 'alice', rev: 3 },
        }),
      ).toMatchObject({ name: 'New' });
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 9,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 9, account: 'alice', rev: 2 },
        }),
      ).toMatchObject({ name: 'Old' });
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 9,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 8, account: 'alice', rev: 3 },
        }),
      ).toMatchObject({ name: 'Mirror' });
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 9,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 7, account: 'alice', rev: 3 },
        }),
      ).toBeUndefined();
      expect(await db!.getAll('profiles')).toHaveLength(3);
    });

    it('distinguishes tombstones from missing bodies and scopes them to the thread', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(42, {
          publisherNamespaceId: 0,
          profileAccount: 'alice',
          profileRev: 1,
        }),
      ]);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 4,
            deletionSeq: 1,
            type: 'USER_RETRACTION',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        1,
      );
      const db = await webdb.db();
      await db.put('messages', {
        threadId: 42,
        seq: 5,
        isDeleted: false,
        content: 'body',
      } as Message);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 6,
            deletionSeq: 2,
            type: 'MODERATION_REMOVAL',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        2,
      );
      expect(await webdb.getMessageDeletions(42, [4, 4, 5, 6, 7])).toEqual([
        { seq: 4, type: 'USER_RETRACTION' },
        { seq: 6, type: 'MODERATION_REMOVAL' },
      ]);
      expect(await webdb.getMessageDeletions(99, [4, 6])).toEqual([]);
      expect(await webdb.getMessageDeletions(42, [])).toEqual([]);
    });

    it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
      'merges deletion and message arrival orders without reviving bodies: %s',
      async (type) => {
        await webdb.openForUser('1');
        const message: Message = {
          profileNamespaceId: 1,
          publisherNamespaceId: 0,
          originSeq: 4,
          threadId: 42,
          namespaceId: 0,
          seq: 4,
          creator: { account: 'alice', namespaceId: 1 },
          profileRev: 3,
          createdAt: 100,
          updatedAt: 101,
          contentType: 'PURE_TEXT',
          content: 'private body',
          isDeleted: false,
          localState: 'READY',
        };
        const later = { ...message, seq: 5 };
        await webdb.putCachedMessages([message]);
        await webdb.mergeThreadStates([
          threadFeedSnapshot(42, {
            publisherNamespaceId: 0,
            profileAccount: 'alice',
            profileRev: 1,
          }),
        ]);
        await webdb.applyDeletedMessages(
          42,
          [4, 5].map((seq, i) => ({
            threadId: 42,
            messageSeq: seq,
            deletionSeq: i + 1,
            type,
            createdAt: 102,
            updatedAt: 102,
          })),
          2,
        );
        await webdb.putCachedMessages([message, later]);
        const db = await webdb.db();
        expect(await db.get('messages', [42, 4])).toEqual(
          createMessageDeletionMarker(42, 4, type),
        );
        expect(await db.get('messages', [42, 5])).toEqual(
          createMessageDeletionMarker(42, 5, type),
        );
        expect(await webdb.getMessage(42, 4)).toBeUndefined();
        expect(await webdb.getMessage(42, 5)).toBeUndefined();
        expect(await webdb.getMessageDeletions(42, [4, 5])).toEqual([
          { seq: 4, type },
          { seq: 5, type },
        ]);
      },
    );

    it('indexes origin targets by thread and emits only after the cache commit', async () => {
      await webdb.openForUser('1');
      const message: Message = {
        threadId: 42,
        seq: 104,
        profileNamespaceId: 0,
        publisherNamespaceId: 3,
        originSeq: 4,
        namespaceId: 0,
        creator: { account: 'alice', namespaceId: 0 },
        profileRev: 1,
        createdAt: 100,
        updatedAt: 100,
        contentType: 'PURE_TEXT',
        content: '{"text":"target"}',
        isDeleted: false,
        localState: 'READY',
      };
      const reads: Promise<Message | undefined>[] = [];
      const sub = webdb.messageDbCommitted$.subscribe((event) => {
        expect(event).toEqual({ userId: 1, threadId: 42 });
        reads.push(webdb.getMessageByOrigin(42, 3, 4));
      });
      await webdb.putCachedMessages([message]);
      expect(await Promise.all(reads)).toEqual([message]);
      expect(await webdb.getMessageByOrigin(99, 3, 4)).toBeUndefined();
      expect(await webdb.getMessageByOrigin(42, 9, 4)).toBeUndefined();
      expect(await webdb.getMessageByOrigin(42, 0, 104)).toEqual(message);
      sub.unsubscribe();
      await webdb.mergeThreadStates([
        threadFeedSnapshot(42, {
          publisherNamespaceId: 0,
          profileAccount: 'alice',
          profileRev: 1,
        }),
      ]);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 104,
            deletionSeq: 1,
            type: 'USER_RETRACTION',
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        1,
      );
      expect(await webdb.getMessageByOrigin(42, 3, 4)).toBeUndefined();
      expect(await webdb.getMessageDeletions(42, [104])).toEqual([
        { seq: 104, type: 'USER_RETRACTION' },
      ]);
    });

    it('stores coordinate-only tombs and rejects stale history bodies for prior deletions', async () => {
      await webdb.openForUser('1');
      const message: Message = {
        profileNamespaceId: 1,
        publisherNamespaceId: 0,
        originSeq: 4,
        threadId: 42,
        namespaceId: 0,
        seq: 4,
        creator: { account: 'alice', namespaceId: 1 },
        profileRev: 3,
        createdAt: 100,
        updatedAt: 101,
        contentType: 'PURE_TEXT',
        content: 'private body',
        isDeleted: false,
        localState: 'READY',
      };
      await webdb.mergeThreadStates([
        threadFeedSnapshot(42, {
          publisherNamespaceId: 0,
          profileAccount: 'alice',
          profileRev: 1,
        }),
      ]);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 4,
            deletionSeq: 1,
            type: 'USER_RETRACTION',
            createdAt: 102,
            updatedAt: 102,
          },
        ],
        1,
      );
      const tomb = createMessageDeletionMarker(42, 5, 'MODERATION_REMOVAL');
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 5,
            deletionSeq: 2,
            type: 'MODERATION_REMOVAL',
            createdAt: 102,
            updatedAt: 102,
          },
        ],
        2,
      );
      const live = { ...message, seq: 6 };
      const committed = await webdb.commitBrowserMessagePage({
        threadId: 42,
        scan: { left: 3, right: 6 },
        messages: [message, { ...message, seq: 5 }, live],
        gaps: [],
        knownNewestSeq: 6,
      });
      expect(committed.messages).toEqual([live]);
      expect(await webdb.queryCachedMessages(42, 'asc', 10)).toEqual(
        committed.messages,
      );
      const db = await webdb.db();
      expect(await db.get('messages', [42, 4])).toEqual(
        createMessageDeletionMarker(42, 4, 'USER_RETRACTION'),
      );
      expect(await db.get('messages', [42, 5])).toEqual(tomb);
      expect(await webdb.getMessageDeletions(42, [4, 5, 6])).toEqual([
        { seq: 4, type: 'USER_RETRACTION' },
        { seq: 5, type: 'MODERATION_REMOVAL' },
      ]);
    });

    it('counts visible unread slots but not deletions, own messages, or gaps', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(42, {
          publisherNamespaceId: 0,
          profileAccount: 'alice',
          profileRev: 1,
        }),
      ]);
      const owner = { account: 'me', namespaceId: 0 };
      const base: Message = {
        profileNamespaceId: 2,
        publisherNamespaceId: 0,
        originSeq: 1,
        threadId: 42,
        namespaceId: 0,
        seq: 1,
        creator: { account: 'other', namespaceId: 2 },
        profileRev: 1,
        createdAt: 100,
        updatedAt: 100,
        contentType: 'PURE_TEXT',
        content: 'body',
        isDeleted: false,
        localState: 'READY',
      };
      await webdb.putCachedMessages([
        base,
        { ...base, seq: 4, creator: owner },
        {
          ...base,
          seq: 6,
          creator: { account: '$system', namespaceId: 0 },
          profileRev: 0,
          contentType: 'SYSTEM',
        },
        { ...base, seq: 8, localState: 'STUB' },
        { ...base, seq: 9, localState: 'FAILED' },
        { ...base, seq: 10, creator: { ...owner, namespaceId: 2 } },
        { ...base, seq: 11, threadId: 99 },
      ]);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            deletionSeq: 1,
            threadId: 42,
            messageSeq: 3,
            type: 'USER_RETRACTION',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            deletionSeq: 2,
            threadId: 42,
            messageSeq: 5,
            type: 'MODERATION_REMOVAL',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        2,
      );
      await webdb.mergeThreadStates([
        threadFeedSnapshot(42, {
          publisherNamespaceId: 0,
          profileAccount: 'alice',
          profileRev: 1,
        }),
      ]);
      await webdb.applyDeletedMessages(
        42,
        [
          {
            threadId: 42,
            messageSeq: 7,
            deletionSeq: 1,
            type: 'USER_RETRACTION',
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        1,
      );
      expect(await webdb.countUnreadMessageSlots(42, 0, 11, owner)).toBe(5);
      expect(await webdb.countUnreadMessageSlots(42, 1, 3, owner)).toBe(0);
      expect(await webdb.countUnreadMessageSlots(42, 3, 7, owner)).toBe(1);
      expect(await webdb.countUnreadMessageSlots(42, 7, 7, owner)).toBe(0);
      const snapshot = {
        ...threadStructure(42, {
          profileAccount: 'other',
          publisherNamespaceId: 2,
          profileRev: 0,
        }),
        threadId: 42,
        threadFeedId: 1,
        messageEndSeq: 11,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 0,
        unreadCount: 6,
        announcementReadFeedId: 0,
        lastMentionSeq: 3,
      };
      let state = advanceLocalAttentionRead(
        mergeThreadAttention(undefined, snapshot),
        3,
      );
      for (const incoming of [
        snapshot,
        { ...snapshot, threadFeedId: 2, lastReadSeq: 1, unreadCount: 5 },
        { ...snapshot, threadFeedId: 3 },
      ]) {
        state = mergeThreadAttention(state, incoming);
        const range = attentionCountRange(state)!;
        const count = await webdb.countUnreadMessageSlots(
          range.threadId,
          range.afterSeq,
          range.throughSeq,
          owner,
        );
        expect(projectThreadAttention(state, count)).toMatchObject({
          lastReadSeq: 3,
          unreadCount: 5,
          hasUnreadMention: false,
        });
      }
      await webdb.putCachedMessages([{ ...base, seq: 7 }]);
      expect(await webdb.countUnreadMessageSlots(42, 0, 11, owner)).toBe(5);
      await expect(
        webdb.countUnreadMessageSlots(42, 5, 4, owner),
      ).rejects.toThrow('Invalid unread');
    });

    it('keeps a system profile correction local to its row across cache refills', async () => {
      await webdb.openForUser('1');
      const message: Message = {
        profileNamespaceId: 0,
        publisherNamespaceId: 0,
        originSeq: 1,
        threadId: 42,
        namespaceId: 0,
        seq: 1,
        creator: { account: '$system', namespaceId: 0 },
        profileRev: 0,
        createdAt: 100,
        updatedAt: 100,
        contentType: 'SYSTEM',
        content: '{"type":"GROUP_JOINED"}',
        isDeleted: false,
        localState: 'READY',
      };
      await webdb.putCachedMessages([message, { ...message, seq: 2 }]);
      expect(
        await webdb.correctSystemMessageProfile(42, 1, 'alice', 7, 0, 2),
      ).toBe(true);
      expect(
        await webdb.correctSystemMessageProfile(42, 1, 'alice', 7, 0, 2),
      ).toBe(false);
      await webdb.putCachedMessages([message, { ...message, seq: 2 }]);
      expect(await webdb.getMessage(42, 1)).toMatchObject({
        localSystemProfileRevs: { '[7,0,"alice"]': 2 },
      });
      expect(await webdb.getMessage(42, 2)).not.toHaveProperty(
        'localSystemProfileRevs',
      );
      await webdb.putCachedMessages([
        { ...message, content: '{"type":"GROUP_LEFT"}' },
      ]);
      // Ordinary cache refills cannot replace an already committed immutable body.
      expect(await webdb.getMessage(42, 1)).toMatchObject({
        content: message.content,
        localSystemProfileRevs: { '[7,0,"alice"]': 2 },
      });
    });

    it('does not cap unread slot counts at 100', async () => {
      await webdb.openForUser('1');
      await webdb.putCachedMessages(
        Array.from(
          { length: 120 },
          (_, i): Message => ({
            profileNamespaceId: 0,
            publisherNamespaceId: 0,
            originSeq: i + 1,
            threadId: 42,
            namespaceId: 0,
            seq: i + 1,
            creator: { account: '$system', namespaceId: 0 },
            profileRev: 0,
            createdAt: 100,
            updatedAt: 100,
            contentType: 'SYSTEM',
            content: '{}',
            isDeleted: false,
            localState: 'READY',
          }),
        ),
      );
      expect(
        await webdb.countUnreadMessageSlots(42, 0, 120, {
          account: 'me',
          namespaceId: 0,
        }),
      ).toBe(120);
    });

    it('opens one per-user account database and signals ready', async () => {
      const db = await webdb.openForUser('1');
      expect(db, 'opened handle').toBeTruthy();
      expect(db!.name, 'login-session partition key').toBe(
        session.indexedDbName,
      );
      expect([...db!.objectStoreNames].sort()).toEqual([
        'accountState',
        'groupMeta',
        'messageRanges',
        'messages',
        'profileAvatarBlobs',
        'profileNamespaceTombs',
        'profileNamespaces',
        'profileTombs',
        'profiles',
        'threadPreviews',
        'threadResourceSync',
        'threads',
      ]);
      expect((await webdb.db()).version).toBe(2);
      expect(await webdb.readAccountState()).not.toHaveProperty(
        'schemaVersion',
      );
      expect(webdb.ready()).toBe(true);
    });

    it('rebuilds an older physical cache format instead of migrating it', async () => {
      const old = await openDB(session.indexedDbName, 1, {
        upgrade(db) {
          db.createObjectStore('accountState');
        },
      });
      await old.put(
        'accountState',
        { intentRequestEndId: 'legacy' },
        'account',
      );
      old.close();

      await webdb.openForUser('1');

      expect((await webdb.db()).version).toBe(2);
      expect((await webdb.readAccountState()).intentRequestEndId).toBeNull();
    });

    it('strict startup open does not create missing databases', async () => {
      await expect(webdb.openExistingForUser('1')).rejects.toThrow();

      const names = (await indexedDB.databases()).map(
        (database) => database.name,
      );
      expect(names).not.toContain(session.indexedDbName);
      expect(webdb.ready()).toBe(false);
    });

    it('does not recreate a cache deleted between enumeration and strict opening', async () => {
      await webdb.openForUser('1');
      await webdb.close();
      const databases = indexedDB.databases.bind(indexedDB);
      const enumerate = vi
        .spyOn(indexedDB, 'databases')
        .mockImplementationOnce(async () => {
          const names = await databases();
          await deleteDB(session.indexedDbName);
          return names;
        });
      try {
        await expect(webdb.openExistingForUser('1')).rejects.toThrowError(
          LocalCacheUnavailableError,
        );
        expect((await databases()).map((db) => db.name)).not.toContain(
          session.indexedDbName,
        );
        expect(webdb.ready()).toBe(false);
      } finally {
        enumerate.mockRestore();
      }
    });

    it('strict startup open preserves an existing valid cache', async () => {
      await webdb.openForUser('1');
      await webdb.writeSelfProfile({
        id: 1,
        account: 'me',
        isGroup: false,
        namespaceId: 0,
        profileRev: 1,
        isDeleted: false,
      });
      await webdb.close();

      await webdb.openExistingForUser('1');

      expect((await webdb.readAccountState()).selfProfile).toEqual({
        id: 1,
        account: 'me',
        isGroup: false,
        namespaceId: 0,
        profileRev: 1,
        isDeleted: false,
      });
    });

    it('strict startup open reports a version mismatch without deleting the cache', async () => {
      await webdb.openForUser('1');
      await webdb.writeSelfProfile({
        id: 1,
        account: 'me',
        isGroup: false,
        namespaceId: 0,
        profileRev: 1,
        isDeleted: false,
      });
      await webdb.close();
      const newer = await openDB(session.indexedDbName, 3);
      newer.close();

      await expect(webdb.openExistingForUser('1')).rejects.toThrowError(
        LocalCacheVersionMismatchError,
      );
      const raw = await openDB(session.indexedDbName);
      expect(
        (await raw.get('accountState', 'account')).selfProfile?.account,
      ).toBe('me');
      raw.close();
    });

    it.each(['physical-version', 'missing-store'] as const)(
      'strict startup rejects %s without changing cached data or ancillary databases',
      async (corruption) => {
        await webdb.openForUser('1');
        const originalVersion = (await webdb.db()).version;
        await webdb.close();
        if (corruption === 'missing-store')
          await deleteDB(session.indexedDbName);
        const expectedVersion =
          corruption === 'physical-version'
            ? originalVersion + 1
            : originalVersion;
        const damaged = await openDB(session.indexedDbName, expectedVersion, {
          upgrade(db) {
            if (corruption === 'missing-store')
              db.createObjectStore('accountState');
          },
        });
        if (corruption === 'missing-store')
          await damaged.put(
            'accountState',
            { stateFeedTarget: 0, privateProbe: 'retain' },
            'account',
          );
        const state = await damaged.get('accountState', 'account');
        damaged.close();
        const ancillaryName = `${session.indexedDbName}-pending-sends`;
        const ancillary = await openDB(ancillaryName, 1, {
          upgrade(db) {
            db.createObjectStore('probe');
          },
        });
        await ancillary.put('probe', 'preserve pending work', 'value');
        ancillary.close();

        await expect(webdb.openExistingForUser('1')).rejects.toThrowError(
          corruption === 'physical-version'
            ? LocalCacheVersionMismatchError
            : LocalCacheUnavailableError,
        );
        expect(webdb.ready()).toBe(false);
        const raw = await openDB(session.indexedDbName);
        try {
          expect(raw.version).toBe(expectedVersion);
          expect(await raw.get('accountState', 'account')).toEqual(state);
          expect(raw.objectStoreNames.contains('threadResourceSync')).toBe(
            corruption !== 'missing-store',
          );
        } finally {
          raw.close();
        }
        const preserved = await openDB(ancillaryName);
        try {
          expect(await preserved.get('probe', 'value')).toBe(
            'preserve pending work',
          );
        } finally {
          preserved.close();
        }
      },
    );

    it('drops and reinitializes a cache whose physical format is newer', async () => {
      await webdb.openForUser('1');
      await webdb.writeSelfProfile({
        id: 1,
        account: 'me',
        isGroup: false,
        namespaceId: 0,
        profileRev: 1,
        isDeleted: false,
      });
      await webdb.close();
      const newer = await openDB(session.indexedDbName, 3);
      newer.close();

      await webdb.openForUser('1');

      expect((await webdb.db()).version).toBe(2);
      expect(await webdb.readAccountState()).not.toHaveProperty(
        'schemaVersion',
      );
      expect((await webdb.readAccountState()).selfProfile).toBeNull();
    });

    it('counts only cached message rows', async () => {
      await webdb.openForUser('1');
      await webdb.putCachedMessages([
        { threadId: 7, seq: 1, isDeleted: false, content: '' } as Message,
        { threadId: 7, seq: 2, isDeleted: false, content: '' } as Message,
        { threadId: 9, seq: 1, isDeleted: false, content: '' } as Message,
      ]);

      expect(await webdb.countCachedMessages()).toBe(3);
    });

    it('atomically commits messages and canonical explicit ranges', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          publisherNamespaceId: 0,
          profileAccount: 'peer',
          profileRev: 1,
        }),
      ]);
      const page = await webdb.commitBrowserMessagePage({
        threadId: 7,
        scan: { left: 9, right: 50 },
        messages: [
          { threadId: 7, seq: 10, content: '', isDeleted: false } as Message,
          { threadId: 7, seq: 40, content: '', isDeleted: false } as Message,
        ],
        gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
        knownNewestSeq: 50,
      });

      expect(page.messages.map((message) => message.seq)).toEqual([10, 40]);
      expect(page.ranges).toEqual([
        { threadId: 7, left: 9, right: 19, state: 'LOCAL_COVERED' },
        { threadId: 7, left: 19, right: 30, state: 'SERVER_PENDING' },
        { threadId: 7, left: 30, right: 50, state: 'LOCAL_COVERED' },
      ]);
      expect(await webdb.getMessageRanges(7)).toEqual(page.ranges);
      expect((await webdb.getMessage(7, 10))?.seq).toBe(10);
    });

    it('does not partially write a page rejected by the range reducer', async () => {
      await webdb.openForUser('1');

      await expect(
        webdb.commitBrowserMessagePage({
          threadId: 7,
          scan: { left: 9, right: 30 },
          messages: [{ threadId: 7, seq: 20 } as Message],
          gaps: [{ left: 19, right: 25, state: 'SERVER_PENDING' }],
        }),
      ).rejects.toThrow('overlaps a server gap');

      expect(await webdb.getMessage(7, 20)).toBeUndefined();
      expect(await webdb.getMessageRanges(7)).toEqual([]);
    });

    it('finishes an admitted page atomically after its caller cancels, while rejecting later admission', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          publisherNamespaceId: 0,
          profileAccount: 'peer',
          profileRev: 1,
        }),
      ]);
      const liveDb = await webdb.db();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admitted!: () => void;
      const entered = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const messageDb = vi
        .spyOn(webdb, 'db')
        .mockImplementationOnce(async () => {
          admitted();
          await held;
          return liveDb;
        });
      const lifetime = new AbortController();
      const input = {
        threadId: 7,
        scan: { left: 0, right: 1 },
        messages: [
          { threadId: 7, seq: 1, content: '', isDeleted: false } as Message,
        ],
        gaps: [],
        knownNewestSeq: 1,
      };
      const pending = webdb.commitBrowserMessagePage(input, lifetime.signal);
      await entered;
      lifetime.abort();
      const rejected = expect(
        webdb.commitBrowserMessagePage(input, lifetime.signal),
      ).rejects.toThrow('message cache lifetime expired');
      release();
      await pending;
      await rejected;
      expect(messageDb).toHaveBeenCalledOnce();
      messageDb.mockRestore();
      expect(await webdb.getMessage(7, 1)).toEqual(
        expect.objectContaining({ seq: 1 }),
      );
      expect(await webdb.getMessageRanges(7)).toEqual([
        { threadId: 7, left: 0, right: 1, state: 'LOCAL_COVERED' },
      ]);
      expect(await webdb.getMessageHead(7)).toBe(1);
    });

    it('serializes complete page commits for one thread before opening either transaction', async () => {
      await webdb.openForUser('1');
      const liveDb = await webdb.db();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const messageDb = vi.spyOn(webdb, 'db').mockImplementation(async () => {
        calls++;
        if (calls === 1) await held;
        return liveDb;
      });

      const first = webdb.commitBrowserMessagePage({
        threadId: 7,
        scan: { left: 0, right: 1 },
        messages: [
          { threadId: 7, seq: 1, content: '', isDeleted: false } as Message,
        ],
        gaps: [],
      });
      await Promise.resolve();
      const second = webdb.commitBrowserMessagePage({
        threadId: 7,
        scan: { left: 1, right: 2 },
        messages: [
          { threadId: 7, seq: 2, content: '', isDeleted: false } as Message,
        ],
        gaps: [],
      });
      await Promise.resolve();
      await vi.waitFor(() => expect(calls).toBe(1));

      release();
      await Promise.all([first, second]);
      expect(calls).toBe(2);
      messageDb.mockRestore();
      expect(await webdb.getMessageRanges(7)).toEqual([
        { threadId: 7, left: 0, right: 2, state: 'LOCAL_COVERED' },
      ]);
    });

    it('deletes one thread messages and ranges but preserves its head without touching another thread', async () => {
      await webdb.openForUser('1');
      for (const threadId of [7, 8]) {
        await webdb.mergeThreadStates([
          threadFeedSnapshot(threadId, {
            publisherNamespaceId: 0,
            profileAccount: `peer-${threadId}`,
            profileRev: 1,
          }),
        ]);
        await webdb.commitBrowserMessagePage({
          threadId,
          scan: { left: 0, right: 1 },
          messages: [
            { threadId, seq: 1, content: '', isDeleted: false } as Message,
          ],
          gaps: [],
          knownNewestSeq: 1,
        });
      }

      await webdb.deleteMessagesByThread(7);

      expect(await webdb.getMessage(7, 1)).toBeUndefined();
      expect(await webdb.getMessageRanges(7)).toEqual([]);
      expect(await webdb.getMessageHead(7)).toBe(1);
      expect((await webdb.getMessage(8, 1))?.seq).toBe(1);
      expect(await webdb.getMessageRanges(8)).toHaveLength(1);
    });

    it('closeAndDelete physically removes the database (per-user wipe)', async () => {
      await webdb.openForUser('1');
      const snapshot = await webdb.commitResolvedProfile({
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 1,
        name: 'Alice',
        bio: '',
        avatarBase64: 'eA==',
      });
      await webdb.closeAndDelete('1');
      expect(webdb.ready()).toBe(false);
      // Reopen → empty: the DB was deleted, not just closed. (Combined with the name-embeds-user
      // assertion above, this is the per-user isolation guarantee.)
      await webdb.openForUser('1');
      expect(
        await webdb.getProfileAvatarBlob(snapshot.avatarDigest!),
      ).toBeUndefined();
    });

    // Regression guard for the stale-currentUserId bug: closeAndDelete must null currentUserId, so a
    // racing db() call (e.g. a repository read fired before the new user's effect re-opens a DB) cannot
    // transparently RE-OPEN this user's database via the lazy re-open path. Before the fix,
    // currentUserId stayed '1' and db() would silently re-create the deleted login cache.
    it('closeAndDelete resets currentUserId so db() does not transparently re-open that user', async () => {
      await webdb.openForUser('1');
      expect(webdb.ready()).toBe(true);
      await webdb.closeAndDelete('1');
      // db() has no handle and no currentUserId → it must reject (it must NOT lazily reopen '1').
      await expect(webdb.db()).rejects.toThrow();
      expect(webdb.ready()).toBe(false);
    });

    it('account invalidation aborts old rounds before durable cleanup begins', async () => {
      await webdb.openForUser('1');
      const lifetime = webdb.captureMessageLifetime();
      TestBed.inject(SessionLifecycleService).invalidateSession();
      expect(lifetime.aborted).toBe(true);
      expect(webdb.ready()).toBe(false);
      await expect(webdb.getThreadStates()).rejects.toThrow(
        'account cache lifetime expired',
      );
    });

    it('logout wins a race with full recreation and the stale reset cannot reopen either DB', async () => {
      await webdb.openForUser('1');
      const lifetime = webdb.captureMessageLifetime();

      const recreate = webdb.recreateForUser('1');
      const logout = webdb.closeAndDelete('1');
      await Promise.all([recreate, logout]);

      expect(lifetime.aborted).toBe(true);
      expect(webdb.ready()).toBe(false);
      await expect(webdb.db()).rejects.toThrow();
      const names = (await indexedDB.databases()).map(
        (database) => database.name,
      );
      expect(names).not.toContain(session.indexedDbName);
    });

    it('full recreation blocks new core operations and waits for an admitted core read', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
      ]);
      const liveDb = await webdb.db();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const dbSpy = vi.spyOn(webdb, 'db').mockImplementation(async () => {
        await held;
        return liveDb;
      });

      const read = webdb.getThreads();
      await Promise.resolve();
      let recreated = false;
      const recreate = webdb
        .recreateForUser('1')
        .then(() => (recreated = true));

      await expect(webdb.patchThread(8, { muted: true })).rejects.toThrowError(
        'account cache lifetime expired',
      );
      expect(recreated).toBe(false);

      release();
      await read;
      dbSpy.mockRestore();
      await recreate;

      expect(recreated).toBe(true);
      expect(await webdb.getThreads()).toEqual([]);
    });

    it('rebuilds state-feed projections without resetting independently committed group metadata', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadFeedSnapshot(9, {
          type: 'GROUP',
          role: 'OWNER',
          profileAccount: '!team',
          publisherNamespaceId: 0,
          profileRev: 0,
        }),
      ]);
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: '2',
          groupMetaFeedEndId: '2',
          hasMore: false,
          items: [
            {
              feedId: 2,
              createdAt: 1000,
              originCreatedAt: null,
              operation: 'GROUP_MEMBER_COUNT',
              body: { memberCount: 8 },
            },
          ],
        },
      });

      await webdb.applyStateFeedPage([], 3, 3);

      expect(
        (await webdb.getThreads()).find((thread) => thread.threadId === 9),
      ).toMatchObject({
        meta: { memberCount: 8, groupMetaFeedId: '2' },
      });
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({ threadId: 7 }),
        expect.objectContaining({ threadId: 9 }),
      ]);

      await webdb.applyStateFeedPage([], 4);

      expect(
        (await webdb.getThreads()).find((thread) => thread.threadId === 9),
      ).toMatchObject({
        meta: { memberCount: 8, groupMetaFeedId: '2' },
      });
      expect((await webdb.readAccountState()).stateFeedId).toBe(4);
    });

    it('atomically creates the thread and attention from one complete feed snapshot', async () => {
      const db = await webdb.openForUser('1');
      const head = {
        ...threadStructure(9, {
          profileAccount: peerProfile.account,
          publisherNamespaceId: peerProfile.namespaceId,
          profileRev: peerProfile.profileRev,
        }),
        threadId: 9,
        threadFeedId: 4,
        messageEndSeq: 8,
        alias: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 3,
        announcementReadFeedId: 0,
        unreadCount: 5,
        lastMentionSeq: null,
        previews: [],
      };
      const delivered: unknown[] = [];
      const committedRows: Array<Promise<unknown>> = [];
      const subscription = webdb.threadFeedCommitted$.subscribe((event) => {
        delivered.push(event);
        committedRows.push(db!.get('threads', 9));
      });
      const merged = await webdb.mergeThreadStates([head], 4);
      expect(delivered).toEqual([{ userId: 1, states: merged }]);
      expect(await Promise.all(committedRows)).toEqual([
        expect.objectContaining({ threadId: 9, threadFeedId: 4 }),
      ]);
      subscription.unsubscribe();
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 9,
          threadFeedId: 4,
          visible: true,
        }),
      ]);
      expect(await db!.get('threads', 9)).toMatchObject({ type: 'P2P' });
      expect(attentionSnapshot((await webdb.getThreadStates())[0])).toEqual(
        head,
      );
      expect((await webdb.readAccountState()).threadFeedCursor).toBe(4);
      const invalid = threadFeedSnapshot(10, {
        threadFeedId: 7,
        profileAccount: 'peer',
        publisherNamespaceId: -1,
        profileRev: 0,
      });
      await expect(
        webdb.mergeThreadStates(
          [
            threadFeedSnapshot(11, {
              threadFeedId: 6,
              profileAccount: peerProfile.account,
              publisherNamespaceId: peerProfile.namespaceId,
              profileRev: peerProfile.profileRev,
            }),
            invalid,
          ],
          7,
        ),
      ).rejects.toThrow();
      expect(await db!.get('threads', 11)).toBeUndefined();
      expect((await webdb.readAccountState()).threadFeedCursor).toBe(4);
    });

    it('applies block and unblock deltas from the thread feed', async () => {
      await webdb.openForUser('1');
      const event = (feedId: number, blocked: boolean) =>
        threadFeedSnapshot(7, {
          threadFeedId: feedId,
          blocked,
          profileAccount: 'peer',
          publisherNamespaceId: 0,
          profileRev: 1,
        });
      await webdb.mergeThreadStates([event(5, true)], 5);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: true });
      await webdb.mergeThreadStates([event(6, false)], 6);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: false });
      expect((await webdb.readAccountState()).threadFeedCursor).toBe(6);
    });

    it('commits announcement publish, clear and clipped full recovery as distinct states', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      const page = (
        scannedThrough: string,
        items: Array<{
          feedId: number;
          createdAt: number;
          originCreatedAt: number | null;
          operation: 'GROUP_ANNOUNCEMENT';
          body: { text: string | null };
        }>,
      ) => ({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          items,
          scannedThrough,
          groupMetaFeedEndId: scannedThrough,
          hasMore: false,
        },
      });
      await webdb.applyGroupMetaPage(
        page('2', [
          {
            feedId: 2,
            createdAt: 1_000,
            originCreatedAt: null,
            operation: 'GROUP_ANNOUNCEMENT',
            body: { text: 'Hello' },
          },
        ]),
      );
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: '2',
        announcementText: 'Hello',
        announcementCreatedAt: 1_000,
        announcementOriginCreatedAt: null,
      });
      await webdb.applyGroupMetaPage(
        page('4', [
          {
            feedId: 4,
            createdAt: 4_000,
            originCreatedAt: 2_000,
            operation: 'GROUP_ANNOUNCEMENT',
            body: { text: null },
          },
        ]),
      );
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: '4',
        announcementText: null,
        announcementCreatedAt: 4_000,
        announcementOriginCreatedAt: 2_000,
      });
      await webdb.applyGroupMetaPage(page('5', []));
      expect(await groupMeta()).toMatchObject({ announcementFeedId: '4' });
      // Only an explicit recovery can establish the absence of a fact.
      await webdb.beginGroupMetaRecovery(9, '5');
      await webdb.applyGroupMetaPage(page('5', []));
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: null,
      });
    });

    it('publishes recovered counts only at the fixed boundary and retains progress across reopening', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      const countPage = (
        feedId: number,
        memberCount: number,
        hasMore: boolean,
      ) => ({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: String(feedId),
          groupMetaFeedEndId: '5',
          hasMore,
          items: [
            {
              feedId,
              createdAt: 1000,
              originCreatedAt: null,
              operation: 'GROUP_MEMBER_COUNT' as const,
              body: { memberCount },
            },
          ],
        },
      });
      await webdb.applyGroupMetaPage(countPage(1, 8, false));
      await webdb.beginGroupMetaRecovery(9, '5');
      await webdb.applyGroupMetaPage(countPage(3, 4, true));
      expect(await groupMeta()).toMatchObject({
        memberCount: 8,
        recoveryThrough: '5',
        groupMetaFeedId: '3',
      });
      await webdb.close();
      await webdb.openForUser('1');
      expect(await groupMeta()).toMatchObject({
        memberCount: 8,
        recoveryThrough: '5',
      });
      await webdb.applyGroupMetaPage(countPage(5, 0, false));
      expect(await groupMeta()).toMatchObject({
        memberCount: 0,
        recoveryThrough: null,
        groupMetaFeedId: '5',
      });
    });

    it('stages an announcement across full pages until the fixed recovery boundary', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      await webdb.beginGroupMetaRecovery(9, '3');
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: '1',
          groupMetaFeedEndId: '3',
          hasMore: true,
          items: [
            {
              feedId: 1,
              createdAt: 1_500,
              originCreatedAt: null,
              operation: 'GROUP_ANNOUNCEMENT',
              body: { text: 'Notice' },
            },
          ],
        },
      });
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: null,
      });
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
          items: [],
        },
      });
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: '1',
        announcementText: 'Notice',
        announcementCreatedAt: 1_500,
        announcementOriginCreatedAt: null,
      });
    });

    it('clears every staged recovery announcement field when a recovery window restarts', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      await webdb.beginGroupMetaRecovery(9, '3');
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: '1',
          groupMetaFeedEndId: '3',
          hasMore: true,
          items: [
            {
              feedId: 1,
              createdAt: 1_500,
              originCreatedAt: 900,
              operation: 'GROUP_ANNOUNCEMENT',
              body: { text: 'Notice' },
            },
          ],
        },
      });
      // A server-directed window restart must drop the whole staged
      // announcement, timestamps included.
      await webdb.beginGroupMetaRecovery(9, '2');
      expect(await (await webdb.db()).get('groupMeta', 9)).toMatchObject({
        recoveryAnnouncementFeedId: null,
        recoveryAnnouncementText: null,
        recoveryAnnouncementCreatedAt: null,
        recoveryAnnouncementOriginCreatedAt: null,
      });
      // A narrowed window with no announcement ends fully cleared instead of
      // resurrecting the interrupted window's timestamps.
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        page: {
          account: '!team',
          scannedThrough: '2',
          groupMetaFeedEndId: '2',
          hasMore: false,
          items: [],
        },
      });
      expect(await groupMeta()).toMatchObject({
        announcementFeedId: null,
        announcementText: null,
        announcementCreatedAt: null,
        announcementOriginCreatedAt: null,
      });
    });

    it('materializes a group from the complete thread snapshot before background meta commits', async () => {
      await webdb.openForUser('1');
      await webdb.commitResolvedProfile({
        name: 'Bob',
        account: 'bob',
        avatarBase64: null,
        bio: '',
        publisherNamespaceId: 12,
        profileNamespaceId: 12,
        rev: 1,
      });
      await webdb.commitResolvedProfile({
        name: '!dev',
        account: '!dev',
        avatarBase64: null,
        bio: '',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 1,
      });
      await webdb.mergeThreadStates(
        [
          threadFeedSnapshot(12, {
            threadFeedId: 3,
            type: 'GROUP',
            profileAccount: '!dev',
            publisherNamespaceId: 0,
            profileRev: 1,
            role: 'OWNER',
          }),
        ],
        3,
      );
      await webdb.applyGroupMetaPage({
        threadId: 12,
        namespaceId: 0,
        page: {
          account: '!dev',
          items: [
            {
              feedId: 2,
              createdAt: 1_000,
              originCreatedAt: null,
              operation: 'GROUP_MEMBER_COUNT',
              body: { memberCount: 2 },
            },
          ],
          hasMore: false,
          scannedThrough: '2',
          groupMetaFeedEndId: '2',
        },
      });

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 12,
          type: 'GROUP',
          account: '!dev',
          profile: expect.objectContaining({ name: '!dev' }),
          meta: expect.objectContaining({
            memberCount: 2,
            groupMetaFeedId: '2',
          }),
        }),
      ]);

      // No client-side intent projection exists anymore: group lifecycle state
      // arrives only through the authoritative thread snapshot.
      await webdb.mergeThreadStates(
        [
          threadFeedSnapshot(12, {
            threadFeedId: 5,
            type: 'GROUP',
            conversationState: 'READ_ONLY',
            role: null,
            profileAccount: '!dev',
            publisherNamespaceId: 0,
            profileRev: 1,
          }),
        ],
        5,
      );
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 12,
          type: 'GROUP',
          conversationState: 'READ_ONLY',
          role: null,
        }),
      ]);
      // A count fact and a cached profile are not authoritative membership facts.
      expect((await webdb.getThreads())[0]).toMatchObject({
        meta: { memberCount: 2, groupMetaFeedId: '2' },
      });
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 12,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 12, account: 'bob', rev: 1 },
        }),
      ).toBeDefined();
      expect(
        await webdb.getProfile({
          publisherNamespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: '!dev', rev: 1 },
        }),
      ).toBeDefined();
      // Recovery retains the last committed count until its fixed boundary;
      // an empty completed full snapshot then publishes zero atomically.
      await webdb.beginGroupMetaRecovery(12, '3');
      expect((await webdb.getThreads())[0]).toMatchObject({
        meta: {
          memberCount: 2,
          groupMetaFeedId: '0',
          recoveryThrough: '3',
        },
      });
      await expect(
        webdb.applyGroupMetaPage({
          threadId: 12,
          namespaceId: 0,
          page: {
            account: '!dev',
            items: [],
            hasMore: false,
            scannedThrough: '3',
            groupMetaFeedEndId: '3',
          },
        }),
      ).resolves.toMatchObject({ threadId: 12, groupMetaFeedId: '3' });
      expect((await webdb.getThreads())[0]).toMatchObject({
        meta: { memberCount: 0, groupMetaFeedId: '3', recoveryThrough: null },
      });
    });

    it('keeps a newly created local group visible across the relationship and thread feeds', async () => {
      await webdb.openForUser('1');
      const group = {
        account: '!repro-group',
        namespaceId: 0,
        name: 'LOCAL-GROUP-REPRO',
        avatar: '',
        description: 'created from the Web UI',
        profileRev: 1,
      };

      await webdb.mergeThreadStates(
        [
          threadFeedSnapshot(95, {
            threadFeedId: 1,
            type: 'GROUP',
            role: 'OWNER',
            profileAccount: group.account,
            publisherNamespaceId: 0,
            profileRev: 1,
          }),
        ],
        1,
      );

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 95,
          type: 'GROUP',
          visible: true,
          role: 'OWNER',
          account: group.account,
          profile: expect.objectContaining({ name: group.account }),
        }),
      ]);

      await webdb.commitResolvedProfile({
        account: group.account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 1,
        name: group.name,
        bio: group.description,
        avatarBase64: null,
      });

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 95,
          visible: true,
          profile: expect.objectContaining({
            name: group.name,
            bio: group.description,
          }),
        }),
      ]);
    });

    it('recreates only the message DB and preserves the core cache', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          publisherNamespaceId: 0,
          profileAccount: 'peer',
          profileRev: 1,
        }),
      ]);
      await webdb.writeSelfProfile({
        id: 1,
        account: 'me',
        isGroup: false,
        namespaceId: 0,
        profileRev: 1,
        isDeleted: false,
      });
      const profile = await webdb.commitResolvedProfile({
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 1,
        name: 'Alice',
        bio: '',
        avatarBase64: 'eA==',
      });
      await webdb.commitBrowserMessagePage({
        threadId: 7,
        scan: { left: 0, right: 1 },
        messages: [{ threadId: 7, seq: 1 } as never],
        gaps: [],
        knownNewestSeq: 1,
      });

      await webdb.recreateMessageCache();

      expect((await webdb.readAccountState()).selfProfile?.account).toBe('me');
      expect(
        await (await webdb.getProfileAvatarBlob(profile.avatarDigest!))?.text(),
      ).toBe('x');
      expect(await webdb.getMessage(7, 1)).toBeUndefined();
      expect(await webdb.getMessageRanges(7)).toEqual([]);
      expect(await webdb.getMessageHead(7)).toBe(1);
    });

    it('aborts the old lifetime, closes admission, and waits for active message operations before recreating', async () => {
      await webdb.openForUser('1');
      const liveDb = await webdb.db();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(webdb, 'db').mockImplementation(async () => {
        await held;
        return liveDb;
      });

      const lifetime = webdb.captureMessageLifetime();
      const read = webdb.queryCachedMessages(7, 'desc', 10);
      await Promise.resolve();
      let recreated = false;
      const recreate = webdb
        .recreateMessageCache()
        .then(() => (recreated = true));

      expect(lifetime.aborted).toBe(true);
      await expect(webdb.getMessage(7, 1)).rejects.toThrow();
      await Promise.resolve();
      expect(recreated).toBe(false);

      release();
      await read;
      await recreate;
      expect(recreated).toBe(true);
      expect(lifetime.aborted).toBe(true);
      expect(webdb.captureMessageLifetime().aborted).toBe(false);
    });

    it('rejects an old-lifetime write after message-cache recreation', async () => {
      await webdb.openForUser('1');
      const lifetime = webdb.captureMessageLifetime();

      await webdb.recreateMessageCache();

      await expect(
        webdb.commitBrowserMessagePage(
          {
            threadId: 7,
            scan: { left: 0, right: 1 },
            messages: [{ threadId: 7, seq: 1 } as never],
            gaps: [],
          },
          lifetime,
        ),
      ).rejects.toThrowError('message cache lifetime expired');
      expect(await webdb.getMessage(7, 1)).toBeUndefined();
    });
  });
});
