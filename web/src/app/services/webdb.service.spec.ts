import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { openDB } from 'idb';
import type { Message } from './model';
import {
  LocalCacheVersionMismatchError,
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
        'friendIntents',
        'memberProfiles',
        'profiles',
        'settings',
        'threads',
      ]);
      const messageDb = await webdb.messageDb();
      expect(messageDb.name).toBe('soms-msgdb-u1');
      expect([...messageDb.objectStoreNames].sort()).toEqual([
        'messages',
        'settings',
      ]);
      expect((await messageDb.get('settings', 'schemaVersion'))?.value).toBe(1);
      expect(await webdb.getMeta('schemaVersion')).toBe(3);
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

      expect(await webdb.getMeta('schemaVersion')).toBe(3);
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

    it('commits a thread delta and its revision together', async () => {
      await webdb.openForUser('1');
      const item = { threadId: 7, type: 'P2P' } as never;
      await webdb.applyThreadDelta(
        [{ threadId: 7, direction: 'ADD', item }],
        12,
      );
      expect(
        (await webdb.getThreads()).map((thread) => thread.threadId),
      ).toEqual([7]);
      expect(await webdb.getMeta('stateRevision')).toBe(12);

      await webdb.applyThreadDelta([{ threadId: 7, direction: 'DELETE' }], 13);
      expect(await webdb.getThreads()).toEqual([]);
      expect(await webdb.getMeta('stateRevision')).toBe(13);
    });

    it('persists complete member-profile snapshots by thread and user', async () => {
      await webdb.openForUser('1');
      const snapshot = {
        direction: 'MEMBER_PROFILE' as const,
        revision: 12,
        sourcePeerDomain: 'group.example',
        memberAccount: 'alice',
        memberDomain: 'home.example',
        userId: 8,
        threadIds: [7, 9],
        displayName: 'Alice',
        avatar: '/a.webp',
        profileRevision: 6,
      };

      await webdb.applyThreadDelta([snapshot], 12);

      expect(await webdb.getMemberProfile(7, 8)).toEqual({
        threadId: 7,
        userId: 8,
        sourcePeerDomain: 'group.example',
        memberAccount: 'alice',
        memberDomain: 'home.example',
        displayName: 'Alice',
        avatar: '/a.webp',
        profileRevision: 6,
      });
      expect(await webdb.listMemberProfiles(9)).toEqual([
        expect.objectContaining({ userId: 8, displayName: 'Alice' }),
      ]);
      expect(await webdb.getMeta('stateRevision')).toBe(12);
    });

    it('upserts compacted friend intents by stable key and business revision', async () => {
      await webdb.openForUser('1');
      const base = {
        direction: 'CLIENT_STATE' as const,
        revision: 2,
        account: 'alice',
        domain: 'local',
        eventType: 'P2P_INTENT' as const,
        subjectAccount: 'bob',
        subjectDomain: 'peer.test',
        body: {
          status: 'REQUESTED' as const,
          note: 'hello',
          requestedAt: 10,
          expiresAt: 20,
          actor: {
            id: 1,
            account: 'alice',
            name: 'Alice',
            avatar: '',
            domain: 'local',
            isForeigner: false,
          },
          subject: {
            id: 0,
            account: 'bob',
            name: 'Bob',
            avatar: '',
            domain: 'peer.test',
            isForeigner: true,
          },
        },
      };
      await webdb.applyThreadDelta([{ ...base, businessRevision: 2 }], 2);
      await webdb.applyThreadDelta(
        [
          {
            ...base,
            businessRevision: 1,
            body: { ...base.body, status: 'REVOKED' },
          },
        ],
        3,
      );
      expect(await webdb.getFriendIntents()).toEqual([
        expect.objectContaining({
          businessRevision: 2,
          status: 'REQUESTED',
          note: 'hello',
        }),
      ]);
    });

    it('derives an incoming friend-request badge from client state atomically', async () => {
      await webdb.openForUser('1');
      const op = {
        direction: 'CLIENT_STATE' as const,
        revision: 17,
        account: 'remote',
        domain: 'peer.test',
        eventType: 'P2P_INTENT' as const,
        subjectAccount: 'local',
        subjectDomain: 'local',
        businessRevision: 1,
        body: {
          status: 'REQUESTED' as const,
          note: '',
          requestedAt: 10,
          expiresAt: 20,
          actor: {
            id: 2,
            account: 'remote',
            name: 'Remote',
            avatar: '',
            domain: 'peer.test',
            isForeigner: true,
          },
          subject: {
            id: 1,
            account: 'local',
            name: 'Local',
            avatar: '',
            domain: 'local',
            isForeigner: false,
          },
        },
      };
      await webdb.applyThreadDelta([op], 17);
      expect(await webdb.getMeta('friendRequestStateRevision')).toBe(17);
      expect(await webdb.getMeta('stateRevision')).toBe(17);
    });

    it('commits missed-summary threads and cursor together', async () => {
      await webdb.openForUser('1');
      const item = { threadId: 9, type: 'P2P' } as never;
      const cursor = { threadId: 9, seq: 4 };

      await webdb.applyMissedSummary([item], cursor);

      expect(await webdb.getThreads()).toEqual([item]);
      expect(await webdb.getMeta('missedCursor')).toEqual(cursor);
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
