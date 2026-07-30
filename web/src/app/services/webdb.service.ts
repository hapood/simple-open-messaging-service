import { Injectable, OnDestroy, signal } from '@angular/core';
import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConversationItem, Message } from './model';
import type { HydratedThreadDeltaOp } from './user.service';
import { isTauri, tauriInvoke } from './runtime';

/**
 * The IndexedDB primitive for the frontend persistence layer ("webdb") — the storage half of the
 * strict 3-tier architecture (UI ↔ repositories ↔ backend). This service is PURE STORAGE: it owns the
 * per-user database, the 5 object stores, avatar persistence, and exposes the typed `idb` handle via
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
  /** Last render timestamp (ms), retained as cache metadata. */
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
  profileRev: number;
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
const DB_VERSION = 2;

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
      upgrade(db, oldVersion, _newVersion, transaction) {
        // v2 is deliberately destructive for the rebuildable thread/profile/sync caches.
        if (oldVersion > 0 && oldVersion < 2) {
          if (db.objectStoreNames.contains('profiles')) db.deleteObjectStore('profiles');
          if (db.objectStoreNames.contains('threads')) transaction.objectStore('threads').clear();
          if (db.objectStoreNames.contains('meta')) transaction.objectStore('meta').clear();
        }
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
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    if (idbAvailable()) await deleteDB(dbName(userId));
    if (isTauri()) {
      await tauriInvoke('native_db_clear_user', { userId: Number(userId) });
    }
  }

  /** Close the live WebView handle without deleting durable data (normal app/page teardown). */
  async close(): Promise<void> {
    const closing = this.dbPromise;
    this.dbPromise = null;
    this.currentUserId = null;
    this.ready.set(false);
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
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
    if (isTauri() && this.currentUserId != null) {
      try {
        return (await tauriInvoke('native_db_get_meta', {
          userId: Number(this.currentUserId),
          key,
        })) ?? undefined;
      } catch {
        return undefined;
      }
    }
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
    if (isTauri() && this.currentUserId != null) {
      try {
        await tauriInvoke('native_db_put_meta', {
          userId: Number(this.currentUserId),
          key,
          value,
        });
      } catch {
        /* best-effort */
      }
      return;
    }
    try {
      await (await this.db()).put('meta', { key, value });
    } catch {
      /* best-effort */
    }
  }

  // ---- avatar store: identity-keyed blobs --------------------------------------------------

  /** Read an avatar blob by identity and refresh its last-render metadata. */
  async getAvatar(identity: string): Promise<AvatarRecord | undefined> {
    if (isTauri() && this.currentUserId != null) {
      const record = await tauriInvoke<{
        identity: string;
        path: string;
        mime: string;
        data: number[];
        lastRender: number;
      } | null>('native_db_get_avatar', {
        userId: Number(this.currentUserId),
        identity,
      });
      if (!record) return undefined;
      return {
        identity: record.identity,
        path: record.path,
        blob: new Blob([new Uint8Array(record.data)], { type: record.mime }),
        lastRender: record.lastRender,
      };
    }
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

  /** Store/overwrite an avatar blob under its stable identity. */
  async putAvatar(record: AvatarRecord): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_put_avatar', {
        userId: Number(this.currentUserId),
        identity: record.identity,
        path: record.path,
        mime: record.blob.type || 'application/octet-stream',
        data: Array.from(new Uint8Array(await record.blob.arrayBuffer())),
        lastRender: record.lastRender,
      });
      return;
    }
    const db = await this.db();
    await db.put('avatars', record);
  }

  async getThreads(): Promise<ConversationItem[]> {
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<ConversationItem[]>('native_db_threads', {
        userId: Number(this.currentUserId),
      });
    }
    return (await this.db()).getAll('threads');
  }

  async replaceThreads(items: ConversationItem[]): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_replace_threads', {
        userId: Number(this.currentUserId),
        items,
      });
      return;
    }
    const tx = (await this.db()).transaction('threads', 'readwrite');
    await tx.store.clear();
    for (const item of items) await tx.store.put(item);
    await tx.done;
  }

  async putThread(item: ConversationItem): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_put_thread', {
        userId: Number(this.currentUserId),
        threadId: item.threadId,
        item,
      });
      return;
    }
    await (await this.db()).put('threads', item);
  }

  async deleteThread(threadId: number): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_delete_thread', {
        userId: Number(this.currentUserId),
        threadId,
      });
      return;
    }
    await (await this.db()).delete('threads', threadId);
  }

  /** Apply one server-planned thread delta and its revision in the same durable transaction. */
  async applyThreadDelta(delta: HydratedThreadDeltaOp[], revision: number): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_apply_thread_delta', {
        userId: Number(this.currentUserId),
        revision,
        delta,
      });
      return;
    }
    const db = await this.db();
    const tx = db.transaction(['threads', 'meta'], 'readwrite');
    for (const op of delta) {
      if (op.direction === 'DELETE') await tx.objectStore('threads').delete(op.threadId);
      else await tx.objectStore('threads').put(op.item);
    }
    await tx.objectStore('meta').put({ key: 'threadRevision', value: revision });
    await tx.done;
  }

  async getProfile(identity: string): Promise<ProfileRecord | undefined> {
    if (isTauri() && this.currentUserId != null) {
      return (
        (await tauriInvoke<ProfileRecord | null>('native_db_get_profile', {
          userId: Number(this.currentUserId),
          identity,
        })) ?? undefined
      );
    }
    return (await this.db()).get('profiles', identity);
  }

  async putProfile(record: ProfileRecord): Promise<boolean> {
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<boolean>('native_db_put_profile', {
        userId: Number(this.currentUserId),
        identity: record.identity,
        profileRev: record.profileRev,
        profile: record,
      });
    }
    const db = await this.db();
    const previous = await db.get('profiles', record.identity);
    if (previous && previous.profileRev > record.profileRev) return false;
    await db.put('profiles', record);
    return true;
  }

  // ---- message store -----------------------------------------------------------------------

  /** Query one cached message window. An absent anchor means the newest/oldest edge. */
  async queryCachedMessages(
    threadId: number,
    orderBy: 'desc' | 'asc',
    take: number,
    anchor?: number,
  ): Promise<Message[]> {
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<Message[]>('native_db_query_messages', {
        userId: Number(this.currentUserId),
        threadId,
        anchor: anchor ?? null,
        orderBy,
        take,
      });
    }
    const db = await this.db();
    const lower = anchor === undefined || orderBy === 'desc' ? -Infinity : anchor;
    const upper = anchor === undefined || orderBy === 'asc' ? Infinity : anchor;
    const range = IDBKeyRange.bound(
      [threadId, lower],
      [threadId, upper],
      orderBy === 'asc' && anchor !== undefined,
      orderBy === 'desc' && anchor !== undefined,
    );
    const out: Message[] = [];
    let cursor = await db
      .transaction('messages')
      .store.openCursor(range, orderBy === 'desc' ? 'prev' : 'next');
    while (cursor && out.length < take) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  /** Idempotently store a batch by the `(threadId, seq)` key. */
  async putMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_put_messages', {
        userId: Number(this.currentUserId),
        messages,
      });
      return;
    }
    const tx = (await this.db()).transaction('messages', 'readwrite');
    for (const message of messages) await tx.store.put(message);
    await tx.done;
  }

  async getMessage(threadId: number, seq: number): Promise<Message | undefined> {
    if (isTauri() && this.currentUserId != null) {
      return (
        (await tauriInvoke<Message | null>('native_db_get_message', {
          userId: Number(this.currentUserId),
          threadId,
          seq,
        })) ?? undefined
      );
    }
    return (await this.db()).get('messages', [threadId, seq]);
  }

  async getNewestMessages(threadIds: number[]): Promise<Message[]> {
    if (threadIds.length === 0) return [];
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<Message[]>('native_db_newest_messages', {
        userId: Number(this.currentUserId),
        threadIds,
      });
    }
    const tx = (await this.db()).transaction('messages', 'readonly');
    const messages = await Promise.all(
      threadIds.map(async (threadId) => {
        const cursor = await tx.store.openCursor(
          IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
          'prev',
        );
        return cursor?.value;
      }),
    );
    return messages.filter((message): message is Message => message !== undefined);
  }

  async deleteMessagesByThread(threadId: number): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_delete_messages_by_thread', {
        userId: Number(this.currentUserId),
        threadId,
      });
      return;
    }
    const tx = (await this.db()).transaction('messages', 'readwrite');
    await tx.store.delete(
      IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
    );
    await tx.done;
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
    void this.close();
  }
}
