import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { SessionLifecycleService } from './session-lifecycle.service';
import { provideZonelessChangeDetection } from '@angular/core';
import { openDB } from 'idb';
import { messageTomb } from '../../../../shared/message-tomb';
import {
  advanceLocalAttentionRead,
  attentionCountRange,
  attentionSnapshot,
  mergeThreadAttention,
  projectThreadAttention,
} from '../../../../shared/thread-attention';
import { threadFeedSnapshot, threadStructure } from './thread-feed.test-helper';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
  type Message,
} from './model';
import type { ClientStateFeedItem } from './user.service';
import { FRIEND_INTENT_RETENTION_MS } from './friend-request-state';
import {
  CACHE_SCHEMA_VERSION,
  LocalCacheVersionMismatchError,
  MESSAGE_CACHE_SCHEMA_VERSION,
  STATE_FEED_WORKER_FACTORY,
  WebdbService,
} from './webdb.service';
import { WebdbStorage } from './webdb-storage';

const peerProfile = {
  account: 'peer',
  domain: 'local',
  namespaceId: 0,
  profileRev: 0,
};

async function seedGroupFeed(webdb: WebdbService): Promise<void> {
  await webdb.mergeThreadStates([threadFeedSnapshot(9, {
    type: 'GROUP', role: 'OWNER', profile: {
      account: '!team', domain: 'local', namespaceId: 0, profileRev: 0,
    },
  })]);
}

async function seedThread(webdb: WebdbService, item: ConversationItem): Promise<void> {
  const subject = item.type === 'GROUP' ? item.group : item.peerUser;
  const feedId = item.threadFeedId ?? 1;
  await webdb.mergeThreadStates([threadFeedSnapshot(item.threadId, {
    threadFeedId: feedId,
    type: item.type,
    role: item.role,
    authorityNamespaceId: item.authorityNamespaceId,
    profile: {
      account: subject.account, domain: subject.domain,
      namespaceId: subject.namespaceId, profileRev: item.profileRev,
    },
    threadProfileRev: item.profileRev,
  })]);
  await webdb.putThread({ ...item, threadFeedId: feedId });
}

