import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { WebdbService, avatarEvictionVictims, type AvatarRecord } from './webdb.service';

/** Build an avatar record with a Blob of the given byte size (Blob.size === size). */
function makeRecord(identity: string, size: number, lastRender: number): AvatarRecord {
  return { identity, blob: new Blob([new Uint8Array(size)]), path: `/p/${identity}`, lastRender };
}

describe('WebdbService', () => {
  describe('avatarEvictionVictims (pure LRU decision)', () => {
    it('evicts nothing when already under budget', () => {
      expect(avatarEvictionVictims([makeRecord('a', 10, 1)], 10, 100)).toEqual([]);
    });

    it('evicts the single oldest record to get under budget', () => {
      const recs = [makeRecord('a', 60, 1), makeRecord('b', 50, 2), makeRecord('c', 40, 3)];
      // total 150, budget 100 → evict a (60) → 90 ≤ 100.
      expect(avatarEvictionVictims(recs, 150, 100)).toEqual(['a']);
    });

    it('evicts multiple oldest until under budget', () => {
      const recs = [makeRecord('a', 60, 1), makeRecord('b', 50, 2), makeRecord('c', 40, 3)];
      // total 150, budget 80 → evict a (60)→90 (>80), evict b (50)→40 (≤80).
      expect(avatarEvictionVictims(recs, 150, 80)).toEqual(['a', 'b']);
    });

    it('orders victims strictly by lastRender ascending regardless of input order', () => {
      const recs = [makeRecord('c', 60, 3), makeRecord('a', 60, 1), makeRecord('b', 60, 2)];
      expect(avatarEvictionVictims(recs, 180, 0)).toEqual(['a', 'b', 'c']);
    });

    it('does not mutate the input array', () => {
      const recs = [makeRecord('c', 60, 3), makeRecord('a', 60, 1), makeRecord('b', 60, 2)];
      const order = recs.map((r) => r.identity);
      avatarEvictionVictims(recs, 180, 0);
      expect(recs.map((r) => r.identity)).toEqual(order);
    });
  });

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
      expect(db!.name).withContext('per-user partition key').toBe('soms-webdb-u1');
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
      await webdb.putAvatar({ identity: 'u9', blob: new Blob(['hi']), path: '/a.webp', lastRender: 5 });
      const got = await webdb.getAvatar('u9');
      expect(got).withContext('avatar hit').toBeTruthy();
      expect(await got!.blob.text()).toBe('hi');
      expect(got!.path).toBe('/a.webp');
    });

    it('overwrites in place — one blob per identity, no accumulation', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({ identity: 'u9', blob: new Blob(['old']), path: '/a', lastRender: 1 });
      await webdb.putAvatar({ identity: 'u9', blob: new Blob(['new']), path: '/b', lastRender: 2 });
      const got = await webdb.getAvatar('u9');
      expect(await got!.blob.text()).toBe('new');
      expect(got!.path).toBe('/b');
      const db = await webdb.db();
      expect(await db.count('avatars')).toBe(1);
    });

    it('bumps lastRender on read (LRU recency)', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({ identity: 'u9', blob: new Blob(['x']), path: '/a', lastRender: 1 });
      await webdb.getAvatar('u9');
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget recency write settle
      const db = await webdb.db();
      const rec = await db.get('avatars', 'u9');
      expect(rec!.lastRender).toBeGreaterThan(1);
    });

    it('closeAndDelete physically removes the database (per-user wipe)', async () => {
      await webdb.openForUser('1');
      await webdb.putAvatar({ identity: 'u9', blob: new Blob(['x']), path: '/a', lastRender: 1 });
      await webdb.closeAndDelete('1');
      expect(webdb.ready()).toBe(false);
      // Reopen → empty: the DB was deleted, not just closed. (Combined with the name-embeds-user
      // assertion above, this is the per-user isolation guarantee.)
      await webdb.openForUser('1');
      expect(await webdb.getAvatar('u9')).toBeUndefined();
    });
  });
});
