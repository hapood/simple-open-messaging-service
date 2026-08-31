import {
  Inject,
  Injectable,
  InjectionToken,
  OnDestroy,
  signal,
} from '@angular/core';
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
import {
  reduceMessageRanges,
  type MessageInterval,
  type MessageRange,
  type ServerMessageRange,
} from './message-range';

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

/** Source-scoped person profile. Its logical primary key mirrors backend User exactly. */
export interface UserRecord {
  id?: number;
  name: string;
  account: string;
  avatar: string;
  bio: string;
  domain: string;
  sourceDomain: string;
  namespaceId: number;
  availability: 'AVAILABLE' | 'REMOVED';
  createdAt: number;
  updatedAt: number;
  profileRev: number;
}

/** Group profile. Groups have one authoritative address and are not represented as User rows. */
export interface GroupRecord {
  id?: number;
  name: string;
  account: string;
  avatar: string;
  description: string;
  domain: string;
  namespaceId: number;
  profileRev: number;
  createdAt: number;
  updatedAt: number;
  dissolvedAt?: number | null;
}

export interface NamespaceRecord {
  domain: string;
  namespaceId: number;
  status: 'ACTIVE' | 'ARCHIVED';
}

interface NamespaceRegistryStore {
  get(key: [string, number]): Promise<NamespaceRecord | undefined>;
  put(value: NamespaceRecord): Promise<unknown>;
  index(name: 'domain'): {
    getAll(query: string): Promise<NamespaceRecord[]>;
  };
}

/** One materialized roster member pointing to a source-scoped User logical key. */
export interface MemberRecord {
  threadId: number;
  account: string;
  domain: string;
  sourceDomain: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  left: boolean;
}

export interface ResolvedMemberRecord extends MemberRecord {
  user: UserRecord;
}

/** Compatibility shape for UI repositories while callers move from numeric cache aliases to logical keys. */
export interface ProfileRecord {
  identity: string;
  id: number;
  kind: 'user' | 'group';
  name: string;
  account: string;
  avatar: string;
  bio: string;
  domain: string;
  sourceServer: string;
  namespaceId: number;
  profileRev: number;
}

export interface ClientGroupMetaApply {
  threadId: number;
  sourceServer: string;
  namespaceId: number;
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

type CachedMessageBody = Message;

/** A deletion learned before its message body. It deliberately has no synthetic content or creator. */
export interface CachedMessageTombstone {
  threadId: number;
  seq: number;
  isDeleted: true;
}

export type CachedMessage = CachedMessageBody | CachedMessageTombstone;

function isCachedMessageBody(value: CachedMessage): value is CachedMessageBody {
  return !value.isDeleted && 'content' in value;
}

function readDeletedHwm(value: unknown): number {
  if (value === undefined) return 0;
  if (Number.isSafeInteger(value) && (value as number) >= 0)
    return value as number;
  throw new Error('deleted-message HWM must be a non-negative integer');
}

function messageHeadKey(threadId: number): string {
  return `messageHead:${threadId}`;
}

export interface CommitMessagePageInput {
  threadId: number;
  scan: MessageInterval | null;
  messages: Message[];
  gaps: ServerMessageRange[];
  knownNewestSeq?: number;
}

export interface CommittedMessagePage {
  messages: Message[];
  ranges: MessageRange[];
}

/** Core cache schema. High-volume message data intentionally lives in MessageDbSchema. */
export interface WebdbSchema extends DBSchema {
  namespaces: {
    key: [string, number];
    value: NamespaceRecord;
    indexes: { domain: string };
  };
  avatars: { key: string; value: AvatarRecord };
  users: {
    key: [string, string, string, number];
    value: UserRecord;
    indexes: { address: [string, string, number]; id: number };
  };
  groups: {
    key: [string, string, number];
    value: GroupRecord;
    indexes: { id: number };
  };
  members: {
    key: [number, string, string, string, number];
    value: MemberRecord;
    indexes: {
      thread: number;
      address: [number, string, string, number];
    };
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
  };
  messageRanges: {
    key: [number, number];
    value: MessageRange;
    indexes: { byThreadRight: [number, number] };
  };
}

const DB_PREFIX = 'soms-webdb-u';
const MESSAGE_DB_PREFIX = 'soms-msgdb-u';
export const CACHE_SCHEMA_VERSION = 11;
export const MESSAGE_CACHE_SCHEMA_VERSION = 3;
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

export type StateFeedWorkerFactory = () => Worker | null;

const createBrowserStateFeedWorker: StateFeedWorkerFactory = () => {
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    return null;
  return new Worker(new URL('./state-feed-db.worker', import.meta.url), {
    type: 'module',
  });
};

export const STATE_FEED_WORKER_FACTORY =
  new InjectionToken<StateFeedWorkerFactory>('STATE_FEED_WORKER_FACTORY', {
    providedIn: 'root',
    factory: () => createBrowserStateFeedWorker,
  });

@Injectable({ providedIn: 'root' })
export class WebdbService implements OnDestroy {
  private stateFeedWorker: Worker | null = null;
  private stateFeedWorkerRequestId = 0;
  private readonly stateFeedWorkerPending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
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
  private readonly messageCommitTails = new Map<number, Promise<void>>();
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

