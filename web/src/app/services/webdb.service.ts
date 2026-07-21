import { Injectable, OnDestroy, signal } from '@angular/core';
import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConversationItem, Message } from './model';

/**
 * The IndexedDB primitive for the frontend persistence layer ("webdb") — the storage half of the
 * strict 3-tier architecture (UI ↔ repositories ↔ backend). This service is PURE STORAGE: it owns the
 * per-user database, the 5 object stores, the avatar LRU GC, and exposes the typed `idb` handle via
 * {@link db}. It does NO HTTP, consumes NO SSE, and depends on NO domain service — opening/closing the
 * per-user DB is driven imperatively by the session owner (UserService's lifecycle effect calls
 * {@link openForUser} / {@link closeAndDelete}). Repositories read/write through
 * `(await webdb.db()).get/put/...`, which is per-store typed via {@link WebdbSchema}.
 *
 * Per-user partition: the database name embeds the signed-in user (`soms-webdb-u<userId>`), so a second
 * account on the same browser can never read the first's cached peers/avatars/list/history. On logout
 * or account switch the previous user's DB is closed + deleted (`deleteDatabase`) atomically — defense
 * in depth, since the data is physically gone, not just unreachable.
 *
 * Prerender safety: every IDB access is guarded by `typeof indexedDB !== 'undefined'` and the database
 * is opened lazily (never at construction / module load), mirroring the existing `localStorage` /
 * `window` guards used elsewhere.
 */

/** Avatar blob record. Keyed by stable identity (`u<userId>` / `g<groupId>`), NEVER by URL — see plan. */
export interface AvatarRecord {
  identity: string;
  blob: Blob;
  /** The source path this blob was fetched from (opaque; used only for change detection by the profile
   *  layer — NOT a cache key, NOT parsed for a version). */
  path: string;
  /** Render timestamp (ms) for LRU eviction. */
  lastRender: number;
}

/** Profile record. Keyed by identity string so user-ids and group-ids never collide in one store. */
export interface ProfileRecord {
  identity: string;
  id: number;
  kind: 'user' | 'group';
  name: string;
  avatar: string;
  bio: string;
  domain: string;
  fetchedAt: number;
}

/** A value persisted in the `meta` store (keyPath `'key'`). The sole key today is `'missedCursor'` — the
 *  `{threadId, seq}` forward cursor for the missed-summary pull, written by {@link ThreadRepository} on
 *  each pull. `value` is opaque to the store (structured-cloneable); the caller owns its shape + narrowing.
 *  The thread-list revision cursor stays in-memory in UserService (seeded from /user/my-profile each boot) —
 *  it does NOT live here. */
export interface MetaRecord {
  key: string;
  value: unknown;
}

/** The 5-store schema. */
export interface WebdbSchema extends DBSchema {
  avatars: { key: string; value: AvatarRecord };
  profiles: { key: string; value: ProfileRecord };
  /** One record per conversation, keyed by `threadId` (the field is the keyPath). */
  threads: { key: number; value: ConversationItem };
  meta: { key: string; value: MetaRecord };
  /** One record per message, keyed by `[threadId, seq]` (both fields are the keyPath). */
  messages: { key: [number, number]; value: Message };
}

const DB_PREFIX = 'soms-webdb-u';
const DB_VERSION = 1;

/** Avatar byte budget (50 MB). One blob per identity (overwrite on change), so this bounds the seen set. */
const AVATAR_BYTE_BUDGET = 50 * 1024 * 1024;

/**
 * Pure LRU eviction decision — extracted so it is unit-testable without a 50 MB fixture. Given all
 * avatar records and the current total bytes, returns the identities to evict (oldest `lastRender`
 * first) so that the remaining total fits the budget. Empty when already under budget.
 */
export function avatarEvictionVictims(
  records: AvatarRecord[],
  totalBytes: number,
  budget: number,
): string[] {
  if (totalBytes <= budget) return [];
  const sorted = [...records].sort((a, b) => a.lastRender - b.lastRender);
  const victims: string[] = [];
  let bytes = totalBytes;
  for (const r of sorted) {
    if (bytes <= budget) break;
    victims.push(r.identity);
    bytes -= r.blob.size;
  }
  return victims;
}

