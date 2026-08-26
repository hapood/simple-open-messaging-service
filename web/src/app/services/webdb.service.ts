import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  openDB,
  deleteDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from 'idb';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
  type DeletedMessageItem,
  type Message,
} from './model';
import type {
  ClientFriendIntent,
  ClientGroupInviteIntent,
  ClientGroupMetaFeedPage,
  ClientStateFeedItem,
} from './user.service';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';
import {
  applyFriendIntentToProjection,
  applyGroupIntentToProjection,
  friendRequestKey,
  groupRequestKey,
  markProjectionAccepted,
  projectionDirectionForFact,
  projectionIsExpired,
  projectionRequestExpiresAt,
  relationshipFactsAreActive,
  relationshipIntentKey,
  reverseRelationshipIntentKey,
  type FriendRequestProjection,
  type RelationshipIntentFact,
} from './friend-request-state';

/**
 * The IndexedDB primitive for the frontend persistence layer ("webdb") — the storage half of the
 * strict 3-tier architecture (UI ↔ repositories ↔ backend). This service is PURE STORAGE: it owns the
 * per-user core and message databases, avatar persistence, and exposes typed `idb` handles via
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
  account: string;
  avatar: string;
  bio: string;
  domain: string;
  profileRev: number;
  source?: 'OUTGOING_FRIEND_REQUEST' | 'GROUP_INVITE';
  expiresAt?: number;
}

/** One materialized group roster member. */
export interface ThreadParticipantRecord {
  threadId: number;
  userId: number;
  memberAccount: string;
  memberDomain: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  displayName: string;
  avatar: string;
  profileRev: number;
}

export interface ClientGroupMetaApply {
  threadId: number;
  page: ClientGroupMetaFeedPage;
}

type ClientRelationshipIntentBody = Extract<
  ClientStateFeedItem,
  { eventType: 'RELATIONSHIP_INTENT' }
>['body'];
type ClientRelationshipIntentItem = Extract<
  ClientStateFeedItem,
  { eventType: 'RELATIONSHIP_INTENT' }
>;

/** A value persisted in the stable `settings` store (keyPath `'key'`), including integer feed cursors.
 *  `value` is opaque to the store (structured-cloneable); the caller owns its shape + narrowing.
 *  The thread-list revision cursor stays in-memory in UserService (seeded from /user/my-profile each boot) —
 *  it does NOT live here. */
export interface MetaRecord {
  key: string;
  value: unknown;
}

export type CachedMessage = Message & {
  /** Sparse local-only completeness markers; absent on non-edge rows. */
  sectionLeft?: 1;
  sectionRight?: 1;
};

export interface MessageSection {
  left: number;
  right: number;
}

/** Per-thread O(1) summary of the complete section ending at the known server newest message. */
export interface MessageCoverageState {
  threadId: number;
  knownNewestSeq: number;
  /** Right-most server-confirmed complete interval. It may lag knownNewestSeq after an identity-only SSE. */
  coveredTail: MessageSection | null;
}

/** Select the right-most complete interval, joining touching intervals. Pure so both the storage behavior
 * and its edge cases can be exhaustively unit-tested independently of IndexedDB. */
export function mergeCoveredTail(
  current: MessageSection | null | undefined,
  incoming: MessageSection | null | undefined,
): MessageSection | null {
  if (!incoming) return current ?? null;
  const next = {
    left: Math.min(incoming.left, incoming.right),
    right: Math.max(incoming.left, incoming.right),
  };
  if (!current) return next;
  const tail = {
    left: Math.min(current.left, current.right),
    right: Math.max(current.left, current.right),
  };
  if (next.right < tail.left - 1) return tail;
  if (next.left > tail.right + 1) return next;
  return {
    left: Math.min(tail.left, next.left),
    right: Math.max(tail.right, next.right),
  };
}

function parseMessageCoverage(
  value: unknown,
): MessageCoverageState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<MessageCoverageState>;
  if (
    typeof raw.threadId !== 'number' ||
    typeof raw.knownNewestSeq !== 'number' ||
    !('coveredTail' in raw)
  ) {
    throw new Error('invalid message coverage state');
  }
  let coveredTail: MessageSection | null = null;
  if (
    raw.coveredTail &&
    typeof raw.coveredTail.left === 'number' &&
    typeof raw.coveredTail.right === 'number'
  ) {
    coveredTail = mergeCoveredTail(null, raw.coveredTail);
  } else if (raw.coveredTail !== null) {
    throw new Error('invalid message coverage tail');
  }
  return {
    threadId: raw.threadId,
    knownNewestSeq: raw.knownNewestSeq,
    coveredTail,
  };
}

function messageCoverageKey(threadId: number): string {
  return `messageCoverage:${threadId}`;
}

/** Core cache schema. High-volume message data intentionally lives in MessageDbSchema. */
export interface WebdbSchema extends DBSchema {
  avatars: { key: string; value: AvatarRecord };
  profiles: { key: string; value: ProfileRecord };
  threadParticipants: {
    key: [number, number];
    value: ThreadParticipantRecord;
    indexes: { identity: [number, string, string] };
  };
  /** One record per conversation, keyed by `threadId` (the field is the keyPath). */
  threads: { key: number; value: ConversationItem };
  friendRequests: {
    key: string;
    value: FriendRequestProjection;
    indexes: { bucketStatus: [string, string, number, string] };
  };
  relationshipIntents: { key: string; value: RelationshipIntentFact };
  settings: { key: string; value: MetaRecord };
}

export interface MessageDbSchema extends DBSchema {
  /** Stable KV store. Its shape is fixed; schemaVersion and coverage values live here. */
  settings: { key: string; value: MetaRecord };
  /** One record per message, keyed by `[threadId, seq]` (both fields are the keyPath). */
  messages: {
    key: [number, number];
    value: CachedMessage;
    indexes: {
      sectionLeft: [number, number, number];
      sectionRight: [number, number, number];
    };
  };
}

const DB_PREFIX = 'soms-webdb-u';
const MESSAGE_DB_PREFIX = 'soms-msgdb-u';
export const CACHE_SCHEMA_VERSION = 6;
export const MESSAGE_CACHE_SCHEMA_VERSION = 1;
const IDB_FORMAT_VERSION = 1;

export class LocalCacheUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalCacheUnavailableError';
  }
}

export class LocalCacheVersionMismatchError extends Error {
  constructor(name: string) {
    super(`local cache schema version mismatch: ${name}`);
    this.name = 'LocalCacheVersionMismatchError';
  }
}

function dbName(userId: string): string {
  return `${DB_PREFIX}${userId}`;
}

