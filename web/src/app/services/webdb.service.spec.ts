import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { openDB } from 'idb';
import type { Message } from './model';
import type { ClientStateFeedItem } from './user.service';
import { FRIEND_INTENT_RETENTION_MS } from './friend-request-state';
import {
  CACHE_SCHEMA_VERSION,
  LocalCacheVersionMismatchError,
  MESSAGE_CACHE_SCHEMA_VERSION,
  mergeCoveredTail,
  WebdbService,
} from './webdb.service';

describe('mergeCoveredTail', () => {
  it('normalizes the first interval and preserves the right-most disjoint interval', () => {
    expect(mergeCoveredTail(null, { left: 9, right: 3 })).toEqual({
      left: 3,
      right: 9,
    });
    expect(
      mergeCoveredTail({ left: 20, right: 30 }, { left: 1, right: 10 }),
    ).toEqual({
      left: 20,
      right: 30,
    });
    expect(
      mergeCoveredTail({ left: 1, right: 10 }, { left: 20, right: 30 }),
    ).toEqual({
      left: 20,
      right: 30,
    });
  });

  it('merges overlap, adjacency, containment, and extensions in both directions', () => {
    const tail = { left: 10, right: 20 };
    expect(mergeCoveredTail(tail, { left: 15, right: 18 })).toEqual(tail);
    expect(mergeCoveredTail(tail, { left: 5, right: 10 })).toEqual({
      left: 5,
      right: 20,
    });
    expect(mergeCoveredTail(tail, { left: 20, right: 25 })).toEqual({
      left: 10,
      right: 25,
    });
    expect(mergeCoveredTail(tail, { left: 5, right: 25 })).toEqual({
      left: 5,
      right: 25,
    });
    expect(mergeCoveredTail(tail, { left: 1, right: 9 })).toEqual({
      left: 1,
      right: 20,
    });
    expect(mergeCoveredTail(tail, { left: 21, right: 30 })).toEqual({
      left: 10,
      right: 30,
    });
  });
});

