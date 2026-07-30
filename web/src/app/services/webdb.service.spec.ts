import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';

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

    it('opens a per-user DB (name embeds the user) with the 5 stores and signals ready', async () => {
      const db = await webdb.openForUser('1');
      expect(db).withContext('opened handle').toBeTruthy();
      expect(db!.name)
        .withContext('per-user partition key')
        .toBe('soms-webdb-u1');
      expect([...db!.objectStoreNames].sort()).toEqual([
        'avatars',
        'messages',
        'meta',
        'profiles',
        'threads',
      ]);
      expect(webdb.ready()).toBe(true);
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
      expect(got).withContext('avatar hit').toBeTruthy();
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
      await expectAsync(webdb.db()).toBeRejected();
      expect(webdb.ready()).toBe(false);
    });

    it('commits a thread delta and its revision together', async () => {
      await webdb.openForUser('1');
      const item = { threadId: 7, type: 'P2P' } as never;
      await webdb.applyThreadDelta(
        [{ threadId: 7, direction: 'ADD', item }],
        12,
      );
      expect((await webdb.getThreads()).map((thread) => thread.threadId)).toEqual([7]);
      expect(await webdb.getMeta('threadRevision')).toBe(12);

      await webdb.applyThreadDelta(
        [{ threadId: 7, direction: 'DELETE' }],
        13,
      );
      expect(await webdb.getThreads()).toEqual([]);
      expect(await webdb.getMeta('threadRevision')).toBe(13);
    });
  });
});