describe('WebdbService', () => {
  describe('IDB-backed storage (fake-indexeddb)', () => {
    let webdb: WebdbService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          WebdbService,
          { provide: STATE_FEED_WORKER_FACTORY, useValue: () => null },
        ],
      });
      webdb = TestBed.inject(WebdbService);
    });

    afterEach(async () => {
      try {
        await webdb.closeAndDelete('1');
      } catch {
        /* already closed */
      }
    });

    it('binds a transferable port only after the database worker acknowledges the account', async () => {
      await webdb.close();
      const worker = {
        onmessage: null,
        onerror: null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
      } as unknown as Worker;
      const workerStorage = new WebdbStorage(() => worker);
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
        ...threadStructure(7, { profile: peerProfile }),
        threadId: 7,
        threadFeedId: 10,
        messageEndSeq: 200,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
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
      expect(await webdb.getSyncState('threadFeedCursor')).toBeUndefined();
    });

    it('projects a counterpart-only thread revision and preserves it across stale list writes', async () => {
      await webdb.openForUser('1');
      const item = createP2PConversation(7, { account: 'peer', name: 'Old', profileRev: 1 });
      await webdb.mergeThreadStates([{
        ...threadStructure(7, { profile: { ...peerProfile, profileRev: 2 } }),
        threadId: 7, threadFeedId: 10, messageEndSeq: 6, tombstoneEndSeq: 0,
        alias: null, threadProfileRev: 2, groupMetaFeedEndId: null,
        joinRequestEndFeedId: 0, joinRequestReadFeedId: -1, groupInviteEndFeedId: 0,
        lastReadSeq: 0, unreadCount: 0, lastMentionSeq: null, previews: [],
        announcementReadFeedId: 0,
      }]);
      expect((await webdb.getThreads())[0]?.profileRev).toBe(2);
      await webdb.putThread({ ...item, threadFeedId: 10, profileRev: 99 });
      const stored = (await webdb.getThreads())[0];
      expect(stored?.profileRev).toBe(2);
      if (stored?.type !== 'P2P') throw new Error('expected P2P thread');
      expect('profileRev' in stored.peerUser).toBe(false);
    });

    it('preserves optimistic progress across snapshots and accepts remote rollback by feed ID', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, { profile: peerProfile }),
        threadId: 7,
        threadFeedId: 10,
        messageEndSeq: 200,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 110,
        announcementReadFeedId: 0,
        unreadCount: 2,
        lastMentionSeq: null,
        previews: [],
      };
      await webdb.mergeThreadStates([{ ...snapshot, threadFeedId: 8, lastReadSeq: 100 }], 8);
      await webdb.advanceThreadRead(7, 105);
      await webdb.mergeThreadStates([snapshot], 10);
      await webdb.mergeThreadStates([
        { ...snapshot, threadFeedId: 9, lastReadSeq: 120 },
      ]);
      await webdb.mergeThreadStates([{ ...snapshot, lastReadSeq: 130 }]);
      expect((await webdb.getThreadStates())[0]).toEqual({
        ...snapshot,
        localReadSeq: 105,
      });
      const rolledBack = { ...snapshot, threadFeedId: 11, lastReadSeq: 95 };
      await webdb.mergeThreadStates([rolledBack]);
      expect(await webdb.advanceThreadRead(7, 104)).toEqual({
        ...rolledBack,
        localReadSeq: 105,
      });
      expect(await webdb.getSyncState('threadFeedCursor')).toBe(10);
    });

    it('serializes concurrent local progress and snapshots without losing either', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, { profile: peerProfile }),
        threadId: 7,
        threadFeedId: 1,
        messageEndSeq: 200,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
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
      const snapshot = threadFeedSnapshot(7, { profile: peerProfile, lastReadSeq: 100 });
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
      expect(await webdb.getSyncState('threadFeedCursor')).toBe(20);
    });

    it('rejects an invalid batch before writing any snapshot or cursor', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        ...threadStructure(7, { profile: peerProfile }),
        threadId: 7,
        threadFeedId: 1,
        messageEndSeq: 200,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
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
      expect(await webdb.getSyncState('threadFeedCursor')).toBeUndefined();
    });

    it('normalizes local mirror members without changing the group source and keeps unresolved members', async () => {
      const db = await webdb.openForUser('1');
      await seedThread(webdb,
        createGroupConversation(90, {
          id: 90,
          name: 'Mirror',
          account: '!mirror',
          domain: 'authority.test',
          namespaceId: 7,
        }),
      );
      await webdb.applyGroupMetaPage({
        threadId: 90,
        sourceServer: 'authority.test',
        namespaceId: 7,
        page: {
          account: '!mirror',
          mode: 'full',
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
          items: [
            {
              feedId: '1',
              operation: 'MEMBER_UPSERT',
              account: 'me',
              domain: 'local',
              namespaceId: 7,
              body: { role: 'MEMBER', profileRev: 2 },
            },
            {
              feedId: '2',
              operation: 'MEMBER_UPSERT',
              account: 'other',
              domain: 'third.test',
              namespaceId: 7,
              body: {
                role: 'MEMBER',
                profileRev: 2,
              },
            },
            {
              feedId: '3',
              operation: 'GROUP_PROFILE',
              body: { profileRev: 4 },
            },
          ],
        },
      });
      const members = await webdb.queryGroupMembers({ threadId: 90, take: 10 });
      expect(members).toHaveLength(2);
      expect(members.find((member) => member.account === 'me')).toMatchObject({
        domain: 'local',
        namespaceId: 0,
        user: { name: 'me' },
      });
      expect(
        members.find((member) => member.account === 'other'),
      ).toMatchObject({
        domain: 'third.test',
        namespaceId: 7,
        user: { name: 'other' },
      });
      expect(await webdb.getGroupMember(90, 'me', 'local', 7)).toMatchObject({
        namespaceId: 0,
      });
      expect(await db!.get('threads', 90)).toMatchObject({
        authorityNamespaceId: 7,
        profileDomain: 'authority.test', profileNamespaceId: 7,
      });
      expect(await db!.getAll('profiles')).toHaveLength(0);
      expect(await webdb.getSyncState('stateFeedId')).toBeUndefined();
    });

    it('rejects incomplete profile text without pinning a placeholder', async () => {
      const db = await webdb.openForUser('1');
      for (const missing of ['name', 'bio']) {
        const profile = {
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
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
        domain: 'local',
        namespaceId: 0,
        rev: 1,
        name: 'Alice',
        bio: '',
      };
      await webdb.commitResolvedProfile({ ...profile, avatarBase64: 'YQ==' });
      await expect(
        webdb.commitResolvedProfile({ ...profile, avatarBase64: null }),
      ).rejects.toThrow('conflicting cached profile revision');
      const snapshot = await webdb.getProfile({ ...profile, profileRev: 1 });
      expect(
        await (
          await webdb.getProfileAvatarBlob(snapshot!.avatarDigest!)
        )?.text(),
      ).toBe('a');
    });

    it('caches exact profile versions independently and normalizes namespace-zero subjects', async () => {
      const db = await webdb.openForUser('1');
      const profile = {
        account: 'alice',
        domain: 'local',
        namespaceId: 9,
        profileRev: 3,
        name: 'New',
        avatar: '',
        bio: '',
        sourceServer: 'authority.test',
      };
      await webdb.commitResolvedProfile({
        ...profile,
        rev: profile.profileRev,
        avatarBase64: null,
      });
      await webdb.commitResolvedProfile({
        ...profile,
        avatarBase64: null,
        rev: 2,
        name: 'Old',
      });
      await webdb.commitResolvedProfile({
        ...profile,
        avatarBase64: null,
        rev: profile.profileRev,
        domain: 'third.test',
        namespaceId: 9,
        name: 'Mirror',
      });
      expect(
        await webdb.getProfile({
          ...profile,
          domain: 'own.test',
          namespaceId: 0,
        }),
      ).toMatchObject({ domain: 'local', namespaceId: 0, name: 'New' });
      expect(
        await webdb.getProfile({ ...profile, profileRev: 2 }),
      ).toMatchObject({ name: 'Old' });
      expect(
        await webdb.getProfile({
          ...profile,
          domain: 'third.test',
          namespaceId: 8,
        }),
      ).toBeUndefined();
      expect(await db!.getAll('profiles')).toHaveLength(3);
      expect(await db!.getAll('profiles')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ domain: 'local', namespaceId: 0 }),
        ]),
      );
    });

    it('applies metadata references without accepting inline profile content', async () => {
      const db = await webdb.openForUser('1');
      await seedThread(webdb,
        createGroupConversation(90, {
          id: 90,
          name: 'Team',
          account: '!team',
        }),
      );
      await webdb.commitResolvedProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        rev: 1,
        name: 'Alice',
        avatarBase64: null,
        bio: '',
      });
      await webdb.putSyncState('stateFeedId', 98);
      await expect(
        webdb.applyGroupMetaPage({
          threadId: 90,
          sourceServer: 'local',
          namespaceId: 0,
          page: {
            account: '!team',
            mode: 'delta',
            scannedThrough: '2',
            groupMetaFeedEndId: '2',
            hasMore: false,
            items: [
              {
                feedId: '1',
                operation: 'MEMBER_UPSERT',
                account: 'bob',
                domain: 'local',
                namespaceId: 0,
                body: { role: 'MEMBER', profileRev: 1 },
              },
              {
                feedId: '2',
                operation: 'MEMBER_UPSERT',
                account: 'alice',
                domain: 'local',
                namespaceId: 0,
                body: {
                  role: 'ADMIN',
                  profileRev: 1,
                  ...{ displayName: 'Conflicting name', profileResolved: true },
                },
              },
            ],
          },
        }),
      ).resolves.toBeUndefined();
      expect(await db!.getAll('members')).toHaveLength(2);
      expect(await webdb.getSyncState('stateFeedId')).toBe(98);
      expect(
        await webdb.getProfile({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          profileRev: 1,
        }),
      ).toMatchObject({ name: 'Alice' });
    });

    it('distinguishes tombstones from missing bodies and scopes them to the thread', async () => {
      await webdb.openForUser('1');
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
      const db = await webdb.messageDb();
      await db.put('messages', {
        threadId: 42,
        seq: 5,
        isDeleted: false,
        content: 'body',
      } as Message);
      await db.put('messages', {
        threadId: 42,
        seq: 6,
        isDeleted: true,
        contentType: 'TOMB',
        deletionType: 'MODERATION_REMOVAL',
      });
      expect(await webdb.getDeletedMessageSeqs(42, [4, 4, 5, 6, 7])).toEqual([
        4, 6,
      ]);
      expect(await webdb.getDeletedMessageSeqs(99, [4, 6])).toEqual([]);
      expect(await webdb.getDeletedMessageSeqs(42, [])).toEqual([]);
    });

    it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
      'merges deletion and message arrival orders without retaining bodies: %s',
      async (type) => {
        await webdb.openForUser('1');
        const message: Message = {
          threadId: 42,
          seq: 4,
          creator: { account: 'alice', domain: 'example.test', namespaceId: 1 },
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
        const db = await webdb.messageDb();
        expect(await db.get('messages', [42, 4])).toEqual(
          messageTomb(message, type),
        );
        expect(await db.get('messages', [42, 5])).toEqual(
          messageTomb(later, type),
        );
        expect(await webdb.getMessage(42, 4)).toBeUndefined();
        expect(await webdb.getMessage(42, 5)).toBeUndefined();
        expect(await webdb.getDeletedMessageSeqs(42, [4, 5])).toEqual([4, 5]);
      },
    );

    it('commits identified tombs as timeline slots without exposing deleted bodies', async () => {
      await webdb.openForUser('1');
      const message: Message = {
        threadId: 42,
        seq: 4,
        creator: { account: 'alice', domain: 'example.test', namespaceId: 1 },
        profileRev: 3,
        createdAt: 100,
        updatedAt: 101,
        contentType: 'PURE_TEXT',
        content: 'private body',
        isDeleted: false,
        localState: 'READY',
      };
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
      const tomb = messageTomb({ ...message, seq: 5 }, 'MODERATION_REMOVAL');
      const live = { ...message, seq: 6 };
      const committed = await webdb.commitBrowserMessagePage({
        threadId: 42,
        scan: { left: 3, right: 6 },
        messages: [message, tomb, live],
        gaps: [],
        knownNewestSeq: 6,
      });
      expect(committed.messages).toEqual([
        messageTomb(message, 'USER_RETRACTION'),
        tomb,
        live,
      ]);
      expect(await webdb.queryCachedMessages(42, 'asc', 10)).toEqual(
        committed.messages,
      );
      const db = await webdb.messageDb();
      expect(await db.get('messages', [42, 4])).toEqual(
        messageTomb(message, 'USER_RETRACTION'),
      );
      expect(await db.get('messages', [42, 5])).toEqual(tomb);
      expect(await webdb.getDeletedMessageSeqs(42, [4, 5, 6])).toEqual([4, 5]);
    });

    it('counts known unread slots including tombs but not own messages, unknown markers, or gaps', async () => {
      await webdb.openForUser('1');
      const owner = { account: 'me', domain: 'example.test', namespaceId: 0 };
      const base: Message = {
        threadId: 42,
        seq: 1,
        creator: { account: 'other', domain: 'peer.test', namespaceId: 2 },
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
        messageTomb({ ...base, seq: 3 }, 'USER_RETRACTION'),
        { ...base, seq: 4, creator: owner },
        messageTomb({ ...base, seq: 5, creator: owner }, 'MODERATION_REMOVAL'),
        {
          ...base,
          seq: 6,
          creator: { account: '$system', domain: 'local', namespaceId: 0 },
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
      expect(await webdb.countUnreadMessageSlots(42, 0, 11, owner)).toBe(6);
      expect(await webdb.countUnreadMessageSlots(42, 1, 3, owner)).toBe(1);
      expect(await webdb.countUnreadMessageSlots(42, 3, 7, owner)).toBe(1);
      expect(await webdb.countUnreadMessageSlots(42, 7, 7, owner)).toBe(0);
      const snapshot = {
        ...threadStructure(42, {
          authorityNamespaceId: 2,
          profile: { account: 'other', domain: 'peer.test', namespaceId: 2, profileRev: 0 },
        }),
        threadId: 42,
        threadFeedId: 1,
        messageEndSeq: 11,
        tombstoneEndSeq: 1,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
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
          unreadCount: 4,
          hasUnreadMention: false,
        });
      }
      await webdb.putCachedMessages([{ ...base, seq: 7 }]);
      expect(await webdb.countUnreadMessageSlots(42, 0, 11, owner)).toBe(7);
      await expect(
        webdb.countUnreadMessageSlots(42, 5, 4, owner),
      ).rejects.toThrow('Invalid unread');
    });

    it('keeps a system profile correction local to its row across cache refills', async () => {
      await webdb.openForUser('1');
      const message: Message = {
        threadId: 42,
        seq: 1,
        creator: { account: '$system', domain: 'local', namespaceId: 0 },
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
        await webdb.correctSystemMessageProfile(42, 1, 'alice', 'peer.test', 2),
      ).toBe(true);
      expect(
        await webdb.correctSystemMessageProfile(42, 1, 'alice', 'peer.test', 2),
      ).toBe(false);
      await webdb.putCachedMessages([message, { ...message, seq: 2 }]);
      expect(await webdb.getMessage(42, 1)).toMatchObject({
        localSystemProfileRevs: { '["alice","peer.test"]': 2 },
      });
      expect(await webdb.getMessage(42, 2)).not.toHaveProperty(
        'localSystemProfileRevs',
      );
      await webdb.putCachedMessages([
        { ...message, content: '{"type":"GROUP_LEFT"}' },
      ]);
      expect(await webdb.getMessage(42, 1)).not.toHaveProperty(
        'localSystemProfileRevs',
      );
    });

    it('does not cap unread slot counts at 100', async () => {
      await webdb.openForUser('1');
      await webdb.putCachedMessages(
        Array.from(
          { length: 120 },
          (_, i): Message => ({
            threadId: 42,
            seq: i + 1,
            creator: { account: '$system', domain: 'local', namespaceId: 0 },
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
          domain: 'local',
          namespaceId: 0,
        }),
      ).toBe(120);
    });

    it('opens separate per-user core and message DBs and signals ready', async () => {
      const db = await webdb.openForUser('1');
      expect(db, 'opened handle').toBeTruthy();
      expect(db!.name, 'per-user partition key').toBe('soms-webdb-u1');
      expect([...db!.objectStoreNames].sort()).toEqual([
        'members',
        'meta',
        'namespaces',
        'profileAvatarBlobs',
        'profileNamespaces',
        'profiles',
        'relationshipRequests',
        'syncState',
        'threadPreviews',
        'threads',
      ]);
      const messageDb = await webdb.messageDb();
      expect(messageDb.name).toBe('soms-msgdb-u1');
      expect([...messageDb.objectStoreNames].sort()).toEqual([
        'messageRanges',
        'messages',
        'meta',
        'threadSyncState',
      ]);
      expect((await messageDb.get('meta', 'schemaVersion'))?.value).toBe(
        MESSAGE_CACHE_SCHEMA_VERSION,
      );
      expect(await webdb.getMeta('schemaVersion')).toBe(CACHE_SCHEMA_VERSION);
      expect(webdb.ready()).toBe(true);
    });

    it('rebuilds the old cache version instead of migrating dismissal metadata', async () => {
      const db = await webdb.openForUser('1');
      await webdb.putMeta('threadHwms', { 7: 9 });
      await webdb.putMeta('stateFeedCursor', 42);
      await db!.put('meta', {
        key: 'schemaVersion',
        value: CACHE_SCHEMA_VERSION - 1,
      });
      await webdb.close();
      await webdb.openForUser('1');
      expect(await webdb.getMeta('threadHwms')).toBeUndefined();
      expect(await webdb.getMeta('stateFeedCursor')).toBeUndefined();
      expect(await webdb.getMeta('schemaVersion')).toBe(CACHE_SCHEMA_VERSION);
    });

    it('strict startup open does not create missing databases', async () => {
      await expect(webdb.openExistingForUser('1')).rejects.toThrow();

      const names = (await indexedDB.databases()).map(
        (database) => database.name,
      );
      expect(names).not.toContain('soms-webdb-u1');
      expect(names).not.toContain('soms-msgdb-u1');
      expect(webdb.ready()).toBe(false);
    });

    it('strict startup open preserves an existing valid cache', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('sentinel', 'kept');
      await webdb.close();

      await webdb.openExistingForUser('1');

      expect(await webdb.getMeta('sentinel')).toBe('kept');
    });

    it('strict startup open reports a version mismatch without deleting the cache', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('schemaVersion', 99);
      await webdb.putMeta('sentinel', 'still-present');
      await webdb.close();

      await expect(webdb.openExistingForUser('1')).rejects.toThrowError(
        LocalCacheVersionMismatchError,
      );
      const raw = await openDB('soms-webdb-u1');
      expect((await raw.get('meta', 'sentinel')).value).toBe(
        'still-present',
      );
      raw.close();
    });

    it('drops and reinitializes a cache whose stable metadata version is not current', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('schemaVersion', 99);
      await webdb.putMeta('sentinel', 'old-cache');
      await webdb.close();

      await webdb.openForUser('1');

      expect(await webdb.getMeta('schemaVersion')).toBe(CACHE_SCHEMA_VERSION);
      expect(await webdb.getMeta('sentinel')).toBeUndefined();
    });

    it('counts only cached message rows', async () => {
      await webdb.openForUser('1');
      await webdb.putCachedMessages([
        { threadId: 7, seq: 1 } as Message,
        { threadId: 7, seq: 2 } as Message,
        { threadId: 9, seq: 1 } as Message,
      ]);

      expect(await webdb.countCachedMessages()).toBe(3);
    });

    it('atomically commits messages and canonical explicit ranges', async () => {
      await webdb.openForUser('1');
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

    it('serializes complete page commits for one thread before opening either transaction', async () => {
      await webdb.openForUser('1');
      const liveDb = await webdb.messageDb();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const messageDb = vi
        .spyOn(webdb, 'messageDb')
        .mockImplementation(async () => {
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
      expect(calls).toBe(1);

      release();
      await Promise.all([first, second]);
      expect(calls).toBe(2);
      messageDb.mockRestore();
      expect(await webdb.getMessageRanges(7)).toEqual([
        { threadId: 7, left: 0, right: 2, state: 'LOCAL_COVERED' },
      ]);
    });

    it('deletes one thread messages, ranges, and head without touching another thread', async () => {
      await webdb.openForUser('1');
      for (const threadId of [7, 8]) {
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
      expect((await webdb.getMessage(8, 1))?.seq).toBe(1);
      expect(await webdb.getMessageRanges(8)).toHaveLength(1);
    });

    it('closeAndDelete physically removes the database (per-user wipe)', async () => {
      await webdb.openForUser('1');
      const snapshot = await webdb.commitResolvedProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
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
    // currentUserId stayed '1' and db() would silently re-create soms-webdb-u1.
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
      expect(names).not.toContain('soms-webdb-u1');
      expect(names).not.toContain('soms-msgdb-u1');
    });

    it('full recreation blocks new core operations and waits for an admitted core read', async () => {
      await webdb.openForUser('1');
      await webdb.mergeThreadStates([threadFeedSnapshot(7, { profile: peerProfile })]);
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

      await expect(
        webdb.putThread({
          threadId: 8,
          authorityNamespaceId: 0,
          type: 'P2P',
        } as never),
      ).rejects.toThrowError('account cache lifetime expired');
      expect(recreated).toBe(false);

      release();
      await read;
      dbSpy.mockRestore();
      await recreate;

      expect(recreated).toBe(true);
      expect(await webdb.getThreads()).toEqual([]);
    });

    for (const kind of ['P2P', 'GROUP'] as const) {
      it(`restores an established revoked ${kind} as read-only on an empty device`, async () => {
        await webdb.openForUser('1');
        const event = (
          established: boolean,
          feedId: number,
        ): ClientStateFeedItem =>
          ({
            feedId,
            namespaceId: 0,
            eventType: 'RELATIONSHIP_INTENT',
            account: kind === 'GROUP' ? '!history' : 'alice',
            domain: 'local',
            subjectAccount: 'bob',
            subjectNamespaceId: 0,
            body: {
              status: 'REVOKED',
              established,
              note: '',
              requestedAt: null,
              expiresAt: null,
              ...(kind === 'GROUP'
                ? {
                    threadId: 77,
                    group: {
                      account: '!history',
                      domain: 'local',
                      namespaceId: 0,
                      name: 'History',
                      avatar: '',
                      description: '',
                      profileRev: 0,
                    },
                  }
                : {
                    localThreadId: 77,
                    direction: 'INCOMING',
                    peer: {
                      account: 'alice',
                      domain: 'local',
                      name: 'Alice',
                      avatar: '',
                      bio: '',
                      profileRev: 0,
                    },
                  }),
            },
          }) as ClientStateFeedItem;
        await webdb.applyStateFeedPage([event(false, 1)], 1);
        expect(await webdb.getThreads()).toEqual([]);
        await webdb.applyStateFeedPage([event(true, 2)], 2);
        expect(await webdb.getThreads()).toEqual([]);
        await webdb.mergeThreadStates([
          threadFeedSnapshot(77, {
            threadFeedId: 3,
            type: kind,
            conversationState: 'READ_ONLY',
            profile: {
              account: kind === 'GROUP' ? '!history' : 'alice',
              domain: 'local', namespaceId: 0, profileRev: 0,
            },
          }),
        ], 3);
        expect(await webdb.getThreads()).toEqual([
          expect.objectContaining({
            threadId: 77,
            type: kind,
            conversationState: 'READ_ONLY',
          }),
        ]);
        // An older opposite-direction fact cannot erase established history.
        await webdb.applyStateFeedPage([event(false, 4)], 4);
        expect(await webdb.getThreads()).toEqual([
          expect.objectContaining({
            threadId: 77,
            conversationState: 'READ_ONLY',
          }),
        ]);
      });
    }

    it('atomically advances the state-feed cursor and derives P2P read-only state', async () => {
      await webdb.openForUser('1');
      const revoked: ClientStateFeedItem = {
        feedId: 12,
        namespaceId: 12,
        account: 'alice',
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'bob',
        subjectNamespaceId: 12,
        body: {
          status: 'REQUESTED',
          note: '',
          requestedAt: null,
          expiresAt: null,
          direction: 'OUTGOING',
          localThreadId: 7,
          peer: {
            id: 2,
            account: 'bob',
            name: 'Bob',
            avatar: '',
            bio: '',
            domain: 'peer.test',
          },
        },
      };

      await webdb.applyStateFeedPage([revoked], 12);
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          threadFeedId: 13, conversationState: 'READ_ONLY', blocked: true,
          profile: peerProfile,
        }),
      ], 13);

      expect(await webdb.getSyncState('stateFeedId')).toBe(12);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 7),
      ).toMatchObject({
        friendshipActive: false,
        conversationState: 'READ_ONLY',
      });
    });

    it('keeps bilateral intents out of the thread list until the complete thread snapshot arrives', async () => {
      await webdb.openForUser('1');
      const peer = {
        namespaceId: 0,
        id: 2,
        account: 'bob',
        name: 'Bob',
        avatar: '',
        bio: '',
        domain: 'local',
      };
      const items: ClientStateFeedItem[] = [
        {
          feedId: 20,
          namespaceId: 0,
          account: 'alice',
          domain: 'local',
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: 'bob',
          subjectNamespaceId: 0,
          body: {
            status: 'ACCEPTED',
            note: '',
            requestedAt: 1,
            expiresAt: null,
            direction: 'OUTGOING',
            localThreadId: 7,
            peer,
          },
        },
        {
          feedId: 21,
          namespaceId: 0,
          account: 'bob',
          domain: 'local',
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: 'alice',
          subjectNamespaceId: 0,
          body: {
            status: 'ACCEPTED',
            note: '',
            requestedAt: 1,
            expiresAt: null,
            direction: 'INCOMING',
            localThreadId: 7,
            peer,
          },
        },
      ];

      await webdb.applyStateFeedPage(items, 21);
      expect(await webdb.getThreads()).toEqual([]);
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, {
          threadFeedId: 22,
          profile: { account: 'bob', domain: 'local', namespaceId: 0, profileRev: 1 },
        }),
      ], 22);

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 7,
          type: 'P2P',
          friendshipActive: true,
          conversationState: 'ACTIVE',
          peerUser: expect.objectContaining({
            account: 'bob',
            domain: 'local',
          }),
        }),
      ]);
      expect(await webdb.getSyncState('stateFeedId')).toBe(21);
    });

    it.each(['WITHDRAWN', 'REJECTED'] as const)(
      'retains a group request outcome %s after reopening storage and convergence replay',
      async (requestStatus) => {
        const db = await webdb.openForUser('1');
        const now = Date.now();
        const group = {
          account: '!group',
          domain: 'local',
          namespaceId: 0,
          name: 'Group',
          avatar: '',
          description: '',
          profileRev: 1,
        };
        const request: ClientStateFeedItem = {
          feedId: 1,
          namespaceId: 0,
          account: 'me',
          domain: 'local',
          subjectAccount: '!group',
          subjectNamespaceId: 0,
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REQUESTED',
            direction: 'OUTGOING',
            requestedAt: now,
            expiresAt: now + 60_000,
            note: '',
            threadId: 7,
            group,
          },
        };
        await webdb.applyStateFeedPage([request], 1);
        const outcome: ClientStateFeedItem = {
          ...request,
          feedId: 2,
          account: '!group',
          subjectAccount: 'me',
          body: {
            ...request.body,
            status: 'REVOKED',
            direction: 'INCOMING',
            requestStatus,
            requestDirection: 'OUTGOING',
          },
        };
        await webdb.applyStateFeedPage([outcome], 2);
        expect((await db!.getAll('relationshipRequests'))[0].status).toBe(
          requestStatus,
        );
        await webdb.close();
        await webdb.openForUser('1');
        await webdb.applyStateFeedPage(
          [
            {
              ...request,
              feedId: 3,
              body: { ...request.body, status: 'REVOKED' },
            },
          ],
          3,
        );
        const page = await webdb.getRelationshipRequestPage('SENT', null, 20);
        expect(page.items[0].status).toBe(requestStatus);
        await webdb.applyStateFeedPage(
          [
            {
              ...request,
              feedId: 4,
              body: { ...request.body, requestedAt: now + 1 },
            },
          ],
          4,
        );
        expect(
          (await webdb.getRelationshipRequestPage('SENT', null, 20)).items[0]
            .status,
        ).toBe('REQUESTED');
      },
    );

    it('keeps accepted sent history and makes accepted received history non-actionable', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const peer = {
        namespaceId: 12,
        id: 2,
        account: 'admin',
        name: 'admin',
        avatar: '',
        bio: '',
        domain: 'bravo.test',
      };
      const event = (
        feedId: number,
        direction: 'INCOMING' | 'OUTGOING',
        status: 'REQUESTED' | 'ACCEPTED',
      ): ClientStateFeedItem => ({
        feedId,
        namespaceId: 12,
        account: direction === 'OUTGOING' ? 'bravo' : 'admin',
        domain: direction === 'OUTGOING' ? 'local' : 'bravo.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: direction === 'OUTGOING' ? 'admin' : 'bravo',
        subjectNamespaceId: direction === 'OUTGOING' ? 12 : 0,
        body: {
          status,
          note: '',
          requestedAt: status === 'REQUESTED' ? requestedAt : null,
          expiresAt: status === 'REQUESTED' ? requestedAt + 60_000 : null,
          direction,
          localThreadId: status === 'ACCEPTED' ? 7 : null,
          peer,
        },
      });

      await webdb.applyStateFeedPage([event(30, 'OUTGOING', 'REQUESTED')], 30);
      await webdb.applyStateFeedPage(
        [event(31, 'INCOMING', 'ACCEPTED'), event(32, 'OUTGOING', 'ACCEPTED')],
        32,
      );

      expect(await db!.getAll('relationshipRequests')).toHaveLength(1);
      expect(
        await webdb.getRelationshipRequestPage('SENT', null, 20),
      ).toMatchObject({
        total: 1,
        actionableTotal: 1,
        items: [expect.objectContaining({ status: 'ACCEPTED' })],
      });
    });

    it('settles both pending group request directions on a group-authored acceptance', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const group = {
        namespaceId: 0,
        account: '!group',
        domain: 'local',
        name: 'Group',
        avatar: '',
        description: '',
        profileRev: 1,
      };
      const event = (
        feedId: number,
        direction: 'INCOMING' | 'OUTGOING',
        status: 'REQUESTED' | 'ACCEPTED',
      ): ClientStateFeedItem => ({
        feedId,
        namespaceId: 0,
        eventType: 'RELATIONSHIP_INTENT',
        account: direction === 'INCOMING' ? '!group' : 'me',
        domain: 'local',
        subjectAccount: direction === 'INCOMING' ? 'me' : '!group',
        subjectNamespaceId: 0,
        body: {
          status,
          note: '',
          requestedAt,
          expiresAt: status === 'REQUESTED' ? requestedAt + 60_000 : null,
          threadId: 8,
          group,
        },
      });

      await webdb.applyStateFeedPage(
        [
          event(20, 'INCOMING', 'REQUESTED'),
          event(21, 'OUTGOING', 'REQUESTED'),
        ],
        21,
      );
      await webdb.applyStateFeedPage([event(22, 'INCOMING', 'ACCEPTED')], 22);

      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({ direction: 'INCOMING', status: 'ACCEPTED' }),
        expect.objectContaining({ direction: 'OUTGOING', status: 'ACCEPTED' }),
      ]);
      expect(
        await webdb.getRelationshipRequestPage('RECEIVED', null, 20),
      ).toMatchObject({ total: 1, actionableTotal: 0 });
      await webdb.applyStateFeedPage(
        [event(23, 'INCOMING', 'ACCEPTED')],
        23,
      );
      expect(await db!.getAll('relationshipRequests')).toHaveLength(2);
    });

    it('persists a successful local accept on the existing received projection', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      await webdb.applyStateFeedPage(
        [
          {
            feedId: 40,
            namespaceId: 12,
            account: 'alice',
            domain: 'peer.test',
            eventType: 'RELATIONSHIP_INTENT',
            subjectAccount: 'me',
            subjectNamespaceId: 0,
            body: {
              status: 'REQUESTED',
              note: '',
              requestedAt,
              expiresAt: requestedAt + 60_000,
              direction: 'INCOMING',
              localThreadId: null,
              peer: {
                id: 2,
                account: 'alice',
                name: 'Alice',
                avatar: '',
                bio: '',
                domain: 'peer.test',
              },
            },
          },
        ],
        40,
      );
      const [projection] = await db!.getAll('relationshipRequests');
      await webdb.markRelationshipRequestAccepted(projection.key);
      expect(
        await db!.get('relationshipRequests', projection.key),
      ).toMatchObject({
        bucket: 'RECEIVED',
        direction: 'INCOMING',
        status: 'ACCEPTED',
      });
      expect(
        await webdb.getRelationshipRequestPage('RECEIVED', null, 20),
      ).toMatchObject({ total: 1, actionableTotal: 0 });
    });

    it('does not advance the unread badge revision when an incoming request is rejected', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const expiresAt = Date.now() + 60_000;
      const event = (
        feedId: number,
        direction: 'INCOMING' | 'OUTGOING',
        status: 'REQUESTED' | 'REVOKED',
      ): ClientStateFeedItem => ({
        feedId,
        namespaceId: 12,
        account: direction === 'INCOMING' ? 'alice' : 'me',
        domain: direction === 'INCOMING' ? 'peer.test' : 'local.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: direction === 'INCOMING' ? 'me' : 'alice',
        subjectNamespaceId: direction === 'INCOMING' ? 0 : 12,
        body: {
          status,
          ...(status === 'REVOKED'
            ? {
                requestStatus: 'REJECTED' as const,
                requestDirection: 'INCOMING' as const,
              }
            : {}),
          note: 'hello',
          requestedAt: status === 'REQUESTED' ? requestedAt : null,
          expiresAt: status === 'REQUESTED' ? expiresAt : null,
          direction,
          localThreadId: 7,
          peer: {
            id: 2,
            account: 'alice',
            name: 'Alice',
            avatar: '',
            bio: 'About Alice',
            domain: 'peer.test',
          },
        },
      });

      await webdb.applyStateFeedPage([event(10, 'INCOMING', 'REQUESTED')], 10);
      expect(await webdb.getSyncState('relationshipRequestStateRevision')).toBe(10);
      expect(
        await webdb.getRelationshipRequestPage('RECEIVED', null, 20),
      ).toMatchObject({ total: 1, actionableTotal: 1 });

      await webdb.applyStateFeedPage([event(11, 'OUTGOING', 'REVOKED')], 11);
      expect(await webdb.getSyncState('relationshipRequestStateRevision')).toBe(10);
      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          bucket: 'RECEIVED',
          status: 'REJECTED',
          requestedSort: requestedAt,
        }),
      ]);
      const rejectedPage = await webdb.getRelationshipRequestPage(
        'RECEIVED',
        null,
        20,
      );
      expect(rejectedPage).toMatchObject({ total: 1, actionableTotal: 0 });
      expect(rejectedPage.items).toEqual([
        expect.objectContaining({ bucket: 'RECEIVED', status: 'REJECTED' }),
      ]);
    });

    it('hydrates an existing incoming request when its profile-backed update arrives', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const expiresAt = requestedAt + 60_000;
      const incoming = (
        feedId: number,
        peer: { name: string; avatar: string },
      ): ClientStateFeedItem => ({
        feedId,
        namespaceId: 12,
        account: 'alice',
        domain: 'peer.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'me',
        subjectNamespaceId: 12,
        body: {
          status: 'REQUESTED',
          note: 'hello',
          requestedAt,
          expiresAt,
          direction: 'INCOMING',
          localThreadId: null,
          peer: {
            id: 0,
            account: 'alice',
            name: peer.name,
            avatar: peer.avatar,
            bio: '',
            domain: 'peer.test',
          },
        },
      });

      await webdb.applyStateFeedPage(
        [incoming(30, { name: 'alice', avatar: '' })],
        30,
      );
      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          status: 'REQUESTED',
          peer: expect.objectContaining({ name: 'alice', avatar: '' }),
        }),
      ]);

      await webdb.applyStateFeedPage(
        [incoming(31, { name: 'Alice', avatar: '/uploads/alice-512.webp' })],
        31,
      );

      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          status: 'REQUESTED',
          peer: expect.objectContaining({
            id: 0,
            name: 'Alice',
            avatar: '/uploads/alice-512.webp',
          }),
        }),
      ]);
      expect(await webdb.getSyncState('relationshipRequestStateRevision')).toBe(30);
      expect(await webdb.getSyncState('stateFeedId')).toBe(31);
    });

    it('garbage-collects an expired request projection without creating a User row', async () => {
      const db = await webdb.openForUser('1');
      const expiresAt = Date.now() + 1_000;
      const request: ClientStateFeedItem = {
        feedId: 20,
        namespaceId: 12,
        account: 'me',
        domain: 'local.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'alice',
        subjectNamespaceId: 12,
        body: {
          status: 'REQUESTED',
          note: 'hello',
          requestedAt: expiresAt - 1_000,
          expiresAt,
          direction: 'OUTGOING',
          localThreadId: 7,
          peer: {
            id: 2,
            account: 'alice',
            name: 'Alice',
            avatar: 'avatar.webp',
            bio: 'About Alice',
            domain: 'peer.test',
          },
        },
      };

      await webdb.applyStateFeedPage([request], 20);
      expect(await db!.getAll('relationshipRequests')).toHaveLength(1);
      expect(await db!.getAll('profiles')).toEqual([]);

      await webdb.cleanupRelationshipRequests(expiresAt);

      expect(await db!.getAll('relationshipRequests')).toHaveLength(1);
      expect(await db!.getAll('profiles')).toEqual([]);

      await webdb.cleanupRelationshipRequests(
        expiresAt + FRIEND_INTENT_RETENTION_MS,
      );
      expect(await db!.getAll('relationshipRequests')).toEqual([]);
    });

    it('garbage-collects an expired group invite without creating a Group row', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const expiresAt = requestedAt + 1_000;
      const invite: ClientStateFeedItem = {
        feedId: 21,
        namespaceId: 12,
        account: '!group',
        domain: 'groups.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'me',
        subjectNamespaceId: 12,
        body: {
          status: 'REQUESTED',
          note: 'join us',
          requestedAt,
          expiresAt,
          direction: 'INCOMING',
          threadId: 8,
          group: {
            namespaceId: 12,
            account: '!group',
            name: 'Group',
            avatar: 'group.webp',
            description: 'About group',
            profileRev: 2,
          },
        },
      };

      await webdb.applyStateFeedPage([invite], 21);
      expect(await db!.getAll('relationshipRequests')).toHaveLength(1);
      expect(await db!.getAll('profiles')).toEqual([]);

      await webdb.cleanupRelationshipRequests(expiresAt);

      expect(await db!.getAll('relationshipRequests')).toHaveLength(1);
      expect(await db!.getAll('profiles')).toEqual([]);

      await webdb.cleanupRelationshipRequests(
        expiresAt + FRIEND_INTENT_RETENTION_MS,
      );
      expect(await db!.getAll('relationshipRequests')).toEqual([]);
    });

    it('uses explicit OUTGOING direction for a legacy group-first federated key', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      await webdb.applyStateFeedPage(
        [
          {
            feedId: 22,
            namespaceId: 12,
            // Older federated writers used GROUP->MEMBER as the compaction key even for a
            // member-authored request. The body direction is the authoritative authored side.
            account: '!group',
            domain: 'groups.test',
            eventType: 'RELATIONSHIP_INTENT',
            subjectAccount: 'me',
            subjectNamespaceId: 12,
            body: {
              status: 'REQUESTED',
              note: 'let me in',
              requestedAt,
              expiresAt: requestedAt + 60_000,
              direction: 'OUTGOING',
              threadId: 8,
              group: {
                namespaceId: 12,
                account: '!group',
                name: 'Group',
                avatar: '',
                description: '',
                profileRev: 1,
              },
            },
          },
        ],
        22,
      );

      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          kind: 'GROUP',
          bucket: 'SENT',
          direction: 'OUTGOING',
          status: 'REQUESTED',
        }),
      ]);
    });

    it('rebuilds state-feed projections without resetting the independent group roster', async () => {
      const db = await webdb.openForUser('1');
      await webdb.mergeThreadStates([
        threadFeedSnapshot(7, { profile: peerProfile }),
        threadFeedSnapshot(9, { type: 'GROUP', role: 'OWNER', profile: {
          account: '!team', domain: 'local', namespaceId: 0, profileRev: 0,
        } }),
      ]);
      await db!.put('members', {
        threadId: 9,
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        profileRev: 1,
        role: 'MEMBER',
        left: false,
      });

      await webdb.applyStateFeedPage([], 3, true);

      expect(await db!.getAll('members')).toEqual([
        expect.objectContaining({ account: 'alice' }),
      ]);
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({ threadId: 7 }),
        expect.objectContaining({ threadId: 9 }),
      ]);

      await db!.put('members', {
        threadId: 9,
        namespaceId: 0,
        account: 'bob',
        domain: 'local',
        profileRev: 1,
        role: 'MEMBER',
        left: false,
      });
      await webdb.applyStateFeedPage([], 4);

      expect(await db!.getAll('members')).toHaveLength(2);
      expect(await webdb.getSyncState('stateFeedId')).toBe(4);
    });

    it('atomically creates the thread and attention from one complete feed snapshot', async () => {
      const db = await webdb.openForUser('1');
      const head = {
        ...threadStructure(9, { profile: peerProfile }),
        threadId: 9,
        threadFeedId: 4,
        messageEndSeq: 8,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 0,
        groupMetaFeedEndId: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 3,
        announcementReadFeedId: 0,
        unreadCount: 5,
        lastMentionSeq: null,
        previews: [],
      };
      await webdb.mergeThreadStates([head], 4);
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({ threadId: 9, threadFeedId: 4, visible: true }),
      ]);
      expect(await db!.get('threads', 9)).toMatchObject({ type: 'P2P' });
      expect(attentionSnapshot((await webdb.getThreadStates())[0])).toEqual(head);
      expect(await webdb.getSyncState('threadFeedCursor')).toBe(4);
      const invalid = threadFeedSnapshot(10, {
        threadFeedId: 7,
        profile: { account: 'peer', domain: 'local', namespaceId: -1, profileRev: 0 },
      });
      await expect(webdb.mergeThreadStates([
        threadFeedSnapshot(11, { threadFeedId: 6, profile: peerProfile }), invalid,
      ], 7)).rejects.toThrow();
      expect(await db!.get('threads', 11)).toBeUndefined();
      expect(await webdb.getSyncState('threadFeedCursor')).toBe(4);
    });

    it('applies block and unblock deltas from the thread feed', async () => {
      await webdb.openForUser('1');
      const event = (feedId: number, blocked: boolean) =>
        threadFeedSnapshot(7, {
          threadFeedId: feedId,
          blocked,
          profile: { account: 'peer', domain: 'local', namespaceId: 0, profileRev: 1 },
        });
      await webdb.mergeThreadStates([event(5, true)], 5);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: true });
      await webdb.mergeThreadStates([event(6, false)], 6);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: false });
      expect(await webdb.getSyncState('threadFeedCursor')).toBe(6);
    });

    it('optimistically activates only the greatest newly discovered namespace', async () => {
      await webdb.openForUser('1');
      await seedThread(webdb, createP2PConversation(7,
        { account: 'peer', domain: 'peer.test', namespaceId: 12, name: '' },
      ));
      await webdb.commitResolvedProfile({
        name: 'Old',
        account: 'old',
        avatarBase64: null,
        bio: '',
        domain: 'peer.test',
        namespaceId: 11,
        rev: 1,
      });
      await webdb.commitResolvedProfile({
        name: 'New',
        account: 'new',
        avatarBase64: null,
        bio: '',
        domain: 'peer.test',
        namespaceId: 13,
        rev: 1,
      });

      expect(await webdb.getNamespaces()).toContainEqual({
        domain: 'peer.test',
        namespaceId: 12,
        status: 'ARCHIVED',
      });
      expect(await webdb.getNamespaces()).toContainEqual({
        domain: 'peer.test',
        namespaceId: 11,
        status: 'ARCHIVED',
      });
      expect(await webdb.getNamespaces()).toContainEqual({
        domain: 'peer.test',
        namespaceId: 13,
        status: 'ACTIVE',
      });
    });

    it('archives a rejected namespace without reactivating a repeated fact', async () => {
      await webdb.openForUser('1');
      const thread = createP2PConversation(7,
        { account: 'peer', domain: 'peer.test', namespaceId: 12, name: '' },
        { threadFeedId: 1 },
      );
      await seedThread(webdb, thread);
      await webdb.archiveNamespace('peer.test', 12);
      await webdb.putThread(thread);

      expect(await webdb.getNamespaces()).toContainEqual({
        domain: 'peer.test',
        namespaceId: 12,
        status: 'ARCHIVED',
      });
      expect((await webdb.getThreads())[0]).toMatchObject({
        authorityNamespaceId: 12,
        conversationState: 'ACTIVE',
      });
    });

    it('commits compact member references and a group profile without treating the group profile as a member', async () => {
      await webdb.openForUser('1');
      const db = await webdb.db();
      await seedThread(webdb,
        createGroupConversation(9, {
          id: 9,
          account: '!team',
          domain: 'local',
          name: 'Old group name',
        }),
      );
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'full',
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
          items: [
            {
              feedId: '1',
              operation: 'GROUP_PROFILE',
              body: { profileRev: 4 },
            },
            {
              feedId: '2',
              operation: 'MEMBER_UPSERT',
              account: 'alice',
              domain: 'local',
              namespaceId: 0,
              body: { role: 'OWNER', profileRev: 2 },
            },
            {
              feedId: '3',
              operation: 'MEMBER_UPSERT',
              account: 'bob',
              domain: 'peer.test',
              namespaceId: 12,
              body: { role: 'MEMBER', profileRev: 5 },
            },
          ],
        },
      });
      expect((await webdb.getThreads())[0].profileRev).toBe(0);
      await webdb.mergeThreadStates([threadFeedSnapshot(9, {
        threadFeedId: 2, type: 'GROUP', role: 'OWNER',
        profile: { account: '!team', domain: 'local', namespaceId: 0, profileRev: 4 },
      })]);
      expect((await webdb.getThreads())[0].profileRev).toBe(4);
      expect(await db.get('threads', 9)).toMatchObject({ threadProfileRev: 4 });
      expect(await db.get('threads', 9)).not.toHaveProperty('group');
      expect(await db.get('threads', 9)).toMatchObject({
        subjectName: 'Old group name',
        groupMemberCount: 2,
        groupMetaFeedId: '3',
      });
      expect(await webdb.getSyncState('stateFeedId')).toBeUndefined();
      const members = await webdb.queryGroupMembers({ threadId: 9, take: 20 });
      expect(members).toHaveLength(2);
      expect(members.find((member) => member.account === 'bob')).toMatchObject({
        namespaceId: 12,
        profileRev: 5,
        user: { name: 'bob', profileRev: 5 },
      });
      expect(
        members.every((member) => member.resolvedProfileRev === undefined),
      ).toBe(true);
    });

    it('commits announcement publish, clear and clipped full recovery as distinct states', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      await webdb.putThread(
        createGroupConversation(9, {
          id: 9,
          account: '!team',
          domain: 'local',
          name: 'Team',
        }),
      );
      const page = (
        mode: 'full' | 'delta',
        scannedThrough: string,
        items: Array<{
          feedId: string;
          operation: 'GROUP_ANNOUNCEMENT';
          body: { text: string | null };
        }>,
      ) => ({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode,
          items,
          scannedThrough,
          groupMetaFeedEndId: scannedThrough,
          hasMore: false,
        },
      });
      await webdb.applyGroupMetaPage(
        page('full', '2', [
          {
            feedId: '2',
            operation: 'GROUP_ANNOUNCEMENT',
            body: { text: 'Hello' },
          },
        ]),
      );
      expect((await webdb.getThreads())[0].group?.announcement).toEqual({
        feedId: '2',
        text: 'Hello',
      });
      await webdb.applyGroupMetaPage(
        page('delta', '4', [
          {
            feedId: '4',
            operation: 'GROUP_ANNOUNCEMENT',
            body: { text: null },
          },
        ]),
      );
      expect((await webdb.getThreads())[0].group?.announcement).toEqual({
        feedId: '4',
        text: null,
      });
      await webdb.applyGroupMetaPage(page('full', '5', []));
      expect((await webdb.getThreads())[0].group?.announcement).toBeNull();
    });

    it('stages an announcement across full pages until the fixed recovery boundary', async () => {
      await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      await webdb.putThread(
        createGroupConversation(9, {
          id: 9,
          account: '!team',
          domain: 'local',
          name: 'Team',
        }),
      );
      await webdb.beginGroupMetaRecovery(9, '3');
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'full',
          scannedThrough: '1',
          groupMetaFeedEndId: '3',
          hasMore: true,
          items: [
            {
              feedId: '1',
              operation: 'GROUP_ANNOUNCEMENT',
              body: { text: 'Notice' },
            },
          ],
        },
      });
      expect((await webdb.getThreads())[0].group?.announcement).toBeNull();
      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'full',
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
          items: [],
        },
      });
      expect((await webdb.getThreads())[0].group?.announcement).toEqual({
        feedId: '1',
        text: 'Notice',
      });
    });

    it('materializes full group metadata and pages/searches the local roster', async () => {
      const db = await webdb.openForUser('1');
      await seedGroupFeed(webdb);
      await webdb.putThread({
        threadId: 9,
        authorityNamespaceId: 0,
        type: 'GROUP',
        group: {
          account: '!team',
          domain: 'local',
          namespaceId: 0,
          memberCount: 0,
          groupMetaFeedId: '0',
        },
      } as never);
      await webdb.commitResolvedProfile({
        name: 'Alice',
        account: 'alice',
        avatarBase64: 'YQ==',
        bio: 'About Alice',
        domain: 'home.example',
        namespaceId: 12,
        rev: 6,
      });
      await webdb.commitResolvedProfile({
        name: 'Self',
        account: 'self',
        avatarBase64: null,
        bio: '',
        domain: 'local',
        namespaceId: 0,
        rev: 1,
      });

      await webdb.putMeta('selfIdentity', { account: 'self', domain: 'local' });

      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'full',
          items: [
            {
              feedId: '1',
              operation: 'MEMBER_UPSERT',
              account: 'self',
              domain: 'local',
              namespaceId: 0,
              body: {
                role: 'OWNER',
                profileRev: 1,
              },
            },
            {
              feedId: '2',
              operation: 'MEMBER_UPSERT',
              account: 'alice',
              domain: 'home.example',
              namespaceId: 12,
              body: {
                role: 'ADMIN',
                profileRev: 6,
              },
            },
          ],
          hasMore: false,
          scannedThrough: '2',
          groupMetaFeedEndId: '2',
        },
      });

      expect(
        await webdb.queryGroupMembers({
          threadId: 9,
          take: 20,
          search: 'ali',
        }),
      ).toEqual([
        expect.objectContaining({
          account: 'alice',
          domain: 'home.example',
          user: expect.objectContaining({ name: 'Alice' }),
        }),
      ]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({
        role: 'OWNER',
        group: { memberCount: 2, groupMetaFeedId: '2' },
      });

      const metaEvidence = {
        type: 'GROUP_META' as const,
        threadId: 9,
        profileRev: 6,
        subject: {
          type: 'MEMBER' as const,
          account: 'alice',
          domain: 'home.example',
        },
      };
      const actual = {
        namespaceId: 12,
        account: 'alice',
        domain: 'home.example',
        rev: 7,
      };
      expect(await webdb.applyGroupMetaProfileDrift(metaEvidence, actual)).toBe(
        true,
      );
      expect(
        await webdb.getGroupMember(9, 'alice', 'home.example', 12),
      ).toMatchObject({ profileRev: 7, profileMessageSeq: null });
      expect(await webdb.applyGroupMetaProfileDrift(metaEvidence, actual)).toBe(
        false,
      );

      expect(
        await webdb.recordGroupMemberMessageProfile(
          9,
          {
            account: 'alice',
            domain: 'home.example',
            namespaceId: 12,
          },
          3,
          20,
        ),
      ).toBe(true);
      expect(
        await webdb.recordGroupMemberMessageProfile(
          9,
          {
            account: 'alice',
            domain: 'home.example',
            namespaceId: 12,
          },
          9,
          19,
        ),
      ).toBe(false);
      expect(
        await webdb.commitResolvedGroupMetaProfile(
          {
            type: 'GROUP_MEMBER',
            threadId: 9,
            rev: 3,
            account: 'alice',
            domain: 'home.example',
            namespaceId: 12,
          },
          {
            rev: 3,
            name: 'Alice in team',
            avatarBase64: 'YWJj',
            bio: 'Team',
            account: 'alice',
            domain: 'home.example',
            namespaceId: 12,
          },
        ),
      ).toBe(true);
      expect(
        await webdb.getGroupMember(9, 'alice', 'home.example', 12),
      ).toMatchObject({
        profileRev: 3,
        profileMessageSeq: 20,
        resolvedProfileRev: 3,
        profileName: 'Alice in team',
        profileBio: 'Team',
      });

      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'delta',
          items: [
            {
              feedId: '3',
              operation: 'MEMBER_UPSERT',
              account: 'alice',
              domain: 'home.example',
              namespaceId: 12,
              body: { role: 'MEMBER', profileRev: 6 },
            },
          ],
          hasMore: false,
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
        },
      });
      expect(
        await webdb.getGroupMember(9, 'alice', 'home.example', 12),
      ).toMatchObject({ profileRev: 3, profileMessageSeq: 20, role: 'MEMBER' });
      expect(
        await webdb.applyGroupMetaProfileDrift(
          { ...metaEvidence, profileRev: 3 },
          actual,
        ),
      ).toBe(false);

      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'delta',
          items: [
            {
              feedId: '4',
              operation: 'MEMBER_UPSERT',
              account: 'self',
              domain: 'local',
              namespaceId: 0,
              body: {
                role: 'ADMIN',
                profileRev: 1,
              },
            },
          ],
          hasMore: false,
          scannedThrough: '4',
          groupMetaFeedEndId: '4',
        },
      });
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: 'OWNER' });
      await webdb.mergeThreadStates([threadFeedSnapshot(9, {
        threadFeedId: 2, type: 'GROUP', role: 'ADMIN',
        profile: { account: '!team', domain: 'local', namespaceId: 0, profileRev: 0 },
      })]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: 'ADMIN' });

      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'delta',
          items: [
            {
              feedId: '5',
              operation: 'MEMBER_DEPART',
              account: 'self',
              domain: 'local',
              namespaceId: 0,
              body: {},
            },
          ],
          hasMore: false,
          scannedThrough: '5',
          groupMetaFeedEndId: '5',
        },
      });
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: 'ADMIN' });
      await webdb.mergeThreadStates([threadFeedSnapshot(9, {
        threadFeedId: 3, type: 'GROUP', role: null,
        profile: { account: '!team', domain: 'local', namespaceId: 0, profileRev: 0 },
      })]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: null });

      await webdb.applyGroupMetaPage({
        threadId: 9,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!team',
          mode: 'delta',
          items: [
            {
              feedId: '6',
              operation: 'MEMBER_DEPART',
              account: 'alice',
              domain: 'home.example',
              namespaceId: 12,
              body: {},
            },
          ],
          hasMore: false,
          scannedThrough: '6',
          groupMetaFeedEndId: '6',
        },
      });
      expect(
        await webdb.getProfile({
          account: 'alice',
          domain: 'home.example',
          namespaceId: 12,
          profileRev: 3,
        }),
      ).toBeDefined();
    });

    it('materializes a group from the complete thread snapshot before background meta commits', async () => {
      await webdb.openForUser('1');
      await webdb.commitResolvedProfile({
        name: 'Bob',
        account: 'bob',
        avatarBase64: null,
        bio: '',
        domain: 'remote.test',
        namespaceId: 12,
        rev: 1,
      });
      await webdb.commitResolvedProfile({
        name: '!dev',
        account: '!dev',
        avatarBase64: null,
        bio: '',
        domain: 'local',
        namespaceId: 0,
        rev: 1,
      });
      const group = {
        account: '!dev',
        domain: 'local',
        namespaceId: 0,
        name: '!dev',
        avatar: '',
        description: '',
        profileRev: 1,
      };
      const common = {
        eventType: 'RELATIONSHIP_INTENT' as const,
        body: {
          status: 'ACCEPTED' as const,
          note: '',
          requestedAt: null,
          expiresAt: null,
          threadId: 12,
          group,
        },
      };
      const items: ClientStateFeedItem[] = [
        {
          ...common,
          feedId: 1,
          namespaceId: 0,
          account: '!dev',
          domain: 'local',
          subjectAccount: 'alice',
          subjectNamespaceId: 0,
          body: { ...common.body, direction: 'INCOMING' },
        },
        {
          ...common,
          feedId: 2,
          namespaceId: 0,
          account: 'alice',
          domain: 'local',
          subjectAccount: '!dev',
          subjectNamespaceId: 0,
          body: { ...common.body, direction: 'OUTGOING' },
        },
      ];

      await webdb.applyStateFeedPage(items, 2);
      await webdb.mergeThreadStates([
        threadFeedSnapshot(12, {
          threadFeedId: 3,
          type: 'GROUP',
          profile: { account: '!dev', domain: 'local', namespaceId: 0, profileRev: 1 },
          threadProfileRev: 1,
          role: 'OWNER',
        }),
      ], 3);
      await webdb.applyGroupMetaPage({
        threadId: 12,
        namespaceId: 0,
        sourceServer: 'local',
        page: {
          account: '!dev',
          mode: 'full',
          items: [
            {
              feedId: '1',
              operation: 'MEMBER_UPSERT',
              account: 'alice',
              domain: 'local.test',
              namespaceId: 0,
              body: {
                role: 'OWNER',
                profileRev: 1,
              },
            },
            {
              feedId: '2',
              operation: 'MEMBER_UPSERT',
              account: 'bob',
              domain: 'remote.test',
              namespaceId: 12,
              body: {
                role: 'MEMBER',
                profileRev: 1,
              },
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
          group: expect.objectContaining({
            account: '!dev',
            name: '',
            memberCount: 2,
            groupMetaFeedId: '2',
          }),
        }),
      ]);

      await webdb.applyStateFeedPage(
        [
          {
            feedId: 4,
            namespaceId: 0,
            eventType: 'RELATIONSHIP_INTENT',
            account: 'alice',
            domain: 'local',
            subjectAccount: '!dev',
            subjectNamespaceId: 0,
            body: {
              ...common.body,
              status: 'REVOKED',
              direction: 'OUTGOING',
            },
          },
        ],
        4,
      );
      expect((await webdb.getThreads())[0]).toEqual(
        expect.objectContaining({ conversationState: 'ACTIVE' }),
      );
      await webdb.mergeThreadStates([
        threadFeedSnapshot(12, {
          threadFeedId: 5,
          type: 'GROUP',
          conversationState: 'READ_ONLY',
          role: null,
          profile: { account: '!dev', domain: 'local', namespaceId: 0, profileRev: 1 },
          threadProfileRev: 1,
        }),
      ], 5);
      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 12,
          type: 'GROUP',
          conversationState: 'READ_ONLY',
          role: null,
        }),
      ]);
      expect(
        await webdb.getGroupMember(12, 'bob', 'remote.test', 12),
      ).toMatchObject({ role: 'MEMBER', left: false });
      expect((await webdb.getThreads())[0]).toMatchObject({
        group: { memberCount: 2, groupMetaFeedId: '2' },
      });
      expect(
        await webdb.getProfile({
          account: 'bob',
          domain: 'remote.test',
          namespaceId: 12,
          profileRev: 1,
        }),
      ).toBeDefined();
      expect(
        await webdb.getProfile({
          account: '!dev',
          domain: 'local',
          namespaceId: 0,
          profileRev: 1,
        }),
      ).toBeDefined();
      await webdb.beginGroupMetaRecovery(12, '3');
      expect(
        await webdb.getGroupMember(12, 'bob', 'remote.test', 12),
      ).toBeUndefined();
      expect((await webdb.getThreads())[0]).toMatchObject({
        group: { memberCount: 0, groupMetaFeedId: '0' },
      });
    });

    it('keeps a newly created local group visible with independent relationship and thread feeds', async () => {
      await webdb.openForUser('1');
      const group = {
        account: '!repro-group',
        domain: 'local',
        namespaceId: 0,
        name: 'LOCAL-GROUP-REPRO',
        avatar: '',
        description: 'created from the Web UI',
        profileRev: 1,
      };
      const relationship = {
        feedId: 2,
        namespaceId: 0,
        eventType: 'RELATIONSHIP_INTENT' as const,
        account: '!repro-group',
        domain: 'local',
        subjectAccount: 'alice',
        subjectNamespaceId: 0,
        body: {
          status: 'ACCEPTED' as const,
          direction: 'INCOMING' as const,
          established: true,
          note: '',
          requestedAt: null,
          expiresAt: null,
          threadId: 95,
          group,
        },
      } satisfies ClientStateFeedItem;

      await webdb.applyStateFeedPage([relationship], 2);
      await webdb.mergeThreadStates([
        threadFeedSnapshot(95, {
          threadFeedId: 1,
          type: 'GROUP',
          role: 'OWNER',
          profile: { account: group.account, domain: 'local', namespaceId: 0, profileRev: 1 },
          threadProfileRev: 1,
        }),
      ], 1);

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 95,
          type: 'GROUP',
          visible: true,
          role: 'OWNER',
          group: expect.objectContaining({
            account: group.account,
            name: '',
          }),
        }),
      ]);

      await webdb.commitResolvedProfile({
        account: group.account,
        domain: 'alpha.test',
        namespaceId: 0,
        rev: 1,
        name: group.name,
        bio: group.description,
        avatarBase64: null,
      });

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 95,
          visible: true,
          group: expect.objectContaining({
            name: group.name,
            description: group.description,
          }),
        }),
      ]);
    });

    it('recreates only the message DB and preserves the core cache', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('sentinel', 'core');
      const profile = await webdb.commitResolvedProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
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

      expect(await webdb.getMeta('sentinel')).toBe('core');
      expect(
        await (await webdb.getProfileAvatarBlob(profile.avatarDigest!))?.text(),
      ).toBe('x');
      expect(await webdb.getMessage(7, 1)).toBeUndefined();
      expect(await webdb.getMessageRanges(7)).toEqual([]);
      expect(await webdb.getMessageHead(7)).toBeUndefined();
    });

    it('aborts the old lifetime, closes admission, and waits for active message operations before recreating', async () => {
      await webdb.openForUser('1');
      const liveDb = await webdb.messageDb();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(webdb, 'messageDb').mockImplementation(async () => {
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