  constructor(
    @Inject(STATE_FEED_WORKER_FACTORY)
    private readonly stateFeedWorkerFactory: StateFeedWorkerFactory = createBrowserStateFeedWorker,
  ) {}

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
      'namespaces',
      'users',
      'groups',
      'members',
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
      return (
        version?.value === CACHE_SCHEMA_VERSION &&
        db.transaction('users').store.indexNames.contains('address') &&
        db.transaction('members').store.indexNames.contains('thread') &&
        db.transaction('members').store.indexNames.contains('address')
      );
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
        const namespaces = db.createObjectStore('namespaces', {
          keyPath: ['domain', 'namespaceId'],
        });
        namespaces.createIndex('domain', 'domain');
        namespaces.put({
          domain: 'local',
          namespaceId: 0,
          status: 'ACTIVE',
        });
        const users = db.createObjectStore('users', {
          keyPath: ['account', 'domain', 'sourceDomain', 'namespaceId'],
        });
        users.createIndex('address', ['account', 'domain', 'namespaceId']);
        users.createIndex('id', 'id', { unique: true });
        const groups = db.createObjectStore('groups', {
          keyPath: ['account', 'domain', 'namespaceId'],
        });
        groups.createIndex('id', 'id', { unique: true });
        const members = db.createObjectStore('members', {
          keyPath: [
            'threadId',
            'account',
            'domain',
            'sourceDomain',
            'namespaceId',
          ],
        });
        members.createIndex('thread', 'threadId');
        members.createIndex('address', [
          'threadId',
          'account',
          'domain',
          'namespaceId',
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
        db.createObjectStore('messages', {
          keyPath: ['threadId', 'seq'],
        });
        const ranges = db.createObjectStore('messageRanges', {
          keyPath: ['threadId', 'left'],
        });
        ranges.createIndex('byThreadRight', ['threadId', 'right']);
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
      db.objectStoreNames.length !== 3 ||
      !db.objectStoreNames.contains('settings') ||
      !db.objectStoreNames.contains('messages') ||
      !db.objectStoreNames.contains('messageRanges')
    )
      return false;
    try {
      if (
        (await db.get('settings', 'schemaVersion'))?.value !==
        MESSAGE_CACHE_SCHEMA_VERSION
      )
        return false;
      const rangeIndexes = db.transaction('messageRanges').store.indexNames;
      return rangeIndexes.contains('byThreadRight');
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
    this.terminateStateFeedWorker();
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

  private async withMessageThreadCommit<T>(
    threadId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.messageCommitTails.get(threadId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.messageCommitTails.set(threadId, tail);
    try {
      return await run;
    } finally {
      if (this.messageCommitTails.get(threadId) === tail)
        this.messageCommitTails.delete(threadId);
    }
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
      const tx = db.transaction('friendRequests', 'readwrite');
      for (const item of await tx.objectStore('friendRequests').getAll()) {
        if (!projectionIsExpired(item, now)) continue;
        await tx.objectStore('friendRequests').delete(item.key);
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
    const tx = (await this.db()).transaction(
      ['threads', 'namespaces', 'settings'],
      'readwrite',
    );
    await tx.objectStore('threads').clear();
    for (const item of items) {
      await this.ensureThreadNamespaceInTx(tx, item);
      await tx.objectStore('threads').put(item);
    }
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
    const tx = (await this.db()).transaction(
      ['threads', 'namespaces', 'settings'],
      'readwrite',
    );
    await this.ensureThreadNamespaceInTx(tx, item);
    await tx.objectStore('threads').put(item);
    await tx.done;
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
    await this.runAccountOperation(async () => {
      if (!isTauri() && this.currentUserId !== null) {
        const workerApply = this.applyStateFeedPageInWorker(
          this.currentUserId,
          items,
          feedId,
          groupMeta,
          resetProjection,
        );
        if (workerApply) {
          await workerApply;
          return;
        }
      }
      await this.applyStateFeedPageInternal(
        items,
        feedId,
        groupMeta,
        resetProjection,
      );
    });
    if (isAndroidNative()) window.SomsFcm?.setStateFeedCursor(feedId);
  }

  private applyStateFeedPageInWorker(
    userId: string,
    items: ClientStateFeedItem[],
    feedId: number,
    groupMeta: readonly ClientGroupMetaApply[],
    resetProjection: boolean,
  ): Promise<void> | null {
    if (!this.stateFeedWorker) {
      this.stateFeedWorker = this.stateFeedWorkerFactory();
      if (!this.stateFeedWorker) return null;
      this.stateFeedWorker.onmessage = (
        event: MessageEvent<{ id: number; ok: boolean; error?: string }>,
      ) => {
        const pending = this.stateFeedWorkerPending.get(event.data.id);
        if (!pending) return;
        this.stateFeedWorkerPending.delete(event.data.id);
        if (event.data.ok) pending.resolve();
        else
          pending.reject(
            new Error(event.data.error ?? 'state-feed worker failed'),
          );
      };
      this.stateFeedWorker.onerror = (event) => {
        const error = new Error(event.message || 'state-feed worker crashed');
        for (const pending of this.stateFeedWorkerPending.values())
          pending.reject(error);
        this.stateFeedWorkerPending.clear();
        this.stateFeedWorker?.terminate();
        this.stateFeedWorker = null;
      };
    }
    const id = ++this.stateFeedWorkerRequestId;
    return new Promise<void>((resolve, reject) => {
      this.stateFeedWorkerPending.set(id, { resolve, reject });
      this.stateFeedWorker!.postMessage({
        id,
        type: 'apply',
        userId,
        items,
        feedId,
        groupMeta,
        resetProjection,
      });
    });
  }

  private terminateStateFeedWorker(): void {
    if (!this.stateFeedWorker) return;
    this.stateFeedWorker.terminate();
    this.stateFeedWorker = null;
    const error = new Error('account cache lifetime expired');
    for (const pending of this.stateFeedWorkerPending.values())
      pending.reject(error);
    this.stateFeedWorkerPending.clear();
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
        'namespaces',
        'users',
        'groups',
        'members',
        'friendRequests',
        'relationshipIntents',
        'settings',
      ],
      'readwrite',
    );
    if (resetProjection) {
      await tx.objectStore('friendRequests').clear();
      await tx.objectStore('relationshipIntents').clear();
      await tx.objectStore('members').clear();
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
        const group = {
          ...body.group,
          namespaceId: body.group.domain === 'local' ? 0 : op.namespaceId,
        };
        const key = groupRequestKey(
          op.namespaceId,
          groupDomain,
          groupAccount,
          targetDirection,
        );
        const transition = applyGroupIntentToProjection(
          await store.get(key),
          {
            namespaceId: op.namespaceId,
            account: groupAccount,
            domain: groupDomain,
            ...body,
            group,
            direction,
          },
          Date.now(),
        );
        if (transition.record) await store.put(transition.record);
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
          namespaceId: op.namespaceId,
          account: op.account,
          domain: op.domain,
          subjectAccount: op.subjectAccount,
          subjectDomain: op.subjectDomain,
          ...body,
          peer: {
            ...body.peer,
            namespaceId: body.peer.domain === 'local' ? 0 : op.namespaceId,
          },
        },
        Date.now(),
      );
      if (transition.record) await store.put(transition.record);
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
          const groupNamespaceId =
            groupBody.group.domain === 'local' ? 0 : op.namespaceId;
          if (groupNamespaceId !== 0) {
            const namespaces = tx.objectStore('namespaces');
            await this.registerNamespace(
              namespaces as unknown as NamespaceRegistryStore,
              groupBody.group.domain,
              groupNamespaceId,
            );
          }
          if (active && !existing)
            await threads.put(
              createGroupConversation(
                threadId,
                {
                  id: threadId,
                  ownerId: 0,
                  ...groupBody.group,
                  namespaceId: groupNamespaceId,
                },
                { role: null },
              ),
            );
          if (!active && existing?.type === 'GROUP') {
            const members = tx.objectStore('members');
            let member = await members
              .index('thread')
              .openCursor(IDBKeyRange.only(threadId));
            while (member) {
              await member.delete();
              member = await member.continue();
            }
            await threads.delete(threadId);
            await tx
              .objectStore('groups')
              .delete([
                existing.group.account,
                existing.group.domain,
                existing.group.namespaceId ?? 0,
              ]);
          }
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
          const peer = {
            ...friendBody.peer,
            namespaceId:
              friendBody.peer.domain === 'local' ? 0 : op.namespaceId,
          };
          if (peer.namespaceId !== 0) {
            const namespaces = tx.objectStore('namespaces');
            await this.registerNamespace(
              namespaces as unknown as NamespaceRegistryStore,
              peer.domain,
              peer.namespaceId,
            );
          }
          if (existing?.type === 'P2P')
            await threads.put({
              ...existing,
              friendshipActive: active,
              conversationState: active ? 'ACTIVE' : 'READ_ONLY',
              peerUser: { ...existing.peerUser, ...peer },
            });
          else if (active)
            await threads.put(createP2PConversation(threadId, peer));
        }
      }
      await applyRequestProjectionEffect(op);
    }
    for (const update of groupMeta) {
      if (!update.sourceServer)
        throw new Error(
          'group-meta sourceServer must be canonical and non-empty',
        );
      const namespaces = tx.objectStore('namespaces');
      await this.registerNamespace(
        namespaces as unknown as NamespaceRegistryStore,
        update.sourceServer,
        update.namespaceId,
      );
      const members = tx.objectStore('members');
      const currentThread = await tx
        .objectStore('threads')
        .get(update.threadId);
      if (currentThread?.type !== 'GROUP') continue;
      for (const item of update.page.items) {
        const sourceDomain = update.sourceServer;
        const previous = await members
          .index('address')
          .get([
            update.threadId,
            item.account,
            item.domain,
            update.namespaceId,
          ]);
        if (item.operation === 'DEPART') {
          if (previous) await members.put({ ...previous, left: true });
          continue;
        }
        const body = item.body as {
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          profileRev: number;
          displayName: string;
          avatar: string | null;
        };
        const existingUser = await tx
          .objectStore('users')
          .get([item.account, item.domain, sourceDomain, update.namespaceId]);
        if (!existingUser || body.profileRev >= existingUser.profileRev)
          await tx.objectStore('users').put({
            ...(existingUser?.id === undefined ? {} : { id: existingUser.id }),
            account: item.account,
            domain: item.domain,
            sourceDomain,
            namespaceId: update.namespaceId,
            name: body.displayName,
            avatar: body.avatar ?? '',
            bio: existingUser?.bio ?? '',
            availability: 'AVAILABLE',
            profileRev: body.profileRev,
            createdAt: existingUser?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        await members.put({
          threadId: update.threadId,
          account: item.account,
          domain: item.domain,
          sourceDomain,
          namespaceId: update.namespaceId,
          role: body.role,
          left: false,
        });
      }
      const currentMembers = await members
        .index('thread')
        .getAll(update.threadId);
      const activeMembers = currentMembers.filter((member) => !member.left);
      const thread = await tx.objectStore('threads').get(update.threadId);
      if (thread?.type === 'GROUP') {
        const selfUserId = Number(this.currentUserId);
        const [selfUser] = await tx
          .objectStore('users')
          .index('id')
          .getAll(selfUserId, 1);
        const self = activeMembers.find(
          (member) =>
            selfUser !== undefined &&
            member.account === selfUser.account &&
            member.domain === selfUser.domain,
        );
        const { members: _members, ...group } =
          thread.group as typeof thread.group & {
            members?: unknown;
          };
        await tx.objectStore('threads').put({
          ...thread,
          role: self?.role ?? null,
          group: {
            ...group,
            memberCount: activeMembers.length,
            groupMetaFeedId: update.page.scannedThrough,
          },
        });
      }
    }
    for (const op of items) {
      if (op.eventType === 'RELATIONSHIP_INTENT') continue;
      if (op.eventType === 'PROFILE') {
        const body = op.body;
        const now = Date.now();
        if (op.account.startsWith('!')) {
          const groups = tx.objectStore('groups');
          const namespaceId = op.namespaceId;
          const previous = await groups.get([
            op.account,
            op.domain,
            namespaceId,
          ]);
          if (!previous || body.profileRev >= previous.profileRev)
            await groups.put({
              id: previous?.id,
              account: op.account,
              domain: op.domain,
              namespaceId,
              name: body.displayName,
              avatar: body.avatar ?? '',
              description: body.bio,
              profileRev: body.profileRev,
              dissolvedAt: previous?.dissolvedAt ?? null,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            });
        } else {
          const sourceDomain =
            'sourceDomain' in body && typeof body.sourceDomain === 'string'
              ? body.sourceDomain
              : op.domain;
          const users = tx.objectStore('users');
          const namespaceId = op.namespaceId;
          const previous = await users.get([
            op.account,
            op.domain,
            sourceDomain,
            namespaceId,
          ]);
          if (!previous || body.profileRev >= previous.profileRev)
            await users.put({
              id: previous?.id,
              account: op.account,
              domain: op.domain,
              sourceDomain,
              namespaceId,
              availability: 'AVAILABLE',
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
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
      if (op.eventType === 'THREAD_CONTENT_HEAD') {
        const thread = await tx.objectStore('threads').get(op.body.threadId);
        if (thread)
          await tx.objectStore('threads').put({
            ...thread,
            lastMessageSeq: op.body.messageEndSeq,
            tombstoneEndSeq: op.body.tombstoneEndSeq,
            lastMessagePreviewSeq: op.body.preview.seq,
            lastMessagePreview: op.body.preview.text,
            lastMessageSenderId: op.body.preview.senderId,
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
        continue;
      }
    }
    await tx.objectStore('settings').put({ key: 'stateFeedId', value: feedId });
    await tx.done;
  }

  async getNamespaces(): Promise<NamespaceRecord[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return tauriInvoke<NamespaceRecord[]>('native_db_namespaces', {
          userId: Number(this.currentUserId),
        });
      }
      return (await this.db()).getAll('namespaces');
    });
  }

  async archiveNamespace(domain: string, namespaceId: number): Promise<void> {
    return this.runAccountOperation(async () => {
      if (namespaceId === 0) return;
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_archive_namespace', {
          userId: Number(this.currentUserId),
          domain,
          namespaceId,
        });
        return;
      }
      const tx = (await this.db()).transaction('namespaces', 'readwrite');
      const namespaces = tx.objectStore('namespaces');
      const current = await namespaces.get([domain, namespaceId]);
      if (current) await namespaces.put({ ...current, status: 'ARCHIVED' });
      await tx.done;
    });
  }

  private async ensureThreadNamespaceInTx(
    tx: IDBPTransaction<
      WebdbSchema,
      ('threads' | 'namespaces' | 'settings')[],
      'readwrite'
    >,
    thread: ConversationItem,
  ): Promise<void> {
    if (thread.authorityNamespaceId === 0) return;
    const domain =
      thread.type === 'P2P' ? thread.peerUser.domain : thread.group.domain;
    const namespaces = tx.objectStore(
      'namespaces',
    ) as unknown as NamespaceRegistryStore;
    await this.registerNamespace(
      namespaces,
      domain,
      thread.authorityNamespaceId,
    );
  }

  private async registerNamespace(
    store: NamespaceRegistryStore,
    domain: string,
    namespaceId: number,
  ): Promise<void> {
    if (namespaceId === 0 || (await store.get([domain, namespaceId]))) return;
    const existing = await store.index('domain').getAll(domain);
    const greatestKnown = existing.reduce(
      (greatest, row) => Math.max(greatest, row.namespaceId),
      0,
    );
    if (namespaceId > greatestKnown) {
      for (const row of existing) {
        if (row.status === 'ACTIVE')
          await store.put({ ...row, status: 'ARCHIVED' });
      }
    }
    await store.put({
      domain,
      namespaceId,
      status: namespaceId > greatestKnown ? 'ACTIVE' : 'ARCHIVED',
    });
  }

  async getProfile(identity: string): Promise<ProfileRecord | undefined> {
    return this.runAccountOperation(() => this.getProfileInternal(identity));
  }

  async getUser(
    account: string,
    domain: string,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<UserRecord | undefined> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return (
          (await tauriInvoke<UserRecord | null>('native_db_get_user', {
            userId: Number(this.currentUserId),
            account,
            domain,
            sourceDomain,
            namespaceId,
          })) ?? undefined
        );
      return (await this.db()).get('users', [
        account,
        domain,
        sourceDomain,
        namespaceId,
      ]);
    });
  }

  async queryGroupMembers(params: {
    threadId: number;
    afterIdentity?: string;
    take: number;
    search?: string;
  }): Promise<ResolvedMemberRecord[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<ResolvedMemberRecord[]>(
          'native_db_query_group_members',
          {
            userId: Number(this.currentUserId),
            threadId: params.threadId,
            afterIdentity: params.afterIdentity ?? '',
            take: params.take,
            search: params.search?.trim() ?? '',
          },
        );
      const db = await this.db();
      const result: ResolvedMemberRecord[] = [];
      const search = params.search?.trim().toLocaleLowerCase() ?? '';
      const members = (
        await db
          .transaction('members')
          .store.index('thread')
          .getAll(params.threadId)
      )
        .filter((member) => {
          const identity = `${member.namespaceId}\u0000${member.sourceDomain}\u0000${member.domain}\u0000${member.account}`;
          return !member.left && identity > (params.afterIdentity ?? '');
        })
        .sort((a, b) =>
          `${a.namespaceId}\u0000${a.sourceDomain}\u0000${a.domain}\u0000${a.account}`.localeCompare(
            `${b.namespaceId}\u0000${b.sourceDomain}\u0000${b.domain}\u0000${b.account}`,
          ),
        );
      for (const member of members) {
        if (result.length >= params.take) break;
        const user = await db.get('users', [
          member.account,
          member.domain,
          member.sourceDomain,
          member.namespaceId,
        ]);
        if (!user) continue;
        if (
          !search ||
          user.name.toLocaleLowerCase().includes(search) ||
          user.account.toLocaleLowerCase().includes(search)
        )
          result.push({ ...member, user });
      }
      return result;
    });
  }

  async getGroupMember(
    threadId: number,
    account: string,
    domain: string,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<ResolvedMemberRecord | undefined> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return (
          (await tauriInvoke<ResolvedMemberRecord | null>(
            'native_db_get_group_member',
            {
              userId: Number(this.currentUserId),
              threadId,
              account,
              domain,
              sourceDomain,
              namespaceId,
            },
          )) ?? undefined
        );
      const db = await this.db();
      const member = await db.get('members', [
        threadId,
        account,
        domain,
        sourceDomain,
        namespaceId,
      ]);
      if (!member || member.left) return undefined;
      const user = await db.get('users', [
        account,
        domain,
        sourceDomain,
        namespaceId,
      ]);
      return user ? { ...member, user } : undefined;
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
    const db = await this.db();
    if (identity.startsWith('a:')) {
      const [domain, account] = identity.slice(2).split('\u0000');
      if (!domain || !account) return undefined;
      const matches = await db.getAllFromIndex(
        'users',
        'address',
        IDBKeyRange.bound(
          [account, domain, 0],
          [account, domain, Number.MAX_SAFE_INTEGER],
        ),
      );
      const record = matches.find((user) => user.sourceDomain === domain);
      return record ? this.userAsProfile(identity, record) : undefined;
    }
    const match = /^([ug])(\d+)$/.exec(identity);
    if (!match) return undefined;
    const id = Number(match[2]);
    if (match[1] === 'u') {
      const record = await db.getFromIndex('users', 'id', id);
      return record ? this.userAsProfile(identity, record) : undefined;
    }
    const record = await db.getFromIndex('groups', 'id', id);
    return record ? this.groupAsProfile(identity, record) : undefined;
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
    if (record.kind === 'user') {
      const tx = db.transaction(['namespaces', 'users'], 'readwrite');
      const key: [string, string, string, number] = [
        record.account,
        record.domain,
        record.sourceServer,
        record.namespaceId,
      ];
      const users = tx.objectStore('users');
      const previous = await users.get(key);
      if (previous && previous.profileRev > record.profileRev) {
        await tx.done;
        return false;
      }
      await this.registerNamespace(
        tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
        record.sourceServer,
        record.namespaceId,
      );
      await users.put({
        id: record.id || previous?.id,
        account: record.account,
        domain: record.domain,
        sourceDomain: record.sourceServer,
        namespaceId: record.namespaceId,
        name: record.name,
        avatar: record.avatar,
        bio: record.bio,
        availability: 'AVAILABLE',
        profileRev: record.profileRev,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      await tx.done;
    } else {
      const tx = db.transaction(['namespaces', 'groups'], 'readwrite');
      const key: [string, string, number] = [
        record.account,
        record.domain,
        record.namespaceId,
      ];
      const groups = tx.objectStore('groups');
      const previous = await groups.get(key);
      if (previous && previous.profileRev > record.profileRev) {
        await tx.done;
        return false;
      }
      await this.registerNamespace(
        tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
        record.domain,
        record.namespaceId,
      );
      await groups.put({
        id: record.id || previous?.id,
        account: record.account,
        domain: record.domain,
        namespaceId: record.namespaceId,
        name: record.name,
        avatar: record.avatar,
        description: record.bio,
        profileRev: record.profileRev,
        dissolvedAt: previous?.dissolvedAt ?? null,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      await tx.done;
    }
    return true;
  }

  private userAsProfile(identity: string, record: UserRecord): ProfileRecord {
    return {
      identity,
      id: record.id ?? 0,
      kind: 'user',
      name: record.name,
      account: record.account,
      avatar: record.avatar,
      bio: record.bio,
      domain: record.domain,
      sourceServer: record.sourceDomain,
      namespaceId: record.namespaceId,
      profileRev: record.profileRev,
    };
  }

  private groupAsProfile(identity: string, record: GroupRecord): ProfileRecord {
    return {
      identity,
      id: record.id ?? 0,
      kind: 'group',
      name: record.name,
      account: record.account,
      avatar: record.avatar,
      bio: record.description,
      domain: record.domain,
      sourceServer: record.domain,
      namespaceId: record.namespaceId,
      profileRev: record.profileRev,
    };
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

  async putCachedMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_put_cached_messages', {
          userId: Number(this.currentUserId),
          messages,
        });
        return;
      }
      const tx = (await this.messageDb()).transaction('messages', 'readwrite');
      for (const message of messages) {
        const existing = await tx.store.get([message.threadId, message.seq]);
        if (!existing?.isDeleted) await tx.store.put(message);
      }
      await tx.done;
    });
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
      if (isCachedMessageBody(cursor.value)) out.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return out;
  }

  async getMessageRanges(threadId: number): Promise<MessageRange[]> {
    return this.runMessageOperation(() =>
      this.getMessageRangesInternal(threadId),
    );
  }

  async getMessageHead(threadId: number): Promise<number | undefined> {
    return this.runMessageOperation(async () => {
      if (isTauri())
        throw new Error(
          'native message head belongs to the native source walker',
        );
      const stored = await (
        await this.messageDb()
      ).get('settings', messageHeadKey(threadId));
      const value = stored?.value as { knownNewestSeq?: unknown } | undefined;
      return typeof value?.knownNewestSeq === 'number' &&
        Number.isSafeInteger(value.knownNewestSeq) &&
        value.knownNewestSeq >= 0
        ? value.knownNewestSeq
        : undefined;
    });
  }

  async putMessageHead(
    threadId: number,
    knownNewestSeq: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(knownNewestSeq) || knownNewestSeq < 0)
      throw new Error('known newest message sequence is invalid');
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_put_message_head', {
          userId: Number(this.currentUserId),
          threadId,
          knownNewestSeq,
        });
        return;
      }
      const db = await this.messageDb();
      const tx = db.transaction('settings', 'readwrite');
      const key = messageHeadKey(threadId);
      const current = (await tx.store.get(key))?.value as
        | { knownNewestSeq?: unknown }
        | undefined;
      await tx.store.put({
        key,
        value: {
          threadId,
          knownNewestSeq: Math.max(
            knownNewestSeq,
            typeof current?.knownNewestSeq === 'number'
              ? current.knownNewestSeq
              : 0,
          ),
        },
      });
      await tx.done;
    });
  }

  private async getMessageRangesInternal(
    threadId: number,
  ): Promise<MessageRange[]> {
    if (isTauri())
      throw new Error(
        'native message ranges belong to the native source walker',
      );
    return (await this.messageDb()).getAll(
      'messageRanges',
      IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
    );
  }

  async commitBrowserMessagePage(
    input: CommitMessagePageInput,
    lifetime?: AbortSignal,
  ): Promise<CommittedMessagePage> {
    return this.runMessageOperation(
      () =>
        this.withMessageThreadCommit(input.threadId, () =>
          this.commitBrowserMessagePageInternal(input),
        ),
      lifetime,
    );
  }

  private async commitBrowserMessagePageInternal(
    input: CommitMessagePageInput,
  ): Promise<CommittedMessagePage> {
    if (input.messages.some((message) => message.threadId !== input.threadId))
      throw new Error('message page contains a message from another thread');
    if (
      input.knownNewestSeq !== undefined &&
      (!Number.isSafeInteger(input.knownNewestSeq) || input.knownNewestSeq < 0)
    )
      throw new Error('known newest message sequence is invalid');

    const tx = (await this.messageDb()).transaction(
      ['messages', 'messageRanges', 'settings'],
      'readwrite',
    );
    const rangeKey = IDBKeyRange.bound(
      [input.threadId, -Infinity],
      [input.threadId, Infinity],
    );
    const rangeStore = tx.objectStore('messageRanges');
    const current = await rangeStore.getAll(rangeKey);
    const ranges = reduceMessageRanges({
      threadId: input.threadId,
      current,
      scan: input.scan,
      gaps: input.gaps,
      messageSeqs: input.messages.map((message) => message.seq),
    });
    const messageStore = tx.objectStore('messages');
    const committedMessages: Message[] = [];
    for (const message of input.messages) {
      const existing = await messageStore.get([input.threadId, message.seq]);
      if (existing?.isDeleted) continue;
      await messageStore.put(message);
      committedMessages.push(message);
    }
    await rangeStore.delete(rangeKey);
    for (const range of ranges) await rangeStore.put(range);
    if (input.knownNewestSeq !== undefined) {
      const key = messageHeadKey(input.threadId);
      const old = (await tx.objectStore('settings').get(key))?.value as
        | { knownNewestSeq?: unknown }
        | undefined;
      const knownNewestSeq = Math.max(
        input.knownNewestSeq,
        typeof old?.knownNewestSeq === 'number' ? old.knownNewestSeq : 0,
      );
      await tx.objectStore('settings').put({
        key,
        value: { threadId: input.threadId, knownNewestSeq },
      });
    }
    await tx.done;
    return { messages: committedMessages, ranges };
  }

  async getMessage(
    threadId: number,
    seq: number,
  ): Promise<Message | undefined> {
    return this.runMessageOperation(() =>
      this.getMessageInternal(threadId, seq),
    );
  }

  async getDeletedHwm(threadId: number): Promise<number> {
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        const hwm = await tauriInvoke<number>('native_db_get_deleted_hwm', {
          userId: Number(this.currentUserId),
          threadId,
        });
        return hwm;
      }
      const tx = (await this.messageDb()).transaction('settings', 'readonly');
      const key = `deletedHwm:${threadId}`;
      const row = await tx.objectStore('settings').get(key);
      const hwm = readDeletedHwm(row?.value);
      await tx.done;
      return hwm;
    });
  }

  async applyDeletedMessages(
    threadId: number,
    items: DeletedMessageItem[],
    hwm: number,
  ): Promise<void> {
    return this.runMessageOperation(async () => {
      if (!Number.isSafeInteger(hwm) || hwm < 0)
        throw new Error('deleted-message HWM must be a non-negative integer');
      if (
        items.some(
          (item) =>
            item.threadId !== threadId ||
            !Number.isSafeInteger(item.deletionSeq) ||
            item.deletionSeq < 1 ||
            item.deletionSeq > hwm ||
            !Number.isSafeInteger(item.messageSeq) ||
            item.messageSeq < 1,
        )
      )
        throw new Error('deleted-message page contains invalid coordinates');
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
          .get([threadId, item.messageSeq]);
        if (current) {
          await tx.objectStore('messages').put({ ...current, isDeleted: true });
        } else {
          await tx.objectStore('messages').put({
            threadId,
            seq: item.messageSeq,
            isDeleted: true,
          });
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
    return value && isCachedMessageBody(value) ? value : undefined;
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
      ['messages', 'messageRanges', 'settings'],
      'readwrite',
    );
    await tx
      .objectStore('messages')
      .delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
    await tx
      .objectStore('messageRanges')
      .delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
    await tx.objectStore('settings').delete(messageHeadKey(threadId));
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
