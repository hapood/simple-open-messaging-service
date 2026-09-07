import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { openDB } from 'idb';
import {
  createGroupConversation,
  createP2PConversation,
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

    it('normalizes local mirror members without changing the group source and keeps unresolved members', async () => {
      const db = await webdb.openForUser('1');
      await webdb.putThread(
        createGroupConversation(90, {
          id: 90,
          ownerId: 0,
          name: 'Mirror',
          account: '!mirror',
          domain: 'authority.test',
          namespaceId: 7,
        }),
      );
      await webdb.applyStateFeedPage([], 99, [
        {
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
                operation: 'UPSERT',
                account: 'me',
                domain: 'local',
                namespaceId: 7,
                body: { role: 'MEMBER', profileRev: 2, profileResolved: false },
              },
              {
                feedId: '2',
                operation: 'UPSERT',
                account: 'other',
                domain: 'third.test',
                namespaceId: 7,
                body: {
                  role: 'MEMBER',
                  profileRev: 2,
                  displayName: 'Other',
                  avatar: null,
                  bio: '',
                },
              },
              {
                feedId: '3',
                operation: 'GROUP_PROFILE',
                body: { profileRev: 4 },
              },
            ],
          },
        },
      ]);
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
        user: { name: 'Other' },
      });
      expect(await webdb.getGroupMember(90, 'me', 'local', 7)).toMatchObject({
        namespaceId: 0,
      });
      expect(await db!.get('threads', 90)).toMatchObject({
        authorityNamespaceId: 7,
        group: { domain: 'authority.test', namespaceId: 7, profileRev: 4 },
      });
      expect(await db!.getAll('profiles')).toHaveLength(1);
      expect(await webdb.getMeta('stateFeedId')).toBe(99);
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
      await webdb.putProfile(profile);
      await webdb.putProfile({ ...profile, profileRev: 2, name: 'Old' });
      await webdb.putProfile({
        ...profile,
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

    it('rolls back the entire state page when an exact profile conflicts', async () => {
      const db = await webdb.openForUser('1');
      await webdb.putThread(
        createGroupConversation(90, {
          id: 90,
          ownerId: 1,
          name: 'Team',
          account: '!team',
        }),
      );
      await webdb.putProfile({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
        name: 'Alice',
        avatar: '',
        bio: '',
        sourceServer: 'local',
      });
      await webdb.putMeta('stateFeedId', 98);
      await expect(
        webdb.applyStateFeedPage([], 99, [
          {
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
                  operation: 'UPSERT',
                  account: 'bob',
                  domain: 'local',
                  namespaceId: 0,
                  body: { role: 'MEMBER', profileRev: 1 },
                },
                {
                  feedId: '2',
                  operation: 'UPSERT',
                  account: 'alice',
                  domain: 'local',
                  namespaceId: 0,
                  body: {
                    role: 'ADMIN',
                    profileRev: 1,
                    displayName: 'Conflicting name',
                    bio: '',
                  },
                },
              ],
            },
          },
        ]),
      ).rejects.toThrow('conflicting cached profile revision');
      expect(await db!.getAll('members')).toEqual([]);
      expect(await webdb.getMeta('stateFeedId')).toBe(98);
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
        content: 'deleted body',
      } as Message);
      expect(await webdb.getDeletedMessageSeqs(42, [4, 4, 5, 6, 7])).toEqual([
        4, 6,
      ]);
      expect(await webdb.getDeletedMessageSeqs(99, [4, 6])).toEqual([]);
      expect(await webdb.getDeletedMessageSeqs(42, [])).toEqual([]);
    });

    it('opens separate per-user core and message DBs and signals ready', async () => {
      const db = await webdb.openForUser('1');
      expect(db, 'opened handle').toBeTruthy();
      expect(db!.name, 'per-user partition key').toBe('soms-webdb-u1');
      expect([...db!.objectStoreNames].sort()).toEqual([
        'avatars',
        'members',
        'namespaces',
        'profiles',
        'relationshipIntents',
        'relationshipRequests',
        'settings',
        'threads',
      ]);
      const messageDb = await webdb.messageDb();
      expect(messageDb.name).toBe('soms-msgdb-u1');
      expect([...messageDb.objectStoreNames].sort()).toEqual([
        'messageRanges',
        'messages',
        'settings',
      ]);
      expect((await messageDb.get('settings', 'schemaVersion'))?.value).toBe(
        MESSAGE_CACHE_SCHEMA_VERSION,
      );
      expect(await webdb.getMeta('schemaVersion')).toBe(CACHE_SCHEMA_VERSION);
      expect(webdb.ready()).toBe(true);
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
      expect((await raw.get('settings', 'sentinel')).value).toBe(
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

    it('stores and reads an avatar by identity', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({
        identity: 'u9',
        blob: new Blob(['hi']),
        path: '/a.webp',
        lastRender: 5,
      });
      const got = await webdb.getAvatar('u9');
      expect(got, 'avatar hit').toBeTruthy();
      expect(await got!.blob.text()).toBe('hi');
      expect(got!.path).toBe('/a.webp');
    });

    it('overwrites in place — one blob per identity, no accumulation', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({
        identity: 'u9',
        blob: new Blob(['old']),
        path: '/a',
        lastRender: 1,
      });
      await webdb.putAvatar({
        identity: 'u9',
        blob: new Blob(['new']),
        path: '/b',
        lastRender: 2,
      });
      const got = await webdb.getAvatar('u9');
      expect(await got!.blob.text()).toBe('new');
      expect(got!.path).toBe('/b');
      const db = await webdb.db();
      expect(await db.count('avatars')).toBe(1);
    });

    it('bumps lastRender on read', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({
        identity: 'u9',
        blob: new Blob(['x']),
        path: '/a',
        lastRender: 1,
      });
      await webdb.getAvatar('u9');
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget recency write settle
      const db = await webdb.db();
      const rec = await db.get('avatars', 'u9');
      expect(rec!.lastRender).toBeGreaterThan(1);
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
      await webdb.putAvatar({
        identity: 'u9',
        blob: new Blob(['x']),
        path: '/a',
        lastRender: 1,
      });
      await webdb.closeAndDelete('1');
      expect(webdb.ready()).toBe(false);
      // Reopen → empty: the DB was deleted, not just closed. (Combined with the name-embeds-user
      // assertion above, this is the per-user isolation guarantee.)
      await webdb.openForUser('1');
      expect(await webdb.getAvatar('u9')).toBeUndefined();
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
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 0,
        type: 'P2P',
        peerUser: {
          id: 2,
          account: 'peer',
          name: 'Peer',
          domain: 'local',
          namespaceId: 0,
        },
      } as never);
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

    it('atomically advances the state-feed cursor and derives P2P read-only state', async () => {
      await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 0,
        type: 'P2P',
        peerUser: {
          id: 2,
          account: 'peer',
          name: 'Peer',
          domain: 'local',
          namespaceId: 0,
        },
        friendshipActive: true,
        conversationState: 'ACTIVE',
        blocked: true,
      } as never);
      const revoked: ClientStateFeedItem = {
        feedId: 12,
        namespaceId: 12,
        account: 'alice',
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'bob',
        subjectDomain: 'peer.test',
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

      expect(await webdb.getMeta('stateFeedId')).toBe(12);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 7),
      ).toMatchObject({
        friendshipActive: false,
        conversationState: 'READ_ONLY',
      });
    });

    it('materializes a local P2P conversation from two distinct local intent directions', async () => {
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
          subjectDomain: 'local',
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
          subjectDomain: 'local',
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
      expect(await webdb.getMeta('stateFeedId')).toBe(21);
    });

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
        subjectDomain: direction === 'OUTGOING' ? 'bravo.test' : 'local',
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
            subjectDomain: 'local',
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
        account: 'alice',
        domain: 'peer.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'me',
        subjectDomain: 'local.test',
        body: {
          status,
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
      expect(await webdb.getMeta('relationshipRequestStateRevision')).toBe(10);
      expect(
        await webdb.getRelationshipRequestPage('RECEIVED', null, 20),
      ).toMatchObject({ total: 1, actionableTotal: 1 });

      await webdb.applyStateFeedPage([event(11, 'OUTGOING', 'REVOKED')], 11);
      expect(await webdb.getMeta('relationshipRequestStateRevision')).toBe(10);
      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          bucket: 'RECEIVED',
          status: 'REVOKED',
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
        expect.objectContaining({ bucket: 'RECEIVED', status: 'REVOKED' }),
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
        subjectDomain: 'local.test',
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
      expect(await webdb.getMeta('relationshipRequestStateRevision')).toBe(30);
      expect(await webdb.getMeta('stateFeedId')).toBe(31);
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
        subjectDomain: 'peer.test',
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
        subjectDomain: 'local.test',
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
            domain: 'groups.test',
            isLocal: false,
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

    it.each([undefined, 10])(
      'keeps the selected intent/message profile when a different general PROFILE revision arrives (seq=%s)',
      async (peerProfileMessageSeq) => {
        await webdb.openForUser('1');
        await webdb.putThread(
          createP2PConversation(
            9,
            {
              id: 2,
              account: 'peer',
              name: 'Message profile',
              domain: 'local',
              profileRev: 1,
              avatar: 'data:image/webp;base64,aW1hZ2U=',
            },
            { peerProfileMessageSeq },
          ),
        );
        await webdb.applyStateFeedPage(
          [
            {
              feedId: 1,
              namespaceId: 0,
              account: 'peer',
              domain: 'local',
              eventType: 'PROFILE',
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                profileRev: 99,
                displayName: 'Public profile',
                avatar: '',
                bio: '',
              },
            },
          ],
          1,
        );
        expect((await webdb.getThreads())[0]).toMatchObject({
          peerProfileMessageSeq,
          peerUser: { name: 'Message profile', profileRev: 1 },
        });
      },
    );

    it('refreshes a pending group invite when its authoritative profile arrives', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const invite: ClientStateFeedItem = {
        feedId: 22,
        namespaceId: 12,
        account: '!group',
        domain: 'groups.test',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'me',
        subjectDomain: 'local.test',
        body: {
          status: 'REQUESTED',
          note: 'join us',
          requestedAt,
          expiresAt: requestedAt + 60_000,
          direction: 'INCOMING',
          threadId: 8,
          group: {
            namespaceId: 12,
            account: '!group',
            domain: 'groups.test',
            isLocal: false,
            name: '!group',
            avatar: '',
            description: '',
            profileRev: 0,
          },
        },
      };
      const profile: ClientStateFeedItem = {
        feedId: 23,
        namespaceId: 12,
        account: '!group',
        domain: 'groups.test',
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          profileRev: 3,
          displayName: 'Product Team',
          avatar: 'team.webp',
          bio: 'Product discussions',
        },
      };

      await webdb.applyStateFeedPage([invite, profile], 23);

      expect(await db!.getAll('relationshipRequests')).toEqual([
        expect.objectContaining({
          group: expect.objectContaining({
            name: 'Product Team',
            avatar: 'team.webp',
            description: 'Product discussions',
            profileRev: 3,
          }),
        }),
      ]);
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
            subjectDomain: 'local.test',
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
                domain: 'groups.test',
                isLocal: false,
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

    it('clears state-feed projections only on the first full page', async () => {
      const db = await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 0,
        type: 'P2P',
        peerUser: {
          id: 2,
          account: 'peer',
          name: 'Peer',
          domain: 'local',
          namespaceId: 0,
        },
        friendshipActive: true,
        conversationState: 'ACTIVE',
      } as never);
      await webdb.putThread({
        threadId: 9,
        authorityNamespaceId: 0,
        type: 'GROUP',
        blocked: true,
        group: {
          account: '!team',
          domain: 'local',
          namespaceId: 0,
          memberCount: 1,
          groupMetaFeedId: '1',
        },
      } as never);
      await db!.put('members', {
        threadId: 9,
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        profileRev: 1,
        role: 'MEMBER',
        left: false,
      });

      await webdb.applyStateFeedPage([], 3, [], true);

      expect(await db!.getAll('members')).toEqual([]);
      expect(await webdb.getThreads()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            threadId: 7,
            friendshipActive: false,
            conversationState: 'READ_ONLY',
            blocked: false,
          }),
          expect.objectContaining({ threadId: 9, blocked: false }),
        ]),
      );

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

      expect(await db!.getAll('members')).toHaveLength(1);
      expect(await webdb.getMeta('stateFeedId')).toBe(4);
    });

    it('applies THREAD_BLOCK true and false deltas to the cached thread', async () => {
      await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 0,
        type: 'P2P',
        peerUser: {
          id: 2,
          account: 'peer',
          name: 'Peer',
          domain: 'local',
          namespaceId: 0,
        },
        blocked: false,
      } as never);
      const event = (
        feedId: number,
        blocked: boolean,
      ): ClientStateFeedItem => ({
        feedId,
        namespaceId: 0,
        account: '',
        domain: 'local',
        eventType: 'THREAD_BLOCK',
        subjectAccount: '7',
        subjectDomain: 'local',
        body: { threadId: 7, blocked },
      });

      await webdb.applyStateFeedPage([event(5, true)], 5);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: true });

      await webdb.applyStateFeedPage([event(6, false)], 6);
      expect((await webdb.getThreads())[0]).toMatchObject({ blocked: false });
      expect(await webdb.getMeta('stateFeedId')).toBe(6);
    });

    it('applies the paired message and tombstone high-water marks', async () => {
      await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 0,
        type: 'P2P',
        peerUser: {
          id: 2,
          account: 'peer',
          name: 'Peer',
          domain: 'local',
          namespaceId: 0,
        },
      } as never);

      await webdb.applyStateFeedPage(
        [
          {
            feedId: 7,
            namespaceId: 0,
            account: '',
            domain: 'local',
            eventType: 'THREAD_CONTENT_HEAD',
            subjectAccount: '',
            subjectDomain: 'local',
            body: {
              threadId: 7,
              messageEndSeq: 12,
              tombstoneEndSeq: 4,
            },
          },
        ],
        7,
      );

      expect((await webdb.getThreads())[0]).toMatchObject({
        lastMessageSeq: 12,
        tombstoneEndSeq: 4,
      });
      expect(await webdb.getMeta('stateFeedId')).toBe(7);
    });

    it('optimistically activates only the greatest newly discovered namespace', async () => {
      await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        authorityNamespaceId: 12,
        type: 'P2P',
        conversationState: 'ACTIVE',
        peerUser: { domain: 'peer.test', namespaceId: 12 },
      } as never);
      await webdb.putProfile({
        identity: 'u11',
        id: 11,
        kind: 'user',
        name: 'Old',
        account: 'old',
        avatar: '',
        bio: '',
        domain: 'peer.test',
        namespaceId: 11,
        sourceServer: 'peer.test',
        profileRev: 1,
      });
      await webdb.putProfile({
        identity: 'u13',
        id: 13,
        kind: 'user',
        name: 'New',
        account: 'new',
        avatar: '',
        bio: '',
        domain: 'peer.test',
        namespaceId: 13,
        sourceServer: 'peer.test',
        profileRev: 1,
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
      const thread = {
        threadId: 7,
        authorityNamespaceId: 12,
        type: 'P2P',
        conversationState: 'ACTIVE',
        peerUser: { domain: 'peer.test', namespaceId: 12 },
      } as never;
      await webdb.putThread(thread);
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
      await webdb.putThread(
        createGroupConversation(9, {
          id: 9,
          ownerId: 0,
          account: '!team',
          domain: 'local',
          name: 'Old group name',
        }),
      );
      await webdb.applyStateFeedPage([], 7, [
        {
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
                operation: 'UPSERT',
                account: 'alice',
                domain: 'local',
                namespaceId: 0,
                body: { role: 'OWNER', profileRev: 2 },
              },
              {
                feedId: '3',
                operation: 'UPSERT',
                account: 'bob',
                domain: 'peer.test',
                namespaceId: 12,
                body: { role: 'MEMBER', profileRev: 5 },
              },
            ],
          },
        },
      ]);
      expect(await db.get('threads', 9)).toMatchObject({
        group: {
          name: 'Old group name',
          profileRev: 4,
          memberCount: 2,
          groupMetaFeedId: '3',
        },
      });
      expect(await webdb.getMeta('stateFeedId')).toBe(7);
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

    it('materializes full group metadata and pages/searches the local roster', async () => {
      const db = await webdb.openForUser('1');
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
      await webdb.putProfile({
        identity: 'u8',
        id: 8,
        kind: 'user',
        name: 'Alice',
        account: 'alice',
        avatar: '/a.webp',
        bio: 'About Alice',
        domain: 'home.example',
        namespaceId: 12,
        sourceServer: 'local',
        profileRev: 6,
      });
      await webdb.putProfile({
        identity: 'u1',
        id: 1,
        kind: 'user',
        name: 'Self',
        account: 'self',
        avatar: '',
        bio: '',
        domain: 'local',
        namespaceId: 0,
        sourceServer: 'local',
        profileRev: 1,
      });

      await webdb.applyStateFeedPage([], 3, [
        {
          threadId: 9,
          namespaceId: 0,
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'full',
            items: [
              {
                feedId: '1',
                operation: 'UPSERT',
                account: 'self',
                domain: 'local',
                namespaceId: 0,
                body: {
                  role: 'OWNER',
                  profileRev: 1,
                  displayName: 'Self',
                  avatar: null,
                  bio: '',
                },
              },
              {
                feedId: '2',
                operation: 'UPSERT',
                account: 'alice',
                domain: 'home.example',
                namespaceId: 12,
                body: {
                  role: 'ADMIN',
                  profileRev: 6,
                  displayName: 'Alice',
                  avatar: '/a.webp',
                  bio: 'About Alice',
                },
              },
            ],
            hasMore: false,
            scannedThrough: '2',
            groupMetaFeedEndId: '2',
          },
        },
      ]);

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
        await webdb.storeGroupMemberResolvedProfile(
          9,
          {
            account: 'alice',
            domain: 'home.example',
            namespaceId: 12,
          },
          { rev: 3, name: 'Alice in team', avatar: '/team.webp', bio: 'Team' },
        ),
      ).toBe(true);
      expect(
        await webdb.getGroupMember(9, 'alice', 'home.example', 12),
      ).toMatchObject({
        profileRev: 3,
        profileMessageSeq: 20,
        resolvedProfileRev: 3,
        profileName: 'Alice in team',
        profileAvatar: '/team.webp',
        profileBio: 'Team',
      });

      await webdb.applyStateFeedPage([], 4, [
        {
          threadId: 9,
          namespaceId: 0,
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'delta',
            items: [
              {
                feedId: '3',
                operation: 'UPSERT',
                account: 'self',
                domain: 'local',
                namespaceId: 0,
                body: {
                  role: 'ADMIN',
                  profileRev: 1,
                  displayName: 'Self',
                  avatar: null,
                  bio: '',
                },
              },
            ],
            hasMore: false,
            scannedThrough: '3',
            groupMetaFeedEndId: '3',
          },
        },
      ]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: 'ADMIN' });

      await webdb.applyStateFeedPage([], 5, [
        {
          threadId: 9,
          namespaceId: 0,
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'delta',
            items: [
              {
                feedId: '4',
                operation: 'DEPART',
                account: 'self',
                domain: 'local',
                namespaceId: 0,
                body: {},
              },
            ],
            hasMore: false,
            scannedThrough: '4',
            groupMetaFeedEndId: '4',
          },
        },
      ]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({ role: null });

      await webdb.applyStateFeedPage([], 6, [
        {
          threadId: 9,
          namespaceId: 0,
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'delta',
            items: [
              {
                feedId: '5',
                operation: 'DEPART',
                account: 'alice',
                domain: 'home.example',
                namespaceId: 12,
                body: {},
              },
            ],
            hasMore: false,
            scannedThrough: '5',
            groupMetaFeedEndId: '5',
          },
        },
      ]);
      expect(
        await webdb.getProfile({
          account: 'alice',
          domain: 'home.example',
          namespaceId: 12,
          profileRev: 3,
        }),
      ).toBeDefined();
    });

    it('materializes an active group conversation from bilateral intents before group metadata', async () => {
      await webdb.openForUser('1');
      await webdb.putProfile({
        identity: 'u8',
        id: 8,
        kind: 'user',
        name: 'Bob',
        account: 'bob',
        avatar: '',
        bio: '',
        domain: 'remote.test',
        namespaceId: 12,
        sourceServer: 'local',
        profileRev: 1,
      });
      await webdb.putProfile({
        identity: 'g12',
        id: 12,
        kind: 'group',
        name: 'dev',
        account: '!dev',
        avatar: '',
        bio: '',
        domain: 'local',
        namespaceId: 0,
        sourceServer: 'local',
        profileRev: 1,
      });
      const group = {
        account: '!dev',
        domain: 'local',
        namespaceId: 0,
        isLocal: true,
        name: 'dev',
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
          subjectDomain: 'local',
          body: { ...common.body, direction: 'INCOMING' },
        },
        {
          ...common,
          feedId: 2,
          namespaceId: 0,
          account: 'alice',
          domain: 'local',
          subjectAccount: '!dev',
          subjectDomain: 'local',
          body: { ...common.body, direction: 'OUTGOING' },
        },
      ];

      await webdb.applyStateFeedPage(items, 3, [
        {
          threadId: 12,
          namespaceId: 0,
          sourceServer: 'local',
          page: {
            account: '!dev',
            mode: 'full',
            items: [
              {
                feedId: '1',
                operation: 'UPSERT',
                account: 'alice',
                domain: 'local.test',
                namespaceId: 0,
                body: {
                  role: 'OWNER',
                  profileRev: 1,
                  displayName: 'Alice',
                  avatar: null,
                  bio: '',
                },
              },
              {
                feedId: '2',
                operation: 'UPSERT',
                account: 'bob',
                domain: 'remote.test',
                namespaceId: 12,
                body: {
                  role: 'MEMBER',
                  profileRev: 1,
                  displayName: 'Bob',
                  avatar: null,
                  bio: '',
                },
              },
            ],
            hasMore: false,
            scannedThrough: '2',
            groupMetaFeedEndId: '2',
          },
        },
      ]);

      expect(await webdb.getThreads()).toEqual([
        expect.objectContaining({
          threadId: 12,
          type: 'GROUP',
          group: expect.objectContaining({
            account: '!dev',
            name: 'dev',
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
            subjectDomain: 'local',
            body: {
              ...common.body,
              status: 'REVOKED',
              direction: 'OUTGOING',
            },
          },
        ],
        4,
      );
      expect(await webdb.getThreads()).toEqual([]);
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
    });

    it('recreates only the message DB and preserves the core cache', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('sentinel', 'core');
      await webdb.commitBrowserMessagePage({
        threadId: 7,
        scan: { left: 0, right: 1 },
        messages: [{ threadId: 7, seq: 1 } as never],
        gaps: [],
        knownNewestSeq: 1,
      });

      await webdb.recreateMessageCache();

      expect(await webdb.getMeta('sentinel')).toBe('core');
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