function dbName(userId: string): string {
  return `${DB_PREFIX}${userId}`;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

@Injectable({ providedIn: 'root' })
export class WebdbService implements OnDestroy {
  /** The currently-open database promise (resolves to the live handle), or null when no user / closed. */
  private dbPromise: Promise<IDBPDatabase<WebdbSchema>> | null = null;
  /** The userId whose DB is open (or being opened). */
  private currentUserId: string | null = null;
  /** Running total of avatar blob bytes (recomputed on open). Drives the LRU GC. */
  private avatarBytes = 0;
  /** Whether `navigator.storage.persist()` has been requested for this origin. */
  private persistedRequested = false;

  /** True once the current user's database is open and ready for reads/writes. */
  readonly ready = signal(false);

  /**
   * Open (or reuse) the per-user database. Safe to call repeatedly; returns the live handle promise
   * (null when IndexedDB is unavailable — prerender / SSR). Driven by the session owner (UserService).
   */
  async openForUser(userId: string): Promise<IDBPDatabase<WebdbSchema> | null> {
    if (!idbAvailable()) return null;
    if (this.currentUserId === userId && this.dbPromise) return this.dbPromise;
    if (this.currentUserId != null && this.currentUserId !== userId) {
      await this.closeAndDelete(this.currentUserId);
    }
    this.currentUserId = userId;
    this.dbPromise = openDB<WebdbSchema>(dbName(userId), DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('avatars')) {
          db.createObjectStore('avatars', { keyPath: 'identity' });
        }
        if (!db.objectStoreNames.contains('profiles')) {
          db.createObjectStore('profiles', { keyPath: 'identity' });
        }
        if (!db.objectStoreNames.contains('threads')) {
          db.createObjectStore('threads', { keyPath: 'threadId' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          // Composite key for range reads: getAll over [threadId, 0]..[threadId, cursor].
          db.createObjectStore('messages', { keyPath: ['threadId', 'seq'] });
        }
      },
    });
    try {
      const db = await this.dbPromise;
      await this.recomputeAvatarBytes(db);
      void this.requestPersistence();
      this.ready.set(true);
      return db;
    } catch (e) {
      this.dbPromise = null;
      this.ready.set(false);
      throw e;
    }
  }

  /** Close and physically delete the given user's database (logout / account switch). The synchronous
   *  head nulls `currentUserId` too, so a `db()` call racing in before the new user's effect re-fires
   *  cannot re-open THIS user's database via the stale id (`db()`'s lazy re-open reads `currentUserId`).
   *  The actual handle close + on-disk delete are awaited below. */
  async closeAndDelete(userId: string): Promise<void> {
    const closing = this.dbPromise;
    this.dbPromise = null;
    this.currentUserId = null;
    this.ready.set(false);
    this.avatarBytes = 0;
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    if (idbAvailable()) await deleteDB(dbName(userId));
  }

  /**
   * Resolve the live database handle. Repositories call this before every op; it awaits the in-flight
   * open. Rejects when there is no open DB (no user / unavailable) — callers should guard on
   * {@link ready} or catch, treating a miss as a graceful no-op.
   */
  async db(): Promise<IDBPDatabase<WebdbSchema>> {
    if (this.dbPromise) return this.dbPromise;
    if (this.currentUserId != null && idbAvailable()) {
      const db = await this.openForUser(this.currentUserId);
      if (!db) throw new Error('webdb: unavailable');
      return db;
    }
    throw new Error('webdb: no user / unavailable');
  }

  // ---- meta store: keyed scalars (the global message HWM today) ---------------------------

  /** Read a value from the `meta` store, or `undefined` when absent / IDB unavailable. The sole key today
   *  is `'missedCursor'` (the `{threadId, seq}` forward cursor for the missed-summary pull). The value is
   *  opaque to the store — the caller owns its shape + narrowing. */
  async getMeta(key: string): Promise<unknown> {
    try {
      const rec = await (await this.db()).get('meta', key);
      return rec?.value;
    } catch {
      return undefined;
    }
  }

  /** Write a value to the `meta` store (idempotent put by `key`). Best-effort: IDB unavailable / closed →
   *  graceful no-op (the value is also held in memory by its writer; a missed persist just re-fetches one
   *  idempotent page on the next catch-up). */
  async putMeta(key: string, value: unknown): Promise<void> {
    try {
      await (await this.db()).put('meta', { key, value });
    } catch {
      /* best-effort */
    }
  }

  // ---- avatar store: identity-keyed blob + LRU GC ------------------------------------------

  /** Read an avatar blob by identity, bumping its `lastRender` (LRU recency). */
  async getAvatar(identity: string): Promise<AvatarRecord | undefined> {
    const db = await this.db();
    const rec = await db.get('avatars', identity);
    if (!rec) return undefined;
    const now = Date.now();
    if (rec.lastRender !== now) {
      rec.lastRender = now;
      void db.put('avatars', rec).catch(() => {}); // fire-and-forget recency write
    }
    return rec;
  }

  /** Store/overwrite an avatar blob under its identity, then run the LRU GC if over budget. */
  async putAvatar(record: AvatarRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('avatars', 'readwrite');
    const existing = await tx.store.get(record.identity);
    if (existing) this.avatarBytes -= existing.blob.size;
    await tx.store.put(record);
    this.avatarBytes += record.blob.size;
    await tx.done;
    if (this.avatarBytes > AVATAR_BYTE_BUDGET) await this.evictAvatars();
  }

  /** Evict least-recently-rendered avatars until under the byte budget (decision via the pure helper). */
  private async evictAvatars(): Promise<void> {
    const db = await this.db();
    const all = await db.getAll('avatars');
    const victims = new Set(avatarEvictionVictims(all, this.avatarBytes, AVATAR_BYTE_BUDGET));
    if (victims.size === 0) return;
    const tx = db.transaction('avatars', 'readwrite');
    for (const rec of all) {
      if (victims.has(rec.identity)) {
        this.avatarBytes -= rec.blob.size;
        await tx.store.delete(rec.identity);
      }
    }
    await tx.done;
  }

  /** Recompute the running avatar-byte total from disk (called after open). */
  private async recomputeAvatarBytes(db: IDBPDatabase<WebdbSchema>): Promise<void> {
    let total = 0;
    let cursor = await db.transaction('avatars').store.openCursor();
    while (cursor) {
      total += cursor.value.blob.size;
      cursor = await cursor.continue();
    }
    this.avatarBytes = total;
  }

  /** Request persistent storage so the browser doesn't evict the origin under disk pressure. */
  private async requestPersistence(): Promise<void> {
    if (this.persistedRequested) return;
    this.persistedRequested = true;
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        /* non-critical */
      }
    }
  }

  ngOnDestroy(): void {
    if (this.currentUserId != null) void this.closeAndDelete(this.currentUserId);
  }
}