function messageDbName(userId: string): string {
  return `${MESSAGE_DB_PREFIX}${userId}`;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

@Injectable({ providedIn: 'root' })
export class WebdbService implements OnDestroy {
  /** The currently-open database promise (resolves to the live handle), or null when no user / closed. */
  private dbPromise: Promise<IDBPDatabase<WebdbSchema>> | null = null;
  private messageDbPromise: Promise<IDBPDatabase<MessageDbSchema>> | null =
    null;
  /** Message-cache maintenance barrier. Every public message operation is counted until its Promise
   * settles; recreation closes the admission gate, waits for this count to reach zero, then replaces the
   * store. JavaScript runs the admission check + increment synchronously, so recreation cannot slip
   * between them. */
  private messageOperations = 0;
  private messageResetting = false;
  private messageIdleWaiters: Array<() => void> = [];
  private messageResetPromise: Promise<void> | null = null;
  /** Monotonic account-cache lifetime. Logout/close/full recreation increments it synchronously, so an
   * older async open/recreate can observe that it lost ownership and must never publish/reopen handles. */
  private cacheEpoch = 0;
  private accountResetPromise: Promise<IDBPDatabase<WebdbSchema> | null> | null =
    null;
  private accountResetUserId: string | null = null;
  /** Full account-cache operation barrier. Core and message operations are admitted synchronously; full
   * recreation/logout closes admission and waits for every admitted native/IDB operation to settle. */
  private accountOperations = 0;
  private accountMaintenance = false;
  private accountIdleWaiters: Array<() => void> = [];
  /** Aborted before message-cache maintenance starts. Network work captures this signal and must pass it
   * back when entering a write operation, so a response from the old cache lifetime cannot populate the
   * replacement database. */
  private messageLifetime = new AbortController();
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
    if (this.accountResetPromise) await this.accountResetPromise;
    const epoch = this.cacheEpoch;
    if (this.currentUserId === userId && this.dbPromise) return this.dbPromise;
    if (this.currentUserId != null && this.currentUserId !== userId) {
      await this.closeAndDelete(this.currentUserId);
    }
    this.currentUserId = userId;
    this.dbPromise = this.openValidatedOrRecreate(dbName(userId));
    this.messageDbPromise = this.openValidatedMessageDbOrRecreate(
      messageDbName(userId),
    );
    try {
      const [db, messages] = await Promise.all([
        this.dbPromise,
        this.messageDbPromise,
      ]);
      if (epoch !== this.cacheEpoch || this.currentUserId !== userId) {
        db.close();
        messages.close();
        throw new Error('webdb: stale open discarded');
      }
      this.activateMessageLifetime();
      void this.requestPersistence();
      this.ready.set(true);
      return db;
    } catch (e) {
      this.dbPromise = null;
      this.messageDbPromise = null;
      this.ready.set(false);
      throw e;
    }
  }

  /** Cold-start path: open only databases that already exist and match the current v1 schema. This path
   * never creates, upgrades, deletes, or repairs storage. */
  async openExistingForUser(
    userId: string,
  ): Promise<IDBPDatabase<WebdbSchema> | null> {
    if (!idbAvailable()) return null;
    if (this.accountResetPromise) await this.accountResetPromise;
    const epoch = this.cacheEpoch;
    if (this.currentUserId === userId && this.dbPromise) return this.dbPromise;
    if (this.currentUserId != null && this.currentUserId !== userId)
      await this.close();
    this.currentUserId = userId;
    this.dbPromise = this.openExistingCore(dbName(userId));
    this.messageDbPromise = this.openExistingMessages(messageDbName(userId));
    try {
      const [db, messages] = await Promise.all([
        this.dbPromise,
        this.messageDbPromise,
      ]);
      if (epoch !== this.cacheEpoch || this.currentUserId !== userId) {
        db.close();
        messages.close();
        throw new Error('webdb: stale existing-cache open discarded');
      }
      this.activateMessageLifetime();
      this.ready.set(true);
      return db;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Fresh-login path: explicitly drop both browser cache databases, then initialize the current v1
   * schema. Authentication remains valid; only rebuildable local data is replaced. */
  async recreateForUser(
    userId: string,
  ): Promise<IDBPDatabase<WebdbSchema> | null> {
    if (!idbAvailable()) return null;
    if (this.accountResetPromise) {
      if (this.accountResetUserId === userId) return this.accountResetPromise;
      await this.accountResetPromise;
    }
    const epoch = ++this.cacheEpoch;
    this.accountResetUserId = userId;
    this.beginAccountMaintenance();
    const reset = this.doRecreateForUser(userId, epoch);
    this.accountResetPromise = reset;
    try {
      return await reset;
    } finally {
      if (this.accountResetPromise === reset) this.accountResetPromise = null;
      if (this.accountResetUserId === userId) this.accountResetUserId = null;
    }
  }

  private async doRecreateForUser(
    userId: string,
    epoch: number,
  ): Promise<IDBPDatabase<WebdbSchema> | null> {
    await this.waitForAccountIdle();
    await this.closeHandles();
    await Promise.all([
      deleteDB(dbName(userId)),
      deleteDB(messageDbName(userId)),
    ]);
    if (epoch !== this.cacheEpoch) return null;
    this.currentUserId = userId;
    const core = this.openValidatedOrRecreate(dbName(userId));
    const message = this.openValidatedMessageDbOrRecreate(
      messageDbName(userId),
    );
    this.dbPromise = core;
    this.messageDbPromise = message;
    const [db, messages] = await Promise.all([core, message]);
    if (epoch !== this.cacheEpoch || this.currentUserId !== userId) {
      db.close();
      messages.close();
      return null;
    }
    this.activateMessageLifetime();
    this.ready.set(true);
    void this.requestPersistence();
    return db;
  }

  private async databaseExists(name: string): Promise<boolean> {
    const factory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (!factory.databases)
      throw new LocalCacheUnavailableError(
        'IndexedDB database enumeration is unavailable',
      );
    return (await factory.databases()).some(
      (database) => database.name === name,
    );
  }

  private async openExistingCore(
    name: string,
  ): Promise<IDBPDatabase<WebdbSchema>> {
    if (!(await this.databaseExists(name)))
      throw new LocalCacheUnavailableError(`missing local cache: ${name}`);
    const db = await openDB<WebdbSchema>(name);
    if (!db.objectStoreNames.contains('settings')) {
      db.close();
      throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
    }
    try {
      if (
        (await db.get('settings', 'schemaVersion'))?.value !==
        CACHE_SCHEMA_VERSION
      ) {
        db.close();
        throw new LocalCacheVersionMismatchError(name);
      }
    } catch (error) {
      db.close();
      if (error instanceof LocalCacheVersionMismatchError) throw error;
      throw new LocalCacheUnavailableError(`unreadable local cache: ${name}`);
    }
    if (await this.isCurrentSchema(db)) return db;
    db.close();
    throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
  }

  private async openExistingMessages(
    name: string,
  ): Promise<IDBPDatabase<MessageDbSchema>> {
    if (!(await this.databaseExists(name)))
      throw new LocalCacheUnavailableError(`missing local cache: ${name}`);
    const db = await openDB<MessageDbSchema>(name);
    if (!db.objectStoreNames.contains('settings')) {
      db.close();
      throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
    }
    try {
      if (
        (await db.get('settings', 'schemaVersion'))?.value !==
        MESSAGE_CACHE_SCHEMA_VERSION
      ) {
        db.close();
        throw new LocalCacheVersionMismatchError(name);
      }
    } catch (error) {
      db.close();
      if (error instanceof LocalCacheVersionMismatchError) throw error;
      throw new LocalCacheUnavailableError(`unreadable local cache: ${name}`);
    }
    if (await this.isCurrentMessageSchema(db)) return db;
    db.close();
    throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
  }

  /** Open the current cache without requesting an IndexedDB upgrade. The stable `meta` KV store owns the
   *  application schema version. Any old/missing/damaged rebuildable cache is deleted and initialized from
   *  scratch; there are deliberately no incremental data migrations. */
  private async openValidatedOrRecreate(
    name: string,
  ): Promise<IDBPDatabase<WebdbSchema>> {
    const existing = await openDB<WebdbSchema>(name);
    if (await this.isCurrentSchema(existing)) return existing;
    existing.close();
    await deleteDB(name);
    return this.createCurrentSchema(name);
  }

  private async isCurrentSchema(
    db: IDBPDatabase<WebdbSchema>,
  ): Promise<boolean> {
    const required = [
      'avatars',
      'profiles',
      'threadParticipants',
      'threads',
      'friendRequests',
      'relationshipIntents',
      'settings',
    ] as const;
    if (required.some((store) => !db.objectStoreNames.contains(store)))
      return false;
    if (db.objectStoreNames.length !== required.length) return false;
    try {
      const version = await db.get('settings', 'schemaVersion');
      return version?.value === CACHE_SCHEMA_VERSION;
    } catch {
      return false;
    }
  }

  private createCurrentSchema(
    name: string,
  ): Promise<IDBPDatabase<WebdbSchema>> {
    return openDB<WebdbSchema>(name, IDB_FORMAT_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion !== 0)
          throw new Error('cache recreation expected an empty IndexedDB');
        db.createObjectStore('avatars', { keyPath: 'identity' });
        db.createObjectStore('profiles', { keyPath: 'identity' });
        const threadParticipants = db.createObjectStore('threadParticipants', {
          keyPath: ['threadId', 'userId'],
        });
        threadParticipants.createIndex('identity', [
          'threadId',
          'memberDomain',
          'memberAccount',
        ]);
        db.createObjectStore('threads', { keyPath: 'threadId' });
        const friendRequests = db.createObjectStore('friendRequests', {
          keyPath: 'key',
        });
        friendRequests.createIndex('bucketStatus', [
          'bucket',
          'status',
          'requestedSort',
          'key',
        ]);
        db.createObjectStore('relationshipIntents', { keyPath: 'key' });
        db.createObjectStore('settings', { keyPath: 'key' });
        transaction.objectStore('settings').put({
          key: 'schemaVersion',
          value: CACHE_SCHEMA_VERSION,
        });
      },
    });
  }

  private async openValidatedMessageDbOrRecreate(
    name: string,
  ): Promise<IDBPDatabase<MessageDbSchema>> {
    const existing = await openDB<MessageDbSchema>(name);
    if (await this.isCurrentMessageSchema(existing)) return existing;
    existing.close();
    await deleteDB(name);
    return openDB<MessageDbSchema>(name, IDB_FORMAT_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion !== 0)
          throw new Error(
            'message cache recreation expected an empty IndexedDB',
          );
        db.createObjectStore('settings', { keyPath: 'key' });
        const messages = db.createObjectStore('messages', {
          keyPath: ['threadId', 'seq'],
        });
        messages.createIndex('sectionLeft', ['threadId', 'sectionLeft', 'seq']);
        messages.createIndex('sectionRight', [
          'threadId',
          'sectionRight',
          'seq',
        ]);
        transaction.objectStore('settings').put({
          key: 'schemaVersion',
          value: MESSAGE_CACHE_SCHEMA_VERSION,
        });
      },
    });
  }

  private async isCurrentMessageSchema(
    db: IDBPDatabase<MessageDbSchema>,
  ): Promise<boolean> {
    if (
      db.objectStoreNames.length !== 2 ||
      !db.objectStoreNames.contains('settings') ||
      !db.objectStoreNames.contains('messages')
    )
      return false;
    try {
      if (
        (await db.get('settings', 'schemaVersion'))?.value !==
        MESSAGE_CACHE_SCHEMA_VERSION
      )
        return false;
      const indexes = db.transaction('messages').store.indexNames;
      return (
        indexes.contains('sectionLeft') && indexes.contains('sectionRight')
      );
    } catch {
      return false;
    }
  }

  /** Close and physically delete the given user's database (logout / account switch). The synchronous
   *  head nulls `currentUserId` too, so a `db()` call racing in before the new user's effect re-fires
   *  cannot re-open THIS user's database via the stale id (`db()`'s lazy re-open reads `currentUserId`).
   *  The actual handle close + on-disk delete are awaited below. */
  async closeAndDelete(userId: string): Promise<void> {
    ++this.cacheEpoch;
    this.beginAccountMaintenance();
    const closing = this.dbPromise;
    const closingMessages = this.messageDbPromise;
    this.dbPromise = null;
    this.messageDbPromise = null;
    this.currentUserId = null;
    this.ready.set(false);
    await this.waitForAccountIdle();
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    if (closingMessages) {
      try {
        (await closingMessages).close();
      } catch {
        /* already closed */
      }
    }
    // A reset may be waiting for the handles captured above to close before its deleteDB resolves. Close
    // them first, then join the reset; reversing this order deadlocks logout against full recreation.
    if (this.accountResetPromise) {
      try {
        await this.accountResetPromise;
      } catch {
        /* deletion below remains authoritative */
      }
    }
    if (idbAvailable()) await deleteDB(dbName(userId));
    if (idbAvailable()) await deleteDB(messageDbName(userId));
    if (isTauri()) {
      await tauriInvoke('native_db_clear_user', { userId: Number(userId) });
    }
  }

  /** Close the live WebView handle without deleting durable data (normal app/page teardown). */
  async close(): Promise<void> {
    ++this.cacheEpoch;
    this.beginAccountMaintenance();
    const closing = this.dbPromise;
    const closingMessages = this.messageDbPromise;
    this.dbPromise = null;
    this.messageDbPromise = null;
    this.currentUserId = null;
    this.ready.set(false);
    await this.waitForAccountIdle();
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    if (closingMessages) {
      try {
        (await closingMessages).close();
      } catch {
        /* already closed */
      }
    }
  }

  private beginAccountMaintenance(): void {
    this.accountMaintenance = true;
    this.messageResetting = true;
    this.messageLifetime.abort();
    this.ready.set(false);
  }

  private activateMessageLifetime(): void {
    this.messageLifetime = new AbortController();
    this.messageResetting = false;
    this.accountMaintenance = false;
  }

  private async closeHandles(): Promise<void> {
    const closing = this.dbPromise;
    const closingMessages = this.messageDbPromise;
    this.dbPromise = null;
    this.messageDbPromise = null;
    this.currentUserId = null;
    this.ready.set(false);
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    if (closingMessages) {
      try {
        (await closingMessages).close();
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

  /** Internal message-cache handle; separate so clearing chat history never drops core cache data. */
  async messageDb(): Promise<IDBPDatabase<MessageDbSchema>> {
    if (this.messageDbPromise) return this.messageDbPromise;
    if (this.currentUserId != null && idbAvailable()) {
      await this.openForUser(this.currentUserId);
      if (this.messageDbPromise) return this.messageDbPromise;
    }
    throw new Error('message db: no user / unavailable');
  }

  /** Lifetime captured by cache-populating network work. Abortion is synchronous and observable by all
   * holders; callers must also pass it into the eventual write to close the check/admission race. */
  captureMessageLifetime(): AbortSignal {
    return this.messageLifetime.signal;
  }

  private async runMessageOperation<T>(
    operation: () => Promise<T>,
    lifetime?: AbortSignal,
  ): Promise<T> {
    return this.runAccountOperation(async () => {
      if (this.messageResetting || lifetime?.aborted)
        throw new Error('message cache lifetime expired');
      this.messageOperations++;
      try {
        return await operation();
      } finally {
        this.messageOperations--;
        if (this.messageOperations === 0) {
          const waiters = this.messageIdleWaiters;
          this.messageIdleWaiters = [];
          for (const resolve of waiters) resolve();
        }
      }
    });
  }

  private async runAccountOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.accountMaintenance)
      throw new Error('account cache lifetime expired');
    this.accountOperations++;
    try {
      return await operation();
    } finally {
      this.accountOperations--;
      if (this.accountOperations === 0) {
        const waiters = this.accountIdleWaiters;
        this.accountIdleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private waitForAccountIdle(): Promise<void> {
    if (this.accountOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.accountIdleWaiters.push(resolve));
  }

  private waitForMessageIdle(): Promise<void> {
    if (this.messageOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.messageIdleWaiters.push(resolve));
  }

  /** Number of cached message rows for the active user. Coverage/settings rows are deliberately excluded. */
  async countCachedMessages(): Promise<number> {
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return tauriInvoke<number>('native_db_count_messages', {
          userId: Number(this.currentUserId),
        });
      }
      return (await this.messageDb()).count('messages');
    });
  }

  /** Drop and recreate only message data plus its coverage metadata. Core threads/profiles/avatars survive. */
  async recreateMessageCache(): Promise<void> {
    if (this.messageResetPromise) return this.messageResetPromise;
    if (this.currentUserId == null)
      throw new Error('message db: no active user');
    const epoch = this.cacheEpoch;
    this.messageResetting = true;
    this.messageLifetime.abort();
    this.messageResetPromise = this.doRecreateMessageCache();
    try {
      await this.messageResetPromise;
    } finally {
      this.messageResetPromise = null;
      if (epoch === this.cacheEpoch && this.currentUserId != null)
        this.activateMessageLifetime();
    }
  }

  private async doRecreateMessageCache(): Promise<void> {
    await this.waitForMessageIdle();
    if (this.currentUserId == null)
      throw new Error('message db: no active user');
    if (isTauri()) {
      await tauriInvoke('native_db_recreate_messages');
      return;
    }
    const userId = this.currentUserId;
    const closing = this.messageDbPromise;
    this.messageDbPromise = null;
    if (closing) {
      try {
        (await closing).close();
      } catch {
        /* already closed */
      }
    }
    await deleteDB(messageDbName(userId));
    if (this.currentUserId !== userId) return;
    this.messageDbPromise = this.openValidatedMessageDbOrRecreate(
      messageDbName(userId),
    );
    await this.messageDbPromise;
  }

  // ---- core settings store: keyed synchronization scalars ---------------------------------

  /** Read a value from the `settings` store, or `undefined` when absent / IDB unavailable. The value is
   *  opaque to the store — the caller owns its shape + narrowing. */
  async getMeta(key: string): Promise<unknown> {
    return this.runAccountOperation(() => this.getMetaInternal(key));
  }

  private async getMetaInternal(key: string): Promise<unknown> {
    if (isTauri() && this.currentUserId != null) {
      try {
        return (
          (await tauriInvoke('native_db_get_meta', {
            userId: Number(this.currentUserId),
            key,
          })) ?? undefined
        );
      } catch {
        return undefined;
      }
    }
    try {
      const rec = await (await this.db()).get('settings', key);
      return rec?.value;
    } catch {
      return undefined;
    }
  }

  /** Write a value to the `meta` store (idempotent put by `key`). Best-effort: IDB unavailable / closed →
   *  graceful no-op (the value is also held in memory by its writer; a missed persist just re-fetches one
   *  idempotent page on the next catch-up). */
  async putMeta(key: string, value: unknown): Promise<void> {
    return this.runAccountOperation(() => this.putMetaInternal(key, value));
  }

  private async putMetaInternal(key: string, value: unknown): Promise<void> {
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
      await (await this.db()).put('settings', { key, value });
    } catch {
      /* best-effort */
    }
  }

  // ---- avatar store: identity-keyed blobs --------------------------------------------------

  /** Read an avatar blob by identity and refresh its last-render metadata. */
  async getAvatar(identity: string): Promise<AvatarRecord | undefined> {
    return this.runAccountOperation(() => this.getAvatarInternal(identity));
  }

  private async getAvatarInternal(
    identity: string,
  ): Promise<AvatarRecord | undefined> {
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
      await db.put('avatars', rec).catch(() => {});
    }
    return rec;
  }

  /** Store/overwrite an avatar blob under its stable identity. */
  async putAvatar(record: AvatarRecord): Promise<void> {
    return this.runAccountOperation(() => this.putAvatarInternal(record));
  }

  private async putAvatarInternal(record: AvatarRecord): Promise<void> {
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
    return this.runAccountOperation(() => this.getThreadsInternal());
  }

  async getFriendRequestPage(
    bucket: 'RECEIVED' | 'SENT',
    cursor: string | null,
    take: number,
  ): Promise<{
    items: FriendRequestProjection[];
    total: number;
    actionableTotal: number;
  }> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<{
          items: FriendRequestProjection[];
          total: number;
          actionableTotal: number;
        }>('native_db_page_friend_requests', {
          userId: Number(this.currentUserId),
          bucket,
          cursor,
          take,
        });
      const db = await this.db();
      const index = db
        .transaction('friendRequests')
        .store.index('bucketStatus');
      const statuses = ['REQUESTED', 'ACCEPTED', 'REVOKED'] as const;
      const buckets = await Promise.all(
        statuses.map((status) =>
          index.getAll(
            IDBKeyRange.bound(
              [bucket, status, 0, ''],
              [bucket, status, Number.MAX_SAFE_INTEGER, '\uffff'],
            ),
          ),
        ),
      );
      const upper = cursor
        ? (JSON.parse(cursor) as [number, string])
        : ([Number.MAX_SAFE_INTEGER, '\uffff'] as const);
      const all = buckets.flat();
      const items = all
        .sort(
          (a, b) =>
            b.requestedSort - a.requestedSort || b.key.localeCompare(a.key),
        )
        .filter(
          (item) =>
            !cursor ||
            item.requestedSort < upper[0] ||
            (item.requestedSort === upper[0] && item.key < upper[1]),
        )
        .slice(0, take);
      return {
        items,
        total: all.length,
        actionableTotal: bucket === 'RECEIVED' ? buckets[0].length : all.length,
      };
    });
  }

  async markFriendRequestAccepted(key: string): Promise<void> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_mark_friend_request_accepted', {
          userId: Number(this.currentUserId),
          key,
        });
        return;
      }
      const db = await this.db();
      const current = await db.get('friendRequests', key);
      if (current)
        await db.put('friendRequests', markProjectionAccepted(current));
    });
  }

  async cleanupFriendRequests(now = Date.now()): Promise<void> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_cleanup_friend_requests', {
          userId: Number(this.currentUserId),
          now,
        });
        return;
      }
      const db = await this.db();
      const tx = db.transaction(['friendRequests', 'profiles'], 'readwrite');
      for (const item of await tx.objectStore('friendRequests').getAll()) {
        if (!projectionIsExpired(item, now)) continue;
        await tx.objectStore('friendRequests').delete(item.key);
      }
      for (const profile of await tx.objectStore('profiles').getAll()) {
        if (
          (profile.source === 'OUTGOING_FRIEND_REQUEST' ||
            profile.source === 'GROUP_INVITE') &&
          profile.expiresAt !== undefined &&
          profile.expiresAt <= now
        )
          await tx.objectStore('profiles').delete(profile.identity);
      }
      await tx.done;
    });
  }

  private async getThreadsInternal(): Promise<ConversationItem[]> {
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<ConversationItem[]>('native_db_threads', {
        userId: Number(this.currentUserId),
      });
    }
    return (await this.db()).getAll('threads');
  }

  async replaceThreads(items: ConversationItem[]): Promise<void> {
    return this.runAccountOperation(() => this.replaceThreadsInternal(items));
  }

  private async replaceThreadsInternal(
    items: ConversationItem[],
  ): Promise<void> {
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
    return this.runAccountOperation(() => this.putThreadInternal(item));
  }

  private async putThreadInternal(item: ConversationItem): Promise<void> {
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
    return this.runAccountOperation(() => this.deleteThreadInternal(threadId));
  }

  private async deleteThreadInternal(threadId: number): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_delete_thread', {
        userId: Number(this.currentUserId),
        threadId,
      });
      return;
    }
    await (await this.db()).delete('threads', threadId);
  }

  /** Apply one compacted state-feed page and its cursor atomically. */
  async applyStateFeedPage(
    items: ClientStateFeedItem[],
    feedId: number,
    groupMeta: readonly ClientGroupMetaApply[] = [],
    resetProjection = false,
  ): Promise<void> {
    return this.runAccountOperation(() =>
      this.applyStateFeedPageInternal(
        items,
        feedId,
        groupMeta,
        resetProjection,
      ),
    );
  }

  private async applyStateFeedPageInternal(
    items: ClientStateFeedItem[],
    feedId: number,
    groupMeta: readonly ClientGroupMetaApply[],
    resetProjection: boolean,
  ): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_apply_state_feed_page', {
        userId: Number(this.currentUserId),
        feedId,
        items,
        groupMeta,
        resetProjection,
      });
      return;
    }
    const db = await this.db();
    const tx = db.transaction(
      [
        'threads',
        'profiles',
        'threadParticipants',
        'friendRequests',
        'relationshipIntents',
        'settings',
      ],
      'readwrite',
    );
    if (resetProjection) {
      await tx.objectStore('friendRequests').clear();
      await tx.objectStore('relationshipIntents').clear();
      await tx.objectStore('threadParticipants').clear();
      const profiles = tx.objectStore('profiles');
      for (const profile of await profiles.getAll()) {
        if (
          profile.source === 'OUTGOING_FRIEND_REQUEST' ||
          profile.source === 'GROUP_INVITE'
        )
          await profiles.delete(profile.identity);
      }
      const threads = tx.objectStore('threads');
      for (const thread of await threads.getAll()) {
        await threads.put({
          ...thread,
          blocked: false,
          ...(thread.type === 'P2P'
            ? {
                friendshipActive: false,
                conversationState: 'READ_ONLY' as const,
              }
            : {}),
        });
      }
    }
    const applyRequestProjectionEffect = async (
      op: ClientRelationshipIntentItem,
    ) => {
      const store = tx.objectStore('friendRequests');
      if (op.account.startsWith('!') || op.subjectAccount.startsWith('!')) {
        const body = op.body as Omit<
          ClientGroupInviteIntent,
          | 'key'
          | 'account'
          | 'domain'
          | 'subjectAccount'
          | 'subjectDomain'
          | 'kind'
        >;
        const groupAuthored = op.account.startsWith('!');
        const groupAccount = groupAuthored ? op.account : op.subjectAccount;
        const groupDomain = groupAuthored ? op.domain : op.subjectDomain;
        const direction =
          body.direction ?? (groupAuthored ? 'INCOMING' : 'OUTGOING');
        const targetDirection = projectionDirectionForFact({
          status: body.status,
          direction,
        });
        if (targetDirection === null) return;
        const key = groupRequestKey(groupDomain, groupAccount, targetDirection);
        const transition = applyGroupIntentToProjection(
          await store.get(key),
          { account: groupAccount, domain: groupDomain, ...body, direction },
          Date.now(),
        );
        if (transition.record) await store.put(transition.record);
        const identity = `pending-group:${groupDomain}\u0000${groupAccount}`;
        if (
          transition.record?.status === 'REQUESTED' &&
          projectionRequestExpiresAt(transition.record) !== null
        )
          await tx.objectStore('profiles').put({
            identity,
            id: 0,
            kind: 'group',
            name: body.group.name,
            account: body.group.account,
            avatar: body.group.avatar,
            bio: body.group.description,
            domain: body.group.domain,
            profileRev: body.group.profileRev,
            source: 'GROUP_INVITE',
            expiresAt: projectionRequestExpiresAt(transition.record)!,
          });
        if (transition.becameActionable)
          await tx.objectStore('settings').put({
            key: 'friendRequestStateRevision',
            value: op.feedId,
          });
        return;
      }
      const body = op.body as Omit<
        ClientFriendIntent,
        | 'key'
        | 'account'
        | 'domain'
        | 'subjectAccount'
        | 'subjectDomain'
        | 'requestedSort'
      >;
      const targetDirection = projectionDirectionForFact(body);
      if (targetDirection === null) return;
      const projectionKey = friendRequestKey(
        { ...op, direction: body.direction },
        targetDirection,
      );
      const transition = applyFriendIntentToProjection(
        await store.get(projectionKey),
        {
          account: op.account,
          domain: op.domain,
          subjectAccount: op.subjectAccount,
          subjectDomain: op.subjectDomain,
          ...body,
        },
        Date.now(),
      );
      if (transition.record) await store.put(transition.record);
      if (
        body.status === 'REQUESTED' &&
        transition.record !== null &&
        projectionRequestExpiresAt(transition.record) !== null &&
        body.direction === 'OUTGOING'
      ) {
        const peer = body.peer;
        await tx.objectStore('profiles').put({
          identity: `pending:${peer.domain}\u0000${peer.account}`,
          id: 0,
          kind: 'user',
          name: peer.name || peer.account,
          account: peer.account,
          avatar: peer.avatar,
          bio: peer.bio ?? '',
          domain: peer.domain,
          profileRev: 0,
          source: 'OUTGOING_FRIEND_REQUEST',
          expiresAt: projectionRequestExpiresAt(transition.record)!,
        });
      }
      if (transition.becameActionable)
        await tx.objectStore('settings').put({
          key: 'friendRequestStateRevision',
          value: op.feedId,
        });
    };
    // Apply each authoritative fact and its pair fold before running that item's disposable request
    // projection effect. Group relationships are folded before group-meta from the same page.
    for (const op of items) {
      if (op.eventType !== 'RELATIONSHIP_INTENT') continue;
      const body = op.body as ClientRelationshipIntentBody;
      const now = Date.now();
      const key = relationshipIntentKey(op);
      const reverseKey = reverseRelationshipIntentKey(op);
      const facts = tx.objectStore('relationshipIntents');
      const fact: RelationshipIntentFact = {
        key,
        reverseKey,
        status: body.status,
        expiresAt: body.expiresAt,
        localThreadId:
          'localThreadId' in body ? body.localThreadId : body.threadId,
        updatedAt: now,
      };
      await facts.put(fact);
      const reverseFact = await facts.get(reverseKey);
      const active = relationshipFactsAreActive(fact, reverseFact, now);
      const threadId = fact.localThreadId;
      if (threadId !== null) {
        const threads = tx.objectStore('threads');
        const existing = await threads.get(threadId);
        if (op.account.startsWith('!') || op.subjectAccount.startsWith('!')) {
          const groupBody = body as Omit<
            ClientGroupInviteIntent,
            | 'key'
            | 'account'
            | 'domain'
            | 'subjectAccount'
            | 'subjectDomain'
            | 'kind'
          >;
          if (active && !existing)
            await threads.put(
              createGroupConversation(
                threadId,
                { id: threadId, ownerId: 0, ...groupBody.group },
                { role: null },
              ),
            );
        } else {
          const friendBody = body as Omit<
            ClientFriendIntent,
            | 'key'
            | 'account'
            | 'domain'
            | 'subjectAccount'
            | 'subjectDomain'
            | 'requestedSort'
          >;
          if (existing?.type === 'P2P')
            await threads.put({
              ...existing,
              friendshipActive: active,
              conversationState: active ? 'ACTIVE' : 'READ_ONLY',
              peerUser: { ...existing.peerUser, ...friendBody.peer },
            });
          else if (active)
            await threads.put(createP2PConversation(threadId, friendBody.peer));
        }
      }
      await applyRequestProjectionEffect(op);
    }
    for (const update of groupMeta) {
      const participants = tx.objectStore('threadParticipants');
      let memberCount = 0;
      if (update.page.mode === 'full') {
        let cursor = await participants.openCursor(
          IDBKeyRange.bound(
            [update.threadId, Number.MIN_SAFE_INTEGER],
            [update.threadId, Number.MAX_SAFE_INTEGER],
          ),
        );
        while (cursor) {
          await cursor.delete();
          cursor = await cursor.continue();
        }
      } else {
        const thread = await tx.objectStore('threads').get(update.threadId);
        memberCount =
          thread?.type === 'GROUP' ? (thread.group.memberCount ?? 0) : 0;
      }
      for (const item of update.page.items) {
        const previous = await participants
          .index('identity')
          .get([update.threadId, item.domain, item.account]);
        if (item.operation === 'DELETE') {
          if (previous) {
            await participants.delete([update.threadId, previous.userId]);
            memberCount--;
          }
          continue;
        }
        const body = item.body as {
          userId: number;
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          profileRev: number;
          displayName: string;
          avatar: string | null;
        };
        if (!Number.isSafeInteger(body.userId) || body.userId < 1)
          throw new Error('group-meta UPSERT has no valid userId');
        await participants.put({
          threadId: update.threadId,
          userId: body.userId,
          memberAccount: item.account,
          memberDomain: item.domain,
          role: body.role,
          displayName: body.displayName,
          avatar: body.avatar ?? '',
          profileRev: body.profileRev,
        });
        if (!previous) memberCount++;
      }
      const thread = await tx.objectStore('threads').get(update.threadId);
      if (thread?.type === 'GROUP') {
        const selfUserId = Number(this.currentUserId);
        const self =
          this.currentUserId !== null && Number.isSafeInteger(selfUserId)
            ? await participants.get([update.threadId, selfUserId])
            : undefined;
        const { members: _members, ...group } =
          thread.group as typeof thread.group & {
            members?: unknown;
          };
        await tx.objectStore('threads').put({
          ...thread,
          role: self?.role ?? null,
          group: {
            ...group,
            memberCount,
            groupMetaFeedId: update.page.scannedThrough,
          },
        });
      }
    }
    for (const op of items) {
      if (op.eventType === 'RELATIONSHIP_INTENT') continue;
      if (op.eventType === 'PROFILE') {
        const profiles = tx.objectStore('profiles');
        const body = op.body;
        for (const profile of await profiles.getAll()) {
          if (
            profile.account !== op.account ||
            profile.domain !== op.domain ||
            body.profileRev < profile.profileRev
          )
            continue;
          await profiles.put({
            ...profile,
            name: body.displayName,
            avatar: body.avatar ?? '',
            bio: body.bio,
            profileRev: body.profileRev,
          });
        }
        const friendRequests = tx.objectStore('friendRequests');
        for (const request of await friendRequests.getAll()) {
          if (request.kind === 'GROUP') {
            if (
              request.group?.account !== op.account ||
              request.group.domain !== op.domain ||
              body.profileRev < request.group.profileRev
            )
              continue;
            await friendRequests.put({
              ...request,
              group: {
                ...request.group,
                name: body.displayName,
                avatar: body.avatar ?? '',
                description: body.bio,
                profileRev: body.profileRev,
              },
            });
            continue;
          }
        }
        const threads = tx.objectStore('threads');
        for (const thread of await threads.getAll()) {
          if (
            thread.type === 'P2P' &&
            thread.peerUser.account === op.account &&
            (thread.peerUser.domain ?? '') === op.domain &&
            body.profileRev >= (thread.peerUser.profileRev ?? 0)
          )
            await threads.put({
              ...thread,
              peerUser: {
                ...thread.peerUser,
                name: body.displayName,
                bio: body.bio,
                avatar: body.avatar ?? '',
                profileRev: body.profileRev,
              },
            });
          else if (
            thread.type === 'GROUP' &&
            thread.group.account === op.account &&
            thread.group.domain === op.domain &&
            body.profileRev >= thread.group.profileRev
          )
            await threads.put({
              ...thread,
              group: {
                ...thread.group,
                name: body.displayName,
                description: body.bio,
                avatar: body.avatar ?? '',
                profileRev: body.profileRev,
              },
            });
        }
        continue;
      }
      if (op.eventType === 'GROUP_JOIN_REQUEST_HEAD') {
        const latestFeedId = op.body.latestFeedId;
        if (latestFeedId > 0) {
          const setting = await tx
            .objectStore('settings')
            .get('groupJoinRequestHeads');
          const heads =
            setting?.value && typeof setting.value === 'object'
              ? { ...(setting.value as Record<string, number>) }
              : {};
          const current = Number(heads[String(op.body.threadId)] ?? 0);
          heads[String(op.body.threadId)] =
            current >= latestFeedId ? current : latestFeedId;
          await tx.objectStore('settings').put({
            key: 'groupJoinRequestHeads',
            value: heads,
          });
          const readSetting = await tx
            .objectStore('settings')
            .get('groupJoinRequestReadFeedIds');
          const reads =
            readSetting?.value && typeof readSetting.value === 'object'
              ? { ...(readSetting.value as Record<string, number>) }
              : {};
          const currentRead = Number(reads[String(op.body.threadId)] ?? 0);
          reads[String(op.body.threadId)] =
            currentRead >= op.body.readFeedId
              ? currentRead
              : op.body.readFeedId;
          await tx.objectStore('settings').put({
            key: 'groupJoinRequestReadFeedIds',
            value: reads,
          });
        }
        continue;
      }
      if (op.eventType === 'INCOMING_INVITE_HEAD') {
        await tx.objectStore('settings').put({
          key: 'incomingInviteHead',
          value: op.body,
        });
        continue;
      }
      if (op.eventType === 'THREAD_BLOCK') {
        const thread = await tx.objectStore('threads').get(op.body.threadId);
        if (thread)
          await tx.objectStore('threads').put({
            ...thread,
            blocked: op.body.blocked,
          });
      }
    }
    await tx.objectStore('settings').put({ key: 'stateFeedId', value: feedId });
    await tx.done;
  }

  /** Commit the refreshed thread-list snapshot and its missed-message cursor as one durable unit. */
  async applyCatchUp(items: ConversationItem[], cursor: number): Promise<void> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_apply_catch_up', {
          userId: Number(this.currentUserId),
          items,
          cursor,
        });
        if (isAndroidNative()) window.SomsFcm?.setMessageFeedCursor(cursor);
        return;
      }
      const db = await this.db();
      const tx = db.transaction(['threads', 'settings'], 'readwrite');
      await tx.objectStore('threads').clear();
      for (const item of items) await tx.objectStore('threads').put(item);
      await tx
        .objectStore('settings')
        .put({ key: 'messageFeedCursor', value: cursor });
      await tx.done;
    });
  }

  async getProfile(identity: string): Promise<ProfileRecord | undefined> {
    return this.runAccountOperation(() => this.getProfileInternal(identity));
  }

  async queryGroupMembers(params: {
    threadId: number;
    afterUserId?: number;
    take: number;
    search?: string;
  }): Promise<ThreadParticipantRecord[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<ThreadParticipantRecord[]>(
          'native_db_query_group_members',
          {
            userId: Number(this.currentUserId),
            threadId: params.threadId,
            afterUserId: params.afterUserId ?? 0,
            take: params.take,
            search: params.search?.trim() ?? '',
          },
        );
      const db = await this.db();
      const result: ThreadParticipantRecord[] = [];
      const search = params.search?.trim().toLocaleLowerCase() ?? '';
      let cursor = await db
        .transaction('threadParticipants')
        .store.openCursor(
          IDBKeyRange.bound(
            [params.threadId, (params.afterUserId ?? 0) + 1],
            [params.threadId, Number.MAX_SAFE_INTEGER],
          ),
        );
      while (cursor && result.length < params.take) {
        const member = cursor.value;
        if (
          !search ||
          member.displayName.toLocaleLowerCase().includes(search) ||
          member.memberAccount.toLocaleLowerCase().includes(search)
        )
          result.push(member);
        cursor = await cursor.continue();
      }
      return result;
    });
  }

  private async getProfileInternal(
    identity: string,
  ): Promise<ProfileRecord | undefined> {
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
    return this.runAccountOperation(() => this.putProfileInternal(record));
  }

  private async putProfileInternal(record: ProfileRecord): Promise<boolean> {
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
    return this.runMessageOperation(() =>
      this.queryCachedMessagesInternal(threadId, orderBy, take, anchor),
    );
  }

  private async queryCachedMessagesInternal(
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
    const db = await this.messageDb();
    const lower =
      anchor === undefined || orderBy === 'desc' ? -Infinity : anchor;
    const upper = anchor === undefined || orderBy === 'asc' ? Infinity : anchor;
    const range = IDBKeyRange.bound(
      [threadId, lower],
      [threadId, upper],
      orderBy === 'asc' && anchor !== undefined,
      orderBy === 'desc' && anchor !== undefined,
    );
    const out: Message[] = [];
    const tx = db.transaction('messages', 'readonly');
    let cursor = await tx.store.openCursor(
      range,
      orderBy === 'desc' ? 'prev' : 'next',
    );
    while (cursor && out.length < take) {
      if (!cursor.value.isDeleted) out.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return out;
  }

  /** Idempotently store messages and atomically merge an optional server-confirmed complete section. */
  async putMessages(
    messages: Message[],
    confirmedSection?: { threadId: number; left: number; right: number },
    knownNewest?: { threadId: number; seq: number },
    lifetime?: AbortSignal,
  ): Promise<MessageCoverageState | undefined> {
    return this.runMessageOperation(
      () => this.putMessagesInternal(messages, confirmedSection, knownNewest),
      lifetime,
    );
  }

  private async putMessagesInternal(
    messages: Message[],
    confirmedSection?: { threadId: number; left: number; right: number },
    knownNewest?: { threadId: number; seq: number },
  ): Promise<MessageCoverageState | undefined> {
    if (messages.length === 0 && !confirmedSection && knownNewest === undefined)
      return undefined;
    if (isTauri() && this.currentUserId != null) {
      return (
        (await tauriInvoke<MessageCoverageState | null>(
          'native_db_put_messages',
          {
            userId: Number(this.currentUserId),
            messages,
            confirmedSection: confirmedSection ?? null,
            knownNewestSeq: knownNewest?.seq ?? null,
            coverageThreadId: knownNewest?.threadId ?? null,
          },
        )) ?? undefined
      );
    }
    const tx = (await this.messageDb()).transaction(
      ['messages', 'settings'],
      'readwrite',
    );
    const messageStore = tx.objectStore('messages');
    const incoming = new Map<string, Message>();
    const existing = new Set<string>();
    for (const message of messages) {
      const key = `${message.threadId}:${message.seq}`;
      incoming.set(key, message);
    }
    // HTTP cache fills are additive. A repeated/overlapping response must not rewrite every row it
    // happens to contain: only absent rows are inserted here. Once the final merged section is known,
    // its two boundary rows are the sole existing rows eligible for an authoritative refresh below.
    for (const [key, message] of incoming) {
      const old = await messageStore.get([message.threadId, message.seq]);
      if (old) {
        existing.add(key);
        continue;
      }
      await messageStore.put(message);
    }
    const threadId =
      confirmedSection?.threadId ??
      knownNewest?.threadId ??
      messages[0]?.threadId;
    const key =
      threadId === undefined ? undefined : messageCoverageKey(threadId);
    const old = key
      ? parseMessageCoverage((await tx.objectStore('settings').get(key))?.value)
      : undefined;
    const merged = confirmedSection
      ? await this.mergeSectionInTx(tx, confirmedSection, old?.coveredTail)
      : undefined;
    if (merged && confirmedSection) {
      for (const seq of new Set([merged.left, merged.right])) {
        const mapKey = `${confirmedSection.threadId}:${seq}`;
        const message = incoming.get(mapKey);
        if (!message || !existing.has(mapKey)) continue;
        const current = await messageStore.get([
          confirmedSection.threadId,
          seq,
        ]);
        if (!current) throw new Error('merged message boundary is missing');
        // A deletion pull can win while this HTTP page is in flight. Boundary refreshes are the one
        // additive-cache path that rewrites an existing row, so explicitly preserve the tombstone.
        if (current.isDeleted) continue;
        await messageStore.put({
          ...message,
          ...(current.sectionLeft ? { sectionLeft: 1 as const } : {}),
          ...(current.sectionRight ? { sectionRight: 1 as const } : {}),
        });
      }
    }
    let coverage: MessageCoverageState | undefined;
    if (threadId !== undefined && key !== undefined) {
      const knownNewestSeq = Math.max(
        knownNewest?.seq ?? -1,
        old?.knownNewestSeq ?? -1,
        merged?.right ?? -1,
      );
      if (knownNewestSeq >= 0) {
        coverage = {
          threadId,
          knownNewestSeq,
          coveredTail: mergeCoveredTail(old?.coveredTail, merged),
        };
        await tx.objectStore('settings').put({ key, value: coverage });
      }
    }
    await tx.done;
    return coverage;
  }

  private async mergeSectionInTx(
    tx: IDBPTransaction<MessageDbSchema, ['messages', 'settings'], 'readwrite'>,
    section: { threadId: number; left: number; right: number },
    coveredTail?: MessageSection | null,
  ): Promise<MessageSection> {
    const store = tx.objectStore('messages');
    let left = Math.min(section.left, section.right);
    let right = Math.max(section.left, section.right);
    if (coveredTail && left >= coveredTail.left && right <= coveredTail.right) {
      return coveredTail;
    }
    if (coveredTail && left > coveredTail.right) {
      if (left === coveredTail.right + 1) left = coveredTail.left;
      // coveredTail is the right-most persisted section. A disjoint range to its right cannot meet
      // another old section, while an adjacent range joins it directly.
    } else if (coveredTail && right >= coveredTail.left - 1) {
      // The incoming range reaches the tail from its left or starts inside it. Its right edge is known
      // without a lookup; only an incoming left edge outside the tail can connect farther left.
      if (left < coveredTail.left)
        left = await this.resolveMergedLeft(tx, section.threadId, left);
      else left = coveredTail.left;
      right = Math.max(right, coveredTail.right);
    } else {
      // Disjoint to the left of coveredTail (or no tail): only the nearest typed edge at each endpoint
      // can affect the outer result. Sections crossed between them are internal and need no read.
      left = await this.resolveMergedLeft(tx, section.threadId, left);
      right = await this.resolveMergedRight(tx, section.threadId, right);
    }

    const touched = new Map<number, CachedMessage>();
    for (const indexName of ['sectionLeft', 'sectionRight'] as const) {
      const index = store.index(indexName);
      let cursor = await index.openCursor(
        IDBKeyRange.bound(
          [section.threadId, 1, left],
          [section.threadId, 1, right],
        ),
      );
      while (cursor) {
        touched.set(cursor.value.seq, cursor.value);
        cursor = await cursor.continue();
      }
    }
    for (const edge of touched.values()) {
      const next = { ...edge };
      delete next.sectionLeft;
      delete next.sectionRight;
      await store.put(next);
    }
    const leftRow = (await store.get([section.threadId, left]))!;
    const rightRow = (await store.get([section.threadId, right]))!;
    if (!leftRow || !rightRow)
      throw new Error('merged message section boundary is missing');
    if (left === right) {
      await store.put({ ...leftRow, sectionLeft: 1, sectionRight: 1 });
    } else {
      await store.put({ ...leftRow, sectionLeft: 1 });
      await store.put({ ...rightRow, sectionRight: 1 });
    }
    return { left, right };
  }

  private async resolveMergedLeft(
    tx: IDBPTransaction<MessageDbSchema, ['messages', 'settings'], 'readwrite'>,
    threadId: number,
    seq: number,
  ): Promise<number> {
    const edge = await this.nearestMessageEdge(tx, threadId, seq, 'before');
    if (!edge) return seq;
    if (edge.sectionLeft && !edge.sectionRight) return edge.seq;
    if (edge.seq < seq - 1 || !edge.sectionRight) return seq;
    const paired = await tx
      .objectStore('messages')
      .index('sectionLeft')
      .openCursor(
        IDBKeyRange.bound([threadId, 1, -Infinity], [threadId, 1, edge.seq]),
        'prev',
      );
    if (!paired) throw new Error('message section right edge has no left');
    const matchingRight = await tx
      .objectStore('messages')
      .index('sectionRight')
      .openCursor(
        IDBKeyRange.bound(
          [threadId, 1, paired.value.seq],
          [threadId, 1, Infinity],
        ),
      );
    if (matchingRight?.value.seq !== edge.seq)
      throw new Error('message section edges are not paired');
    return paired.value.seq;
  }

  private async resolveMergedRight(
    tx: IDBPTransaction<MessageDbSchema, ['messages', 'settings'], 'readwrite'>,
    threadId: number,
    seq: number,
  ): Promise<number> {
    const edge = await this.nearestMessageEdge(tx, threadId, seq, 'after');
    if (!edge) return seq;
    if (edge.sectionRight) return edge.seq;
    if (edge.seq > seq + 1 || !edge.sectionLeft) return seq;
    const paired = await tx
      .objectStore('messages')
      .index('sectionRight')
      .openCursor(
        IDBKeyRange.bound([threadId, 1, edge.seq], [threadId, 1, Infinity]),
      );
    if (!paired) throw new Error('message section left edge has no right');
    const matchingLeft = await tx
      .objectStore('messages')
      .index('sectionLeft')
      .openCursor(
        IDBKeyRange.bound(
          [threadId, 1, -Infinity],
          [threadId, 1, paired.value.seq],
        ),
        'prev',
      );
    if (matchingLeft?.value.seq !== edge.seq)
      throw new Error('message section edges are not paired');
    return paired.value.seq;
  }

  private async nearestMessageEdge(
    tx: IDBPTransaction<MessageDbSchema, ['messages', 'settings'], 'readwrite'>,
    threadId: number,
    seq: number,
    direction: 'before' | 'after',
  ): Promise<CachedMessage | undefined> {
    const range =
      direction === 'before'
        ? IDBKeyRange.bound([threadId, 1, -Infinity], [threadId, 1, seq])
        : IDBKeyRange.bound([threadId, 1, seq], [threadId, 1, Infinity]);
    const cursorDirection = direction === 'before' ? 'prev' : 'next';
    const [left, right] = await Promise.all([
      tx
        .objectStore('messages')
        .index('sectionLeft')
        .openCursor(range, cursorDirection),
      tx
        .objectStore('messages')
        .index('sectionRight')
        .openCursor(range, cursorDirection),
    ]);
    if (!left) return right?.value;
    if (!right) return left.value;
    if (left.value.seq === right.value.seq)
      return { ...left.value, sectionLeft: 1, sectionRight: 1 };
    return direction === 'before'
      ? left.value.seq > right.value.seq
        ? left.value
        : right.value
      : left.value.seq < right.value.seq
        ? left.value
        : right.value;
  }

  async getMessageCoverage(
    threadId: number,
  ): Promise<MessageCoverageState | undefined> {
    return this.runMessageOperation(() =>
      this.getMessageCoverageInternal(threadId),
    );
  }

  private async getMessageCoverageInternal(
    threadId: number,
  ): Promise<MessageCoverageState | undefined> {
    if (isTauri() && this.currentUserId != null) {
      return (
        (await tauriInvoke<MessageCoverageState | null>(
          'native_db_message_coverage',
          {
            userId: Number(this.currentUserId),
            threadId,
          },
        )) ?? undefined
      );
    }
    return parseMessageCoverage(
      (
        await (
          await this.messageDb()
        ).get('settings', messageCoverageKey(threadId))
      )?.value,
    );
  }

  private async sectionStartingAtInTx(
    tx: IDBPTransaction<
      MessageDbSchema,
      ['messages'],
      'readonly' | 'readwrite'
    >,
    threadId: number,
    left: number,
  ): Promise<MessageSection | undefined> {
    const cursor = await tx
      .objectStore('messages')
      .index('sectionRight')
      .openCursor(
        IDBKeyRange.bound([threadId, 1, left], [threadId, 1, Infinity]),
        'next',
      );
    return cursor ? { left, right: cursor.value.seq } : undefined;
  }

  async getMessageSection(
    threadId: number,
    seq: number,
  ): Promise<MessageSection | undefined> {
    return this.runMessageOperation(() =>
      this.getMessageSectionInternal(threadId, seq),
    );
  }

  private async getMessageSectionInternal(
    threadId: number,
    seq: number,
  ): Promise<MessageSection | undefined> {
    if (isTauri() && this.currentUserId != null) {
      const section = await tauriInvoke<MessageSection | null>(
        'native_db_message_section',
        {
          userId: Number(this.currentUserId),
          threadId,
          seq,
        },
      );
      return section ? { left: section.left, right: section.right } : undefined;
    }
    const tx = (await this.messageDb()).transaction('messages', 'readonly');
    const left = await tx.store
      .index('sectionLeft')
      .openCursor(
        IDBKeyRange.bound([threadId, 1, -Infinity], [threadId, 1, seq]),
        'prev',
      );
    if (!left) {
      await tx.done;
      return undefined;
    }
    const section = await this.sectionStartingAtInTx(
      tx,
      threadId,
      left.value.seq,
    );
    await tx.done;
    return section && seq <= section.right ? section : undefined;
  }

  async getMessage(
    threadId: number,
    seq: number,
  ): Promise<Message | undefined> {
    return this.runMessageOperation(() =>
      this.getMessageInternal(threadId, seq),
    );
  }

  async getDeletedHwm(threadId: number): Promise<string> {
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        const hwm = await tauriInvoke<string>('native_db_get_deleted_hwm', {
          userId: Number(this.currentUserId),
          threadId,
        });
        return hwm;
      }
      const row = await (
        await this.messageDb()
      ).get('settings', `deletedHwm:${threadId}`);
      if (typeof row?.value === 'string') return row.value;
      return '0';
    });
  }

  async applyDeletedMessages(
    threadId: number,
    items: DeletedMessageItem[],
    hwm: string,
  ): Promise<void> {
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_apply_deleted_messages', {
          userId: Number(this.currentUserId),
          threadId,
          items,
          hwm,
        });
        return;
      }
      const tx = (await this.messageDb()).transaction(
        ['messages', 'settings'],
        'readwrite',
      );
      for (const item of items) {
        const current = await tx
          .objectStore('messages')
          .get([threadId, item.seq]);
        if (current) {
          await tx.objectStore('messages').put({ ...current, isDeleted: true });
        } else {
          await tx.objectStore('messages').put({
            threadId,
            seq: item.seq,
            isDeleted: true,
            content: '',
            contentType: 'PURE_TEXT',
            creator: 0,
            createdAt: 0,
            updatedAt: 0,
          } as CachedMessage);
        }
      }
      await tx.objectStore('settings').put({
        key: `deletedHwm:${threadId}`,
        value: hwm,
      });
      await tx.done;
    });
  }

  private async getMessageInternal(
    threadId: number,
    seq: number,
  ): Promise<Message | undefined> {
    if (isTauri() && this.currentUserId != null) {
      return (
        (await tauriInvoke<Message | null>('native_db_get_message', {
          userId: Number(this.currentUserId),
          threadId,
          seq,
        })) ?? undefined
      );
    }
    const value = await (
      await this.messageDb()
    ).get('messages', [threadId, seq]);
    return value?.isDeleted ? undefined : value;
  }

  async getNewestMessages(threadIds: number[]): Promise<Message[]> {
    return this.runMessageOperation(() =>
      this.getNewestMessagesInternal(threadIds),
    );
  }

  private async getNewestMessagesInternal(
    threadIds: number[],
  ): Promise<Message[]> {
    if (threadIds.length === 0) return [];
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<Message[]>('native_db_newest_messages', {
        userId: Number(this.currentUserId),
        threadIds,
      });
    }
    const tx = (await this.messageDb()).transaction('messages', 'readonly');
    const messages = await Promise.all(
      threadIds.map(async (threadId) => {
        const cursor = await tx.store.openCursor(
          IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
          'prev',
        );
        let current = cursor;
        while (current?.value.isDeleted) current = await current.continue();
        return current?.value;
      }),
    );
    await tx.done;
    return messages.filter(
      (message): message is Message => message !== undefined,
    );
  }

  async deleteMessagesByThread(threadId: number): Promise<void> {
    return this.runMessageOperation(() =>
      this.deleteMessagesByThreadInternal(threadId),
    );
  }

  private async deleteMessagesByThreadInternal(
    threadId: number,
  ): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      await tauriInvoke('native_db_delete_messages_by_thread', {
        userId: Number(this.currentUserId),
        threadId,
      });
      return;
    }
    const tx = (await this.messageDb()).transaction(
      ['messages', 'settings'],
      'readwrite',
    );
    await tx
      .objectStore('messages')
      .delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
    await tx.objectStore('settings').delete(messageCoverageKey(threadId));
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