describe('WebdbService', () => {
  describe('IDB-backed storage (fake-indexeddb)', () => {
    let webdb: WebdbService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), WebdbService],
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

    it('opens separate per-user core and message DBs and signals ready', async () => {
      const db = await webdb.openForUser('1');
      expect(db, 'opened handle').toBeTruthy();
      expect(db!.name, 'per-user partition key').toBe('soms-webdb-u1');
      expect([...db!.objectStoreNames].sort()).toEqual([
        'avatars',
        'friendRequests',
        'profiles',
        'relationshipIntents',
        'settings',
        'threadParticipants',
        'threads',
      ]);
      const messageDb = await webdb.messageDb();
      expect(messageDb.name).toBe('soms-msgdb-u1');
      expect([...messageDb.objectStoreNames].sort()).toEqual([
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
      await webdb.putMessages([
        { threadId: 7, seq: 1 } as Message,
        { threadId: 7, seq: 2 } as Message,
        { threadId: 9, seq: 1 } as Message,
      ]);

      expect(await webdb.countCachedMessages()).toBe(3);
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
      await webdb.putThread({ threadId: 7, type: 'P2P' } as never);
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
        webdb.putThread({ threadId: 8, type: 'P2P' } as never),
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
        type: 'P2P',
        friendshipActive: true,
        conversationState: 'ACTIVE',
        blocked: true,
      } as never);
      const revoked: ClientStateFeedItem = {
        feedId: 12,
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

      expect(await db!.getAll('friendRequests')).toHaveLength(1);
      expect(await webdb.getFriendRequestPage('SENT', null, 20)).toMatchObject({
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
      const [projection] = await db!.getAll('friendRequests');
      await webdb.markFriendRequestAccepted(projection.key);
      expect(await db!.get('friendRequests', projection.key)).toMatchObject({
        bucket: 'RECEIVED',
        direction: 'INCOMING',
        status: 'ACCEPTED',
      });
      expect(
        await webdb.getFriendRequestPage('RECEIVED', null, 20),
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
      expect(await webdb.getMeta('friendRequestStateRevision')).toBe(10);
      expect(
        await webdb.getFriendRequestPage('RECEIVED', null, 20),
      ).toMatchObject({ total: 1, actionableTotal: 1 });

      await webdb.applyStateFeedPage([event(11, 'OUTGOING', 'REVOKED')], 11);
      expect(await webdb.getMeta('friendRequestStateRevision')).toBe(10);
      expect(await db!.getAll('friendRequests')).toEqual([
        expect.objectContaining({
          bucket: 'RECEIVED',
          status: 'REVOKED',
          requestedSort: requestedAt,
        }),
      ]);
      const rejectedPage = await webdb.getFriendRequestPage(
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
      expect(await db!.getAll('friendRequests')).toEqual([
        expect.objectContaining({
          status: 'REQUESTED',
          peer: expect.objectContaining({ name: 'alice', avatar: '' }),
        }),
      ]);

      await webdb.applyStateFeedPage(
        [incoming(31, { name: 'Alice', avatar: '/uploads/alice-512.webp' })],
        31,
      );

      expect(await db!.getAll('friendRequests')).toEqual([
        expect.objectContaining({
          status: 'REQUESTED',
          peer: expect.objectContaining({
            id: 0,
            name: 'Alice',
            avatar: '/uploads/alice-512.webp',
          }),
        }),
      ]);
      expect(await webdb.getMeta('friendRequestStateRevision')).toBe(30);
      expect(await webdb.getMeta('stateFeedId')).toBe(31);
    });

    it('garbage-collects an expired request projection and its temporary profile', async () => {
      const db = await webdb.openForUser('1');
      const expiresAt = Date.now() + 1_000;
      const request: ClientStateFeedItem = {
        feedId: 20,
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
      expect(await db!.getAll('friendRequests')).toHaveLength(1);
      expect(
        await webdb.getProfile('pending:peer.test\u0000alice'),
      ).toMatchObject({
        name: 'Alice',
        bio: 'About Alice',
      });

      await webdb.cleanupFriendRequests(expiresAt);

      expect(await db!.getAll('friendRequests')).toHaveLength(1);
      expect(
        await webdb.getProfile('pending:peer.test\u0000alice'),
      ).toBeUndefined();

      await webdb.cleanupFriendRequests(expiresAt + FRIEND_INTENT_RETENTION_MS);
      expect(await db!.getAll('friendRequests')).toEqual([]);
    });

    it('garbage-collects an expired group-invite projection and its temporary profile', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const expiresAt = requestedAt + 1_000;
      const invite: ClientStateFeedItem = {
        feedId: 21,
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
      expect(await db!.getAll('friendRequests')).toHaveLength(1);
      expect(
        await webdb.getProfile('pending-group:groups.test\u0000!group'),
      ).toMatchObject({ source: 'GROUP_INVITE', bio: 'About group' });

      await webdb.cleanupFriendRequests(expiresAt);

      expect(await db!.getAll('friendRequests')).toHaveLength(1);
      expect(
        await webdb.getProfile('pending-group:groups.test\u0000!group'),
      ).toBeUndefined();

      await webdb.cleanupFriendRequests(expiresAt + FRIEND_INTENT_RETENTION_MS);
      expect(await db!.getAll('friendRequests')).toEqual([]);
    });

    it('refreshes a pending group invite when its authoritative profile arrives', async () => {
      const db = await webdb.openForUser('1');
      const requestedAt = Date.now();
      const invite: ClientStateFeedItem = {
        feedId: 22,
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

      expect(await db!.getAll('friendRequests')).toEqual([
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

      expect(await db!.getAll('friendRequests')).toEqual([
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
        type: 'P2P',
        friendshipActive: true,
        conversationState: 'ACTIVE',
      } as never);
      await webdb.putThread({
        threadId: 9,
        type: 'GROUP',
        blocked: true,
        group: { memberCount: 1, groupMetaFeedId: '1' },
      } as never);
      await db!.put('threadParticipants', {
        threadId: 9,
        userId: 8,
        memberAccount: 'alice',
        memberDomain: '',
        profileSourceServer: 'local',
        role: 'MEMBER',
        displayName: 'Alice',
        avatar: '',
        profileRev: 1,
      });

      await webdb.applyStateFeedPage([], 3, [], true);

      expect(await db!.getAll('threadParticipants')).toEqual([]);
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

      await db!.put('threadParticipants', {
        threadId: 9,
        userId: 10,
        memberAccount: 'bob',
        memberDomain: '',
        profileSourceServer: 'local',
        role: 'MEMBER',
        displayName: 'Bob',
        avatar: '',
        profileRev: 1,
      });
      await webdb.applyStateFeedPage([], 4);

      expect(await db!.getAll('threadParticipants')).toHaveLength(1);
      expect(await webdb.getMeta('stateFeedId')).toBe(4);
    });

    it('applies THREAD_BLOCK true and false deltas to the cached thread', async () => {
      await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 7,
        type: 'P2P',
        blocked: false,
      } as never);
      const event = (
        feedId: number,
        blocked: boolean,
      ): ClientStateFeedItem => ({
        feedId,
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

    it('materializes full group metadata and pages/searches the local roster', async () => {
      const db = await webdb.openForUser('1');
      await webdb.putThread({
        threadId: 9,
        type: 'GROUP',
        group: { memberCount: 0, groupMetaFeedId: '0' },
      } as never);
      await webdb.putProfile({
        identity: 'u8',
        id: 8,
        kind: 'user',
        name: 'Alice',
        account: 'alice',
        avatar: '/a.webp',
        bio: '',
        domain: 'home.example',
        sourceServer: 'local',
        profileRev: 6,
      });

      await webdb.applyStateFeedPage([], 3, [
        {
          threadId: 9,
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
                body: {
                  userId: 1,
                  role: 'OWNER',
                  profileRev: 1,
                  displayName: 'Self',
                  avatar: null,
                },
              },
              {
                feedId: '2',
                operation: 'UPSERT',
                account: 'alice',
                domain: 'home.example',
                body: {
                  userId: 8,
                  role: 'ADMIN',
                  profileRev: 6,
                  displayName: 'Alice',
                  avatar: '/a.webp',
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
      ).toEqual([expect.objectContaining({ userId: 8, displayName: 'Alice' })]);
      expect(
        (await webdb.getThreads()).find((item) => item.threadId === 9),
      ).toMatchObject({
        role: 'OWNER',
        group: { memberCount: 2, groupMetaFeedId: '2' },
      });

      await webdb.applyStateFeedPage([], 4, [
        {
          threadId: 9,
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
                body: {
                  userId: 1,
                  role: 'ADMIN',
                  profileRev: 1,
                  displayName: 'Self',
                  avatar: null,
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
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'delta',
            items: [
              {
                feedId: '4',
                operation: 'DELETE',
                account: 'self',
                domain: 'local',
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
          sourceServer: 'local',
          page: {
            account: '!team',
            mode: 'delta',
            items: [
              {
                feedId: '5',
                operation: 'DELETE',
                account: 'alice',
                domain: 'home.example',
                body: {},
              },
            ],
            hasMore: false,
            scannedThrough: '5',
            groupMetaFeedEndId: '5',
          },
        },
      ]);
      expect(await webdb.getProfile('u8')).toBeDefined();
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
        sourceServer: 'local',
        profileRev: 1,
      });
      const group = {
        account: '!dev',
        domain: 'local',
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
          account: '!dev',
          domain: 'local',
          subjectAccount: 'alice',
          subjectDomain: 'local',
          body: { ...common.body, direction: 'INCOMING' },
        },
        {
          ...common,
          feedId: 2,
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
                body: {
                  userId: 1,
                  role: 'OWNER',
                  profileRev: 1,
                  displayName: 'Alice',
                  avatar: null,
                },
              },
              {
                feedId: '2',
                operation: 'UPSERT',
                account: 'bob',
                domain: 'remote.test',
                body: {
                  userId: 8,
                  role: 'MEMBER',
                  profileRev: 1,
                  displayName: 'Bob',
                  avatar: null,
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
      expect(await webdb.getProfile('u8')).toBeDefined();
      expect(await webdb.getProfile('g12')).toBeUndefined();
    });

    it('commits missed-summary threads and cursor together', async () => {
      await webdb.openForUser('1');
      const item = { threadId: 9, type: 'P2P' } as never;
      const cursor = 4;

      await webdb.applyCatchUp([item], cursor);

      expect(await webdb.getThreads()).toEqual([item]);
      expect(await webdb.getMeta('messageFeedCursor')).toEqual(cursor);
    });

    it('recreates only the message DB and preserves the core cache', async () => {
      await webdb.openForUser('1');
      await webdb.putMeta('sentinel', 'core');
      await webdb.putMessages(
        [{ threadId: 7, seq: 1 } as never],
        { threadId: 7, left: 1, right: 1 },
        { threadId: 7, seq: 1 },
      );

      await webdb.recreateMessageCache();

      expect(await webdb.getMeta('sentinel')).toBe('core');
      expect(await webdb.getMessage(7, 1)).toBeUndefined();
      expect(await webdb.getMessageCoverage(7)).toBeUndefined();
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
        webdb.putMessages(
          [{ threadId: 7, seq: 1 } as never],
          undefined,
          undefined,
          lifetime,
        ),
      ).rejects.toThrowError('message cache lifetime expired');
      expect(await webdb.getMessage(7, 1)).toBeUndefined();
    });
  });
});
