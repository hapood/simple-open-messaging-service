import type { ThreadListRecord } from './model';
import { isThreadStateSnapshot } from '../../../../shared/thread-state';
import { applyThreadStateSnapshot } from './thread-state-projection';
import { signal } from '@angular/core';
import type { SessionLifecycleService } from './session-lifecycle.service';
import { Subject, type Subscription } from 'rxjs';
import { apiPrefix } from './constants';
import type { ThreadFeedSyncResult } from './thread-feed-sync';
import type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaProfileReference,
} from './group-meta-model';
export type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
} from './group-meta-model';
import {
  openDB,
  deleteDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from 'idb';
import {
  localSubjectIdentity,
  parseUserIdentityKey,
  type ConversationItem,
  type DeletedMessageItem,
  type Message,
  type MessageCreator,
  type MessageQueryRow,
} from './model';
import {
  mergeMessageSlot,
  deleteMessageSlot,
  type MessageDeletionMarker,
  type MessageTomb,
} from '../../../../shared/message-tomb';
import type {
  ClientFriendIntent,
  ClientGroupInviteIntent,
  ClientStateFeedItem,
} from './user.service';
import { isTauri, tauriInvoke } from './runtime';
import {
  applyFriendIntentToProjection,
  applyGroupIntentToProjection,
  friendRequestKey,
  groupRequestKey,
  markProjectionAccepted,
  projectionDirectionForFact,
  projectionIsExpired,
  projectionRequestExpiresAt,
  type FriendRequestProjection,
  type RelationshipIntentFact,
} from './friend-request-state';
import {
  reduceMessageRanges,
  type MessageInterval,
  type MessageRange,
  type ServerMessageRange,
} from './message-range';
import {
  advanceLocalAttentionRead,
  createLocalThreadAttention,
  mergeThreadAttention,
  type LocalThreadAttention,
  type ThreadFeedSnapshot,
} from '../../../../shared/thread-attention';
import type {
  ProfileKey,
  ProfileSelector as ProfileEvidence,
} from '../../../../shared/profile-selector';

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
 * is opened lazily (never at construction / module load), mirroring the existing `window` guards used
 * elsewhere.
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

export interface ProfileSelector {
  account: string;
  domain: string;
  namespaceId: number;
  profileRev: number;
}

export interface ProfileSnapshot extends ProfileSelector {
  name: string;
  avatar: string;
  bio: string;
}

export type ProfileResolutionAttempt =
  | { status: 'READY'; profile: ProfileSnapshot }
  | { status: 'PENDING'; key: ProfileKey };

export type ProfileWake =
  | { event: 'PROFILE_AVAILABLE'; key: ProfileKey }
  | {
      event: 'PROFILE_UNAVAILABLE';
      key: ProfileKey;
      reason: string;
    };

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

/** One materialized roster member selecting an exact profile revision. */
export interface MemberRecord {
  threadId: number;
  account: string;
  domain: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  left: boolean;
  /** Profile reference selected by this group's metadata/message history. */
  profileRev: number;
  /** Message that most recently selected profileRev inside this group. */
  profileMessageSeq?: number | null;
}

export interface ResolvedMemberRecord extends MemberRecord {
  /** Presentation is joined from the selected immutable profile. */
  resolvedProfileRev?: number;
  profileName?: string;
  profileAvatar?: string;
  profileBio: string;
  user: ProfileSnapshot;
}

/** Optional UI context is used for avatar signalling and the signed-in account address only. */
export interface ProfileWriteRecord extends ProfileSnapshot {
  identity?: string;
  id?: number;
  kind?: 'user' | 'group';
  sourceServer: string;
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
interface MetaRecord {
  key: string;
  value: unknown;
}

type CachedMessageBody = Message;

/** A deletion learned before its message body. It deliberately has no synthetic content or creator. */
type CachedMessageTombstone = MessageDeletionMarker | MessageTomb;

type CachedMessage = CachedMessageBody | CachedMessageTombstone;

function isCachedMessageBody(value: CachedMessage): value is CachedMessageBody {
  return !value.isDeleted && 'content' in value;
}

function isCachedTimelineSlot(value: CachedMessage): value is MessageQueryRow {
  return (
    isCachedMessageBody(value) ||
    (value.contentType === 'TOMB' && 'creator' in value)
  );
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
  messages: MessageQueryRow[];
  gaps: ServerMessageRange[];
  knownNewestSeq?: number;
}

export interface CommittedMessagePage {
  messages: MessageQueryRow[];
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
  profiles: {
    key: [string, string, number, number];
    value: ProfileSnapshot;
  };
  members: {
    key: [number, string, string, number];
    value: MemberRecord;
    indexes: {
      thread: number;
      address: [number, string, string, number];
    };
  };
  /** One record per conversation, keyed by `threadId` (the field is the keyPath). */
  threads: { key: number; value: ThreadListRecord };
  threadStates: { key: number; value: LocalThreadAttention };
  relationshipRequests: {
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
export const CACHE_SCHEMA_VERSION = 22;
export const MESSAGE_CACHE_SCHEMA_VERSION = 5;
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

function parseProfileKey(value: unknown): ProfileKey | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = value as Partial<ProfileKey>;
  if (
    !Number.isSafeInteger(candidate.namespaceId) ||
    Number(candidate.namespaceId) < 0 ||
    typeof candidate.account !== 'string' ||
    candidate.account.length === 0 ||
    typeof candidate.domain !== 'string' ||
    candidate.domain.length === 0 ||
    !Number.isSafeInteger(candidate.rev) ||
    Number(candidate.rev) < 1
  )
    return;
  return {
    namespaceId: Number(candidate.namespaceId),
    account: candidate.account,
    domain: candidate.domain,
    rev: Number(candidate.rev),
  };
}

export type StateFeedWorkerFactory = () => Worker | null;

/** Shared storage implementation used by page and background runtimes. */
export class WebdbStorage {
  private readonly workerFailed = new Subject<void>();
  readonly workerFailed$ = this.workerFailed.asObservable();
  private readonly profileWake = new Subject<ProfileWake>();
  readonly profileWake$ = this.profileWake.asObservable();

  async applyProfileEvent(
    event: 'PROFILE_AVAILABLE' | 'PROFILE_UNAVAILABLE',
    data: unknown,
  ): Promise<void> {
    const key = parseProfileKey(data);
    if (!key) return;
    if (event === 'PROFILE_UNAVAILABLE') {
      const reason =
        data && typeof data === 'object' && typeof (data as { reason?: unknown }).reason === 'string'
          ? (data as { reason: string }).reason
          : 'TEMPORARILY_UNAVAILABLE';
      this.profileWake.next({ event, key, reason });
      return;
    }
    const result = await this.resolveProfileEvidence({
      type: 'EXACT',
      account: key.account,
      domain: key.domain,
      rev: key.rev,
    });
    // Native SSE is delivered after SQLite materialization. Browser commits
    // notify through the worker instead of emitting again at the request layer.
    if (isTauri() && result.status === 'READY')
      this.profileWake.next({ event, key });
  }
  private stateFeedWorker: Worker | null = null;
  private stateFeedWorkerRequestId = 0;
  private readonly stateFeedWorkerPending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
  private readonly sessionInvalidation?: Subscription;

  constructor(
    private readonly stateFeedWorkerFactory: StateFeedWorkerFactory = () =>
      null,
    lifecycle?: SessionLifecycleService,
  ) {
    this.sessionInvalidation = lifecycle?.invalidated$.subscribe(() => {
      ++this.cacheEpoch;
      this.beginAccountMaintenance();
    });
  }

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
    this.observeCacheDeletion(db);
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
    if (await this.isCurrentSchema(db)) {
      return db;
    }
    db.close();
    throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
  }

  private async openExistingMessages(
    name: string,
  ): Promise<IDBPDatabase<MessageDbSchema>> {
    if (!(await this.databaseExists(name)))
      throw new LocalCacheUnavailableError(`missing local cache: ${name}`);
    const db = await openDB<MessageDbSchema>(name);
    this.observeCacheDeletion(db);
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
    if (await this.isCurrentMessageSchema(db)) {
      return db;
    }
    db.close();
    throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
  }

  /** Open the current cache without requesting an IndexedDB upgrade. The stable `meta` KV store owns the
   *  application schema version. Any old/missing/damaged rebuildable cache is deleted and initialized from
   *  scratch; there are deliberately no incremental data migrations. */
  private async openValidatedOrRecreate(
    name: string,
  ): Promise<IDBPDatabase<WebdbSchema>> {
    const epoch = this.cacheEpoch;
    const existing = await openDB<WebdbSchema>(name);
    this.observeCacheDeletion(existing);
    const valid = await this.isCurrentSchema(existing);
    if (epoch !== this.cacheEpoch) {
      existing.close();
      throw new Error('webdb: cache invalidated during schema validation');
    }
    if (valid) return existing;
    existing.close();
    await deleteDB(name);
    if (epoch !== this.cacheEpoch)
      throw new Error('webdb: stale cache recreation discarded');
    const db = await this.createCurrentSchema(name);
    this.observeCacheDeletion(db);
    return db;
  }

  private async isCurrentSchema(
    db: IDBPDatabase<WebdbSchema>,
  ): Promise<boolean> {
    const required = [
      'avatars',
      'namespaces',
      'profiles',
      'members',
      'threads',
      'threadStates',
      'relationshipRequests',
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
        db.createObjectStore('profiles', {
          keyPath: ['account', 'domain', 'namespaceId', 'profileRev'],
        });
        const members = db.createObjectStore('members', {
          keyPath: ['threadId', 'account', 'domain', 'namespaceId'],
        });
        members.createIndex('thread', 'threadId');
        members.createIndex('address', [
          'threadId',
          'account',
          'domain',
          'namespaceId',
        ]);
        db.createObjectStore('threads', { keyPath: 'threadId' });
        db.createObjectStore('threadStates', { keyPath: 'threadId' });
        const relationshipRequests = db.createObjectStore(
          'relationshipRequests',
          {
            keyPath: 'key',
          },
        );
        relationshipRequests.createIndex('bucketStatus', [
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
    const epoch = this.cacheEpoch;
    const existing = await openDB<MessageDbSchema>(name);
    this.observeCacheDeletion(existing);
    const valid = await this.isCurrentMessageSchema(existing);
    if (epoch !== this.cacheEpoch) {
      existing.close();
      throw new Error('webdb: cache invalidated during schema validation');
    }
    if (valid) return existing;
    existing.close();
    await deleteDB(name);
    if (epoch !== this.cacheEpoch)
      throw new Error('webdb: stale cache recreation discarded');
    const db = await openDB<MessageDbSchema>(name, IDB_FORMAT_VERSION, {
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
    this.observeCacheDeletion(db);
    return db;
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

  async getThreadStates(): Promise<LocalThreadAttention[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<LocalThreadAttention[]>('native_db_thread_states', {
          userId: Number(this.currentUserId),
        });
      return (await this.db()).getAll('threadStates');
    });
  }

  /** Read the renderer's missing snapshots and durable feed cursor in one consistent transaction. */
  async readThreadFeedChanges(after: number): Promise<ThreadFeedSyncResult> {
    if (!Number.isInteger(after) || after < 0 || after > 2147483647)
      throw new Error('invalid applied thread feed cursor');
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId !== null)
        return tauriInvoke<ThreadFeedSyncResult>('native_thread_feed_changes', {
          userId: Number(this.currentUserId),
          after,
        });
      const tx = (await this.db()).transaction(
        ['threadStates', 'settings'],
        'readonly',
      );
      const [rows, stored] = await Promise.all([
        tx.objectStore('threadStates').getAll(),
        tx.objectStore('settings').get('threadFeedCursor'),
      ]);
      await tx.done;
      const cursor = Number(stored?.value ?? 0);
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > 2147483647)
        throw new Error('invalid local thread feed cursor');
      return {
        cursor,
        groupThreadIds: [],
        states: rows.filter(
          (row) =>
            row.server !== null &&
            row.server.threadFeedId > after &&
            row.server.threadFeedId <= cursor,
        ),
      };
    });
  }

  /** Serialize cursor consumers across page workers and the Push Service Worker. */
  async withThreadFeedLock<T>(run: () => Promise<T>): Promise<T> {
    const epoch = this.cacheEpoch;
    const userId = this.currentUserId;
    const guarded = () => {
      if (
        epoch !== this.cacheEpoch ||
        userId === null ||
        this.accountMaintenance
      )
        throw new Error('account cache lifetime expired');
      return run();
    };
    if (typeof navigator !== 'undefined' && navigator.locks)
      return navigator.locks.request('soms-thread-feed-' + userId, guarded);
    return guarded();
  }

  /** Another context deleting/rebuilding the account must invalidate this handle before any late write. */
  private observeCacheDeletion(
    db: IDBPDatabase<WebdbSchema> | IDBPDatabase<MessageDbSchema>,
  ): void {
    db.addEventListener('versionchange', () => {
      db.close();
      void this.close();
    });
  }

  /** Only complete feed pages supply a cursor. */
  async mergeThreadStates(
    states: ThreadFeedSnapshot[],
    scannedThrough?: number,
  ): Promise<LocalThreadAttention[]> {
    return this.runAccountOperation(async () => {
      // Validate and copy before opening the transaction or yielding to other callers.
      const snapshots = states.map(
        (state) =>
          mergeThreadAttention(
            createLocalThreadAttention(state.threadId),
            state,
          ).server!,
      );
      if (
        scannedThrough !== undefined &&
        (!Number.isInteger(scannedThrough) ||
          scannedThrough < 0 ||
          scannedThrough > 2_147_483_647)
      )
        throw new Error('Invalid attention feed cursor');
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<LocalThreadAttention[]>(
          'native_db_merge_thread_states',
          {
            userId: Number(this.currentUserId),
            states: snapshots,
            scannedThrough: scannedThrough ?? null,
          },
        );
      const tx = (await this.db()).transaction(
        ['threadStates', 'threads', 'settings'],
        'readwrite',
      );
      const store = tx.objectStore('threadStates');
      const merged = new Map<number, LocalThreadAttention>();
      for (const snapshot of snapshots) {
        const threads = tx.objectStore('threads');
        const thread = await threads.get(snapshot.threadId);
        if (!thread)
          await threads.put({
            threadId: snapshot.threadId,
            threadFeedId: snapshot.threadFeedId,
            type: 'PENDING',
            visible: false,
          });
        const current =
          (await store.get(snapshot.threadId)) ??
          createLocalThreadAttention(snapshot.threadId);
        const next = mergeThreadAttention(current, snapshot);
        if (next !== current) {
          const previews = next.server?.previews;
          const latest = previews?.reduce<
            (typeof previews)[number] | undefined
          >(
            (value, preview) =>
              !value || preview.seq > value.seq ? preview : value,
            undefined,
          );
          await store.put({
            ...next,
            server:
              next.server && previews !== undefined
                ? { ...next.server, previews: latest ? [latest] : [] }
                : next.server,
          });
        }
        if (thread && next.server) {
          await threads.put(
            thread.type === 'PENDING'
              ? { ...thread, threadFeedId: next.server.threadFeedId }
              : {
                  ...thread,
                  threadFeedId: next.server.threadFeedId,
                  visible: true,
                },
          );
        }
        merged.set(next.threadId, next);
      }
      if (scannedThrough !== undefined) {
        const settings = tx.objectStore('settings');
        const cursor = await settings.get('threadFeedCursor');
        await settings.put({
          key: 'threadFeedCursor',
          value: Math.max(Number(cursor?.value ?? 0), scannedThrough),
        });
      }
      await tx.done;
      return [...merged.values()];
    });
  }

  async advanceThreadRead(
    threadId: number,
    seq: number,
  ): Promise<LocalThreadAttention> {
    return this.runAccountOperation(async () => {
      const initial = createLocalThreadAttention(threadId);
      advanceLocalAttentionRead(initial, seq);
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<LocalThreadAttention>(
          'native_db_advance_thread_read',
          {
            userId: Number(this.currentUserId),
            threadId,
            seq,
          },
        );
      const tx = (await this.db()).transaction('threadStates', 'readwrite');
      const current = (await tx.store.get(threadId)) ?? initial;
      const next = advanceLocalAttentionRead(current, seq);
      if (next !== current) await tx.store.put(next);
      await tx.done;
      return next;
    });
  }

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

  async getRelationshipRequestPage(
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
        }>('native_db_page_relationship_requests', {
          userId: Number(this.currentUserId),
          bucket,
          cursor,
          take,
        });
      const db = await this.db();
      const index = db
        .transaction('relationshipRequests')
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

  async markRelationshipRequestAccepted(key: string): Promise<void> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_mark_relationship_request_accepted', {
          userId: Number(this.currentUserId),
          key,
        });
        return;
      }
      const db = await this.db();
      const current = await db.get('relationshipRequests', key);
      if (current)
        await db.put('relationshipRequests', markProjectionAccepted(current));
    });
  }

  async cleanupRelationshipRequests(now = Date.now()): Promise<void> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_cleanup_relationship_requests', {
          userId: Number(this.currentUserId),
          now,
        });
        return;
      }
      const db = await this.db();
      const tx = db.transaction('relationshipRequests', 'readwrite');
      for (const item of await tx
        .objectStore('relationshipRequests')
        .getAll()) {
        if (!projectionIsExpired(item, now)) continue;
        await tx.objectStore('relationshipRequests').delete(item.key);
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
    return (await (await this.db()).getAll('threads')).filter(
      (thread): thread is ConversationItem =>
        thread.type !== 'PENDING' && thread.visible !== false,
    );
  }

  private normalizeThreadSubject(item: ConversationItem): ConversationItem {
    return item.type === 'P2P'
      ? {
          ...item,
          peerUser: localSubjectIdentity(item.peerUser),
          authorityNamespaceId: localSubjectIdentity(item.peerUser).namespaceId,
        }
      : {
          ...item,
          group: localSubjectIdentity(item.group),
          authorityNamespaceId: localSubjectIdentity(item.group).namespaceId,
        };
  }

  async replaceThreads(items: ConversationItem[]): Promise<void> {
    return this.runAccountOperation(() =>
      this.replaceThreadsInternal(
        items.map((item) => this.normalizeThreadSubject(item)),
      ),
    );
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
    return this.runAccountOperation(() =>
      this.putThreadInternal(this.normalizeThreadSubject(item)),
    );
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
    const current = await tx.objectStore('threads').get(item.threadId);
    if ((current?.threadStateFeedId ?? 0) <= (item.threadStateFeedId ?? 0)) {
      await this.ensureThreadNamespaceInTx(tx, item);
      await tx.objectStore('threads').put(item);
    }
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
    resetProjection = false,
  ): Promise<void> {
    await this.runAccountOperation(async () => {
      if (!isTauri() && this.currentUserId !== null) {
        const workerApply = this.applyStateFeedPageInWorker(
          this.currentUserId,
          items,
          feedId,
          resetProjection,
        );
        if (workerApply) {
          await workerApply;
          return;
        }
      }
      await this.applyStateFeedPageInternal(items, feedId, resetProjection, []);
    });
  }

  /** Apply one fetched Group Meta page and advance its durable scan cursor atomically. */
  async applyGroupMetaPage(update: ClientGroupMetaApply): Promise<void> {
    await this.runAccountOperation(async () => {
      await this.applyStateFeedPageInternal([], null, false, [update]);
    });
  }

  private applyStateFeedPageInWorker(
    userId: string,
    items: ClientStateFeedItem[],
    feedId: number,
    resetProjection: boolean,
  ): Promise<void> | null {
    return this.requestDbWorker<void>({
      type: 'apply',
      userId,
      items,
      feedId,
      resetProjection,
    });
  }

  /** Execution belongs to the database worker/native runtime, including page commits and cursor. */
  async syncThreadFeed(
    target: number,
    after: number,
  ): Promise<ThreadFeedSyncResult> {
    if (this.accountMaintenance || this.currentUserId === null)
      throw new Error('account cache lifetime expired');
    const epoch = this.cacheEpoch;
    const userId = this.currentUserId;
    const pending = isTauri()
      ? tauriInvoke<ThreadFeedSyncResult>('native_thread_feed_sync', {
          userId: Number(userId),
          target,
          after,
        })
      : this.requestDbWorker<ThreadFeedSyncResult>({
          type: 'thread-sync',
          userId,
          target,
          after,
          url: `${apiPrefix()}/thread/feed-delta`,
          groupMetaUrl: `${apiPrefix()}/user/group-meta`,
          profileResolutionUrl: `${apiPrefix()}/user/profile-resolution`,
        });
    if (!pending) throw new Error('database worker unavailable');
    const result = await pending;
    if (epoch !== this.cacheEpoch)
      throw new Error('account cache lifetime expired');
    return result;
  }

  /** Submit one authorized profile evidence to the platform-owned database executor.
   * READY results are committed there before this promise resolves. */
  async resolveProfileEvidence(
    selector: ProfileEvidence,
  ): Promise<ProfileResolutionAttempt> {
    if (this.accountMaintenance || this.currentUserId === null)
      throw new Error('account cache lifetime expired');
    const userId = this.currentUserId;
    const epoch = this.cacheEpoch;
    const result = isTauri()
      ? await tauriInvoke<ProfileResolutionAttempt>('native_profile_resolve', {
          userId: Number(userId),
          selector,
        })
      : await this.requestDbWorker<ProfileResolutionAttempt>({
          type: 'resolve-profile',
          userId,
          selector,
          profileResolutionUrl: `${apiPrefix()}/user/profile-resolution`,
        });
    if (!result) throw new Error('database worker unavailable');
    if (epoch !== this.cacheEpoch)
      throw new Error('account cache lifetime expired');
    return result;
  }

  private requestDbWorker<T>(
    request: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> | null {
    if (!this.stateFeedWorker) {
      this.stateFeedWorker = this.stateFeedWorkerFactory();
      if (!this.stateFeedWorker) return null;
      const worker = this.stateFeedWorker;
      this.stateFeedWorker.onmessage = (
        event: MessageEvent<{
          id?: number;
          type?: string;
          wake?: ProfileWake;
          ok?: boolean;
          error?: string;
          result?: unknown;
        }>,
      ) => {
        if (this.stateFeedWorker !== worker) return;
        if (event.data.type === 'profile-wake' && event.data.wake) {
          this.profileWake.next(event.data.wake);
          return;
        }
        if (event.data.id === undefined) return;
        const pending = this.stateFeedWorkerPending.get(event.data.id);
        if (!pending) return;
        this.stateFeedWorkerPending.delete(event.data.id);
        if (event.data.ok) pending.resolve(event.data.result);
        else
          pending.reject(
            new Error(event.data.error ?? 'state-feed worker failed'),
          );
      };
      this.stateFeedWorker.onerror = (event) => {
        if (this.stateFeedWorker !== worker) return;
        const error = new Error(event.message || 'state-feed worker crashed');
        for (const pending of this.stateFeedWorkerPending.values())
          pending.reject(error);
        this.stateFeedWorkerPending.clear();
        this.stateFeedWorker?.terminate();
        this.stateFeedWorker = null;
        this.workerFailed.next();
      };
    }
    const id = ++this.stateFeedWorkerRequestId;
    return new Promise<T>((resolve, reject) => {
      this.stateFeedWorkerPending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.stateFeedWorker!.postMessage(
        {
          ...request,
          id,
        },
        transfer,
      );
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

  async createThreadFeedPort(): Promise<MessagePort | null> {
    if (isTauri() || this.accountMaintenance || this.currentUserId === null)
      return null;
    const epoch = this.cacheEpoch;
    const channel = new MessageChannel();
    try {
      const pending = this.requestDbWorker<void>(
        {
          type: 'bind-thread-feed',
          userId: this.currentUserId,
          port: channel.port1,
          url: `${apiPrefix()}/thread/feed-delta`,
          groupMetaUrl: `${apiPrefix()}/user/group-meta`,
          profileResolutionUrl: `${apiPrefix()}/user/profile-resolution`,
        },
        [channel.port1],
      );
      if (!pending) {
        channel.port1.close();
        channel.port2.close();
        return null;
      }
      await pending;
      if (epoch !== this.cacheEpoch)
        throw new Error('account cache lifetime expired');
      return channel.port2;
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
  }

  private async applyStateFeedPageInternal(
    items: ClientStateFeedItem[],
    feedId: number | null,
    resetProjection: boolean,
    groupMeta: readonly ClientGroupMetaApply[],
  ): Promise<void> {
    if (isTauri() && this.currentUserId != null) {
      if (feedId === null)
        throw new Error('Group Meta commits are owned by the native executor');
      await tauriInvoke('native_db_apply_state_feed_page', {
        userId: Number(this.currentUserId),
        feedId,
        items,
        resetProjection,
      });
      return;
    }
    const db = await this.db();
    const tx = db.transaction(
      [
        'threads',
        'namespaces',
        'profiles',
        'members',
        'relationshipRequests',
        'relationshipIntents',
        'settings',
      ],
      'readwrite',
    );
    try {
      if (resetProjection) {
        await tx.objectStore('relationshipRequests').clear();
        await tx.objectStore('relationshipIntents').clear();
        const threads = tx.objectStore('threads');
        for (const thread of await threads.getAll()) {
          await threads.put({
            ...thread,
            visible: false,
            threadStateFeedId: undefined,
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
        const store = tx.objectStore('relationshipRequests');
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
              key: 'relationshipRequestStateRevision',
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
            key: 'relationshipRequestStateRevision',
            value: op.feedId,
          });
      };
      // Request projections never create or revoke conversations.
      for (const op of items) {
        if (op.eventType === 'RELATIONSHIP_INTENT')
          await applyRequestProjectionEffect(op);
        if (op.eventType !== 'THREAD_STATE') continue;
        if (!isThreadStateSnapshot(op.body))
          throw new Error('invalid thread state snapshot');
        const profile = op.body.profile;
        if (profile.namespaceId !== 0) {
          await this.registerNamespace(
            tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
            profile.domain,
            profile.namespaceId,
          );
        }
        const threads = tx.objectStore('threads');
        await threads.put(
          applyThreadStateSnapshot(
            await threads.get(op.body.threadId),
            op.body,
            op.feedId,
          ),
        );
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
        if (
          currentThread?.type !== 'GROUP' ||
          currentThread.conversationState === 'READ_ONLY'
        )
          continue;
        for (const entry of update.page.items) {
          const item =
            entry.operation === 'GROUP_PROFILE'
              ? entry
              : localSubjectIdentity(entry);
          if (item.operation === 'GROUP_PROFILE') {
            const thread = await tx.objectStore('threads').get(update.threadId);
            if (thread?.type === 'GROUP')
              await tx.objectStore('threads').put({
                ...thread,
                group: { ...thread.group, profileRev: item.body.profileRev },
              });
            continue;
          }
          await this.registerNamespace(
            namespaces as unknown as NamespaceRegistryStore,
            item.namespaceId === update.namespaceId
              ? update.sourceServer
              : item.domain,
            item.namespaceId,
          );
          const previous = await members
            .index('address')
            .get([
              update.threadId,
              item.account,
              item.domain,
              item.namespaceId,
            ]);
          if (item.operation === 'DEPART') {
            if (previous) await members.put({ ...previous, left: true });
            continue;
          }
          const body = item.body;
          const profileResolved =
            body.profileResolved ?? typeof body.displayName === 'string';
          if (profileResolved && body.profileRev > 0)
            await this.writeSnapshot(tx.objectStore('profiles'), {
              account: item.account,
              domain: item.domain,
              namespaceId: item.namespaceId,
              profileRev: body.profileRev,
              name: body.displayName ?? item.account,
              avatar: body.avatar ?? '',
              bio: body.bio ?? '',
            });
          await members.put({
            threadId: update.threadId,
            account: item.account,
            domain: item.domain,
            namespaceId: item.namespaceId,
            role: body.role,
            left: false,
            profileRev: body.profileRev,
            profileMessageSeq: body.profileMessageSeq ?? null,
          });
        }
        const currentMembers = await members
          .index('thread')
          .getAll(update.threadId);
        const activeMembers = currentMembers.filter((member) => !member.left);
        const thread = await tx.objectStore('threads').get(update.threadId);
        if (thread?.type === 'GROUP') {
          const selfUser = (
            await tx.objectStore('settings').get('selfIdentity')
          )?.value as { account: string; domain: string } | undefined;
          const self = activeMembers.find(
            (member) =>
              selfUser !== undefined &&
              member.account === selfUser.account &&
              member.domain === selfUser.domain,
          );
          await tx.objectStore('threads').put({
            ...thread,
            role: self?.role ?? null,
            groupMetaRecoveryThrough: update.page.hasMore
              ? thread.groupMetaRecoveryThrough
              : null,
            group: {
              ...thread.group,
              memberCount: activeMembers.length,
              groupMetaFeedId: update.page.scannedThrough,
            },
          });
        }
      }
      for (const entry of items) {
        const op =
          entry.eventType === 'PROFILE' ? localSubjectIdentity(entry) : entry;
        if (op.eventType === 'RELATIONSHIP_INTENT') continue;
        if (op.eventType === 'PROFILE') {
          const body = op.body;
          if (typeof body.displayName === 'string' && body.profileRev > 0)
            await this.writeSnapshot(tx.objectStore('profiles'), {
              account: op.account,
              domain: op.domain,
              namespaceId: op.namespaceId,
              profileRev: body.profileRev,
              name: body.displayName,
              avatar: body.avatar ?? '',
              bio: body.bio ?? '',
            });
          const relationshipRequests = tx.objectStore('relationshipRequests');
          for (const request of await relationshipRequests.getAll()) {
            if (request.kind === 'GROUP') {
              if (
                request.group?.account !== op.account ||
                request.group.domain !== op.domain ||
                request.group.namespaceId !== op.namespaceId
              )
                continue;
              await relationshipRequests.put({
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
              thread.peerProfileMessageSeq == null &&
              thread.peerUser.profileRev === body.profileRev &&
              thread.peerUser.account === op.account &&
              (thread.peerUser.domain ?? '') === op.domain &&
              thread.peerUser.namespaceId === op.namespaceId
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
              thread.group.namespaceId === op.namespaceId &&
              thread.group.profileRev <= body.profileRev
            )
              await threads.put({
                ...thread,
                group: {
                  ...thread.group,
                  name: body.displayName,
                  avatar: body.avatar ?? '',
                  description: body.bio,
                  profileRev: body.profileRev,
                },
              });
          }
          continue;
        }
        if (op.eventType === 'INCOMING_INVITE_HEAD') {
          await tx.objectStore('settings').put({
            key: 'relationshipRequestReadHead',
            value: op.body,
          });
          continue;
        }
      }
      if (feedId !== null)
        await tx
          .objectStore('settings')
          .put({ key: 'stateFeedId', value: feedId });
      await tx.done;
    } catch (error) {
      // Application errors do not automatically abort an IndexedDB transaction.
      try {
        tx.abort();
      } catch {
        /* The transaction may already have aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
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

  async getProfile(
    selector: ProfileSelector,
  ): Promise<ProfileSnapshot | undefined> {
    selector = localSubjectIdentity(selector);
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return (
          (await tauriInvoke<ProfileSnapshot | null>('native_db_get_profile', {
            userId: Number(this.currentUserId),
            ...selector,
          })) ?? undefined
        );
      return (await this.db()).get('profiles', [
        selector.account,
        selector.domain,
        selector.namespaceId,
        selector.profileRev,
      ]);
    });
  }

  /** Resolve an evidence reference to an already materialized local snapshot. */
  async findProfileForEvidence(
    evidence: ProfileEvidence,
  ): Promise<ProfileSnapshot | undefined> {
    return this.runAccountOperation(async () => {
      const db = await this.db();
      if (evidence.type === 'EXACT') {
        const domain = evidence.domain === 'local' ? 'local' : evidence.domain;
        const namespace = (
          await db
            .transaction('namespaces')
            .store.index('domain')
            .getAll(domain)
        ).find((candidate) => candidate.status === 'ACTIVE');
        if (!namespace) return undefined;
        return db.get('profiles', [
          evidence.account,
          domain,
          namespace.namespaceId,
          evidence.rev,
        ]);
      }
      if (evidence.type === 'MESSAGE_AUTHOR') {
        const message = await (
          await this.messageDb()
        ).get('messages', [evidence.threadId, evidence.messageSeq]);
        if (
          !message ||
          message.isDeleted ||
          !('creator' in message) ||
          !message.creator ||
          message.profileRev !== evidence.rev
        )
          return undefined;
        const creator = localSubjectIdentity(message.creator);
        return db.get('profiles', [
          creator.account,
          creator.domain,
          creator.namespaceId,
          evidence.rev,
        ]);
      }
      const thread = await db.get('threads', evidence.threadId);
      if (evidence.subject.type === 'GROUP') {
        if (
          thread?.type !== 'GROUP' ||
          thread.group.profileRev !== evidence.profileRev
        )
          return undefined;
        return db.get('profiles', [
          thread.group.account,
          thread.group.domain,
          thread.group.namespaceId,
          evidence.profileRev,
        ]);
      }
      const memberSubject = evidence.subject;
      const member = (
        await db
          .transaction('members')
          .store.index('thread')
          .getAll(evidence.threadId)
      ).find(
        (row) =>
          !row.left &&
          row.account === memberSubject.account &&
          row.domain === memberSubject.domain &&
          row.profileRev === evidence.profileRev,
      );
      if (!member) return undefined;
      return db.get('profiles', [
        member.account,
        member.domain,
        member.namespaceId,
        member.profileRev,
      ]);
    });
  }

  private memberUser(
    member: MemberRecord,
    snapshot?: ProfileSnapshot,
  ): ProfileSnapshot {
    return {
      account: member.account,
      domain: member.domain,
      namespaceId: member.namespaceId,
      profileRev: member.profileRev,
      name: snapshot?.name ?? member.account,
      avatar: snapshot?.avatar ?? '',
      bio: snapshot?.bio ?? '',
    };
  }

  private resolveMember(
    member: MemberRecord,
    snapshot?: ProfileSnapshot,
  ): ResolvedMemberRecord {
    return {
      ...member,
      user: this.memberUser(member, snapshot),
      resolvedProfileRev: snapshot?.profileRev,
      profileName: snapshot?.name,
      profileAvatar: snapshot?.avatar,
      profileBio: snapshot?.bio ?? '',
    };
  }

  /** Open a fixed full-recovery window and reset its durable scan cursor. */
  async beginGroupMetaRecovery(
    threadId: number,
    through: string,
  ): Promise<void> {
    if (!/^(0|[1-9]\d*)$/.test(through))
      throw new Error('invalid group-meta recovery boundary');
    await this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        throw new Error('Group Meta recovery is owned by the native executor');
      }
      const tx = (await this.db()).transaction(
        ['threads', 'members'],
        'readwrite',
      );
      let member = await tx
        .objectStore('members')
        .index('thread')
        .openCursor(IDBKeyRange.only(threadId));
      while (member) {
        await member.delete();
        member = await member.continue();
      }
      const thread = await tx.objectStore('threads').get(threadId);
      if (thread?.type === 'GROUP')
        await tx.objectStore('threads').put({
          ...thread,
          groupMetaRecoveryThrough: through,
          group: { ...thread.group, memberCount: 0, groupMetaFeedId: '0' },
        });
      await tx.done;
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
      const cursor = params.afterIdentity
        ? parseUserIdentityKey(params.afterIdentity)
        : null;
      const members = (
        await db
          .transaction('members')
          .store.index('thread')
          .getAll(params.threadId)
      )
        .filter((member) => {
          return (
            !member.left &&
            (!cursor || compareMemberIdentity(member, cursor) > 0)
          );
        })
        .sort(compareMemberIdentity);
      for (const member of members) {
        if (result.length >= params.take) break;
        const snapshot = await db.get('profiles', [
          member.account,
          member.domain,
          member.namespaceId,
          member.profileRev,
        ]);
        const user = this.memberUser(member, snapshot);
        if (
          !search ||
          user.name.toLocaleLowerCase().includes(search) ||
          user.account.toLocaleLowerCase().includes(search)
        )
          result.push(this.resolveMember(member, snapshot));
      }
      return result;
    });
  }

  async getGroupMember(
    threadId: number,
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<ResolvedMemberRecord | undefined> {
    ({ domain, namespaceId } = localSubjectIdentity({ domain, namespaceId }));
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
              namespaceId,
            },
          )) ?? undefined
        );
      const db = await this.db();
      const member = await db.get('members', [
        threadId,
        account,
        domain,
        namespaceId,
      ]);
      if (!member || member.left) return undefined;
      const snapshot = await db.get('profiles', [
        account,
        domain,
        namespaceId,
        member.profileRev,
      ]);
      return this.resolveMember(member, snapshot);
    });
  }

  async getUnresolvedGroupMetaProfiles(): Promise<
    import('./group-meta-sync').GroupMetaProfileReference[]
  > {
    return this.runAccountOperation(async () => {
      if (isTauri()) return [];
      const tx = (await this.db()).transaction(
        ['threads', 'members', 'profiles'],
        'readonly',
      );
      const references: import('./group-meta-sync').GroupMetaProfileReference[] =
        [];
      for (const thread of await tx.objectStore('threads').getAll()) {
        if (thread.type !== 'GROUP' || thread.group.profileRev < 1) continue;
        const cached = await tx
          .objectStore('profiles')
          .get([
            thread.group.account,
            thread.group.domain,
            thread.group.namespaceId,
            thread.group.profileRev,
          ]);
        if (!cached)
          references.push({
            type: 'GROUP',
            threadId: thread.threadId,
            account: thread.group.account,
            domain: thread.group.domain,
            namespaceId: thread.group.namespaceId,
            rev: thread.group.profileRev,
          });
      }
      for (const member of await tx.objectStore('members').getAll()) {
        if (
          member.left ||
          member.profileRev < 1 ||
          member.profileMessageSeq != null
        )
          continue;
        const cached = await tx
          .objectStore('profiles')
          .get([
            member.account,
            member.domain,
            member.namespaceId,
            member.profileRev,
          ]);
        if (!cached)
          references.push({
            type: 'GROUP_MEMBER',
            threadId: member.threadId,
            account: member.account,
            domain: member.domain,
            namespaceId: member.namespaceId,
            rev: member.profileRev,
          });
      }
      await tx.done;
      return references;
    });
  }

  async recordGroupMemberMessageProfile(
    threadId: number,
    identity: {
      account: string;
      domain: string;
      namespaceId: number;
    },
    profileRev: number,
    messageSeq: number,
  ): Promise<boolean> {
    identity = localSubjectIdentity(identity);
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<boolean>(
          'native_db_record_group_member_profile_ref',
          {
            userId: Number(this.currentUserId),
            threadId,
            ...identity,
            profileRev,
            messageSeq,
          },
        );
      const db = await this.db();
      let key: [number, string, string, number] = [
        threadId,
        identity.account,
        identity.domain,
        identity.namespaceId,
      ];
      const tx = db.transaction('members', 'readwrite');
      let previous = await tx.store.get(key);

      if (
        !previous ||
        previous.left ||
        (previous.profileMessageSeq ?? 0) >= messageSeq
      ) {
        await tx.done;
        return false;
      }
      await tx.store.put({
        ...previous,
        profileRev,
        profileMessageSeq: messageSeq,
      });
      await tx.done;
      return true;
    });
  }

  async storeGroupMemberResolvedProfile(
    threadId: number,
    identity: {
      account: string;
      domain: string;
      namespaceId: number;
    },
    profile: { rev: number; name: string; avatar: string; bio: string },
  ): Promise<boolean> {
    identity = localSubjectIdentity(identity);
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<boolean>('native_db_store_group_member_profile', {
          userId: Number(this.currentUserId),
          threadId,
          ...identity,
          profileRev: profile.rev,
          name: profile.name,
          avatar: profile.avatar,
          bio: profile.bio,
        });
      const db = await this.db();
      let key: [number, string, string, number] = [
        threadId,
        identity.account,
        identity.domain,
        identity.namespaceId,
      ];
      const tx = db.transaction(['members', 'profiles'], 'readwrite');
      let previous = await tx.objectStore('members').get(key);

      if (!previous || previous.left || previous.profileRev !== profile.rev) {
        await tx.done;
        return false;
      }
      await this.writeSnapshot(tx.objectStore('profiles'), {
        ...identity,
        profileRev: profile.rev,
        name: profile.name,
        avatar: profile.avatar,
        bio: profile.bio,
      });
      await tx.done;
      return true;
    });
  }

  async commitResolvedGroupMetaProfile(
    reference: GroupMetaProfileReference,
    profile: {
      namespaceId: number;
      account: string;
      domain: string;
      rev: number;
      name: string;
      bio: string;
      avatarBase64: string | null;
    },
  ): Promise<boolean> {
    if (
      profile.rev !== reference.rev ||
      profile.account !== reference.account ||
      profile.domain !== reference.domain ||
      profile.namespaceId !== reference.namespaceId
    )
      throw new Error('resolved profile does not match Group Meta reference');
    const avatar = profile.avatarBase64
      ? `data:image/webp;base64,${profile.avatarBase64}`
      : '';
    if (reference.type === 'GROUP_MEMBER')
      return this.storeGroupMemberResolvedProfile(
        reference.threadId,
        {
          account: reference.account,
          domain: reference.domain,
          namespaceId: reference.namespaceId,
        },
        { rev: profile.rev, name: profile.name, avatar, bio: profile.bio },
      );
    return this.runAccountOperation(async () => {
      const tx = (await this.db()).transaction(
        ['threads', 'namespaces', 'profiles'],
        'readwrite',
      );
      const thread = await tx.objectStore('threads').get(reference.threadId);
      if (
        thread?.type !== 'GROUP' ||
        thread.group.account !== reference.account ||
        thread.group.domain !== reference.domain ||
        thread.group.namespaceId !== reference.namespaceId ||
        thread.group.profileRev !== reference.rev
      ) {
        await tx.done;
        return false;
      }
      await this.registerNamespace(
        tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
        reference.domain,
        reference.namespaceId,
      );
      await this.writeSnapshot(tx.objectStore('profiles'), {
        account: reference.account,
        domain: reference.domain,
        namespaceId: reference.namespaceId,
        profileRev: reference.rev,
        name: profile.name,
        avatar,
        bio: profile.bio,
      });
      await tx.objectStore('threads').put({
        ...thread,
        group: {
          ...thread.group,
          name: profile.name,
          avatar,
          description: profile.bio,
        },
      });
      await tx.done;
      return true;
    });
  }

  /** Commit an immutable resolved snapshot. Runtime executors call this before notifying the UI. */
  async commitResolvedProfile(profile: {
    namespaceId: number;
    account: string;
    domain: string;
    rev: number;
    name: string;
    bio: string;
    avatarBase64: string | null;
  }): Promise<ProfileSnapshot> {
    const snapshot: ProfileSnapshot = {
      namespaceId: profile.namespaceId,
      account: profile.account,
      domain: profile.domain,
      profileRev: profile.rev,
      name: profile.name,
      bio: profile.bio,
      avatar: profile.avatarBase64
        ? `data:image/webp;base64,${profile.avatarBase64}`
        : '',
    };
    const written = await this.runAccountOperation(async () => {
      const tx = (await this.db()).transaction(
        ['namespaces', 'profiles', 'threads'],
        'readwrite',
      );
      await this.registerNamespace(
        tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
        snapshot.domain,
        snapshot.namespaceId,
      );
      const written = await this.writeSnapshot(
        tx.objectStore('profiles'),
        snapshot,
      );
      for (const thread of await tx.objectStore('threads').getAll()) {
        if (
          thread.type === 'GROUP' &&
          thread.group.account === snapshot.account &&
          thread.group.domain === snapshot.domain &&
          thread.group.namespaceId === snapshot.namespaceId &&
          thread.group.profileRev === snapshot.profileRev
        )
          await tx.objectStore('threads').put({
            ...thread,
            group: {
              ...thread.group,
              name: snapshot.name,
              avatar: snapshot.avatar,
              description: snapshot.bio,
            },
          });
        else if (
          thread.type === 'P2P' &&
          thread.peerUser.account === snapshot.account &&
          thread.peerUser.domain === snapshot.domain &&
          thread.peerUser.namespaceId === snapshot.namespaceId &&
          thread.peerUser.profileRev === snapshot.profileRev
        )
          await tx.objectStore('threads').put({
            ...thread,
            peerUser: {
              ...thread.peerUser,
              name: snapshot.name,
              avatar: snapshot.avatar,
              bio: snapshot.bio,
            },
          });
      }
      await tx.done;
      return written;
    });
    if (written)
      this.profileWake.next({
        event: 'PROFILE_AVAILABLE',
        key: {
          account: snapshot.account,
          domain: snapshot.domain,
          namespaceId: snapshot.namespaceId,
          rev: snapshot.profileRev,
        },
      });
    return snapshot;
  }

  async putProfile(record: ProfileWriteRecord): Promise<boolean> {
    record = localSubjectIdentity(record);
    return this.runAccountOperation(async () => {
      if (record.profileRev < 1) return false;
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<boolean>('native_db_put_profile', {
          userId: Number(this.currentUserId),
          profile: record,
        });
      const tx = (await this.db()).transaction(
        ['namespaces', 'profiles', 'settings'],
        'readwrite',
      );
      await this.registerNamespace(
        tx.objectStore('namespaces') as unknown as NamespaceRegistryStore,
        record.sourceServer,
        record.namespaceId,
      );
      if (
        record.kind === 'user' &&
        record.domain === 'local' &&
        record.id === Number(this.currentUserId)
      )
        await tx.objectStore('settings').put({
          key: 'selfIdentity',
          value: { account: record.account, domain: 'local' },
        });
      const written = await this.writeSnapshot(tx.objectStore('profiles'), {
        account: record.account,
        domain: record.domain,
        namespaceId: record.namespaceId,
        profileRev: record.profileRev,
        name: record.name,
        avatar: record.avatar,
        bio: record.bio,
      });
      await tx.done;
      return written;
    });
  }

  private async writeSnapshot(
    store: {
      get(
        key: [string, string, number, number],
      ): Promise<ProfileSnapshot | undefined>;
      put(record: ProfileSnapshot): Promise<unknown>;
      transaction: { abort(): void; done: Promise<void> };
    },
    record: ProfileSnapshot,
  ): Promise<boolean> {
    record = localSubjectIdentity(record);
    const previous = await store.get([
      record.account,
      record.domain,
      record.namespaceId,
      record.profileRev,
    ]);
    if (previous) {
      if (previous.name !== record.name || previous.bio !== record.bio) {
        store.transaction.abort();
        await store.transaction.done.catch(() => {});
        throw new Error('conflicting cached profile revision');
      }
      // Avatar URLs and inline bytes are transport representations of the same revision.
      return false;
    }
    await store.put(record);
    return true;
  }

  // ---- message store -----------------------------------------------------------------------

  /** Query one cached message window. An absent anchor means the newest/oldest edge. */
  async queryCachedMessages(
    threadId: number,
    orderBy: 'desc' | 'asc',
    take: number,
    anchor?: number,
  ): Promise<MessageQueryRow[]> {
    return this.runMessageOperation(() =>
      this.queryCachedMessagesInternal(threadId, orderBy, take, anchor),
    );
  }

  async putCachedMessages(messages: MessageQueryRow[]): Promise<void> {
    messages = messages.map((message) => ({
      ...message,
      creator: message.creator && localSubjectIdentity(message.creator),
    }));
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
        await tx.store.put(mergeMessageSlot<Message>(existing, message));
      }
      await tx.done;
    });
  }

  /** Count known message slots, including tombs, in (afterSeq, throughSeq].
   * The caller bounds this interval by the server projection and visibility window.
   * A deletion-only marker has no author yet and is not a known message slot.
   */
  async countUnreadMessageSlots(
    threadId: number,
    afterSeq: number,
    throughSeq: number,
    self: MessageCreator,
  ): Promise<number> {
    if (
      !Number.isInteger(threadId) ||
      threadId <= 0 ||
      threadId > 2_147_483_647 ||
      !Number.isInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isInteger(throughSeq) ||
      throughSeq < afterSeq ||
      throughSeq > 2_147_483_647 ||
      !self.account ||
      !self.domain ||
      !Number.isInteger(self.namespaceId) ||
      self.namespaceId < 0 ||
      self.namespaceId > 2_147_483_647
    )
      throw new Error('Invalid unread message count range or identity');
    const owner = localSubjectIdentity(self);
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<number>('native_db_count_unread_message_slots', {
          userId: Number(this.currentUserId),
          threadId,
          afterSeq,
          throughSeq,
          owner,
        });
      if (afterSeq === throughSeq) return 0;
      const tx = (await this.messageDb()).transaction('messages', 'readonly');
      let cursor = await tx.store.openCursor(
        IDBKeyRange.bound(
          [threadId, afterSeq],
          [threadId, throughSeq],
          true,
          false,
        ),
      );
      let count = 0;
      while (cursor) {
        const message = cursor.value;
        if ('creator' in message) {
          const creator = message.creator;
          if (
            !creator ||
            creator.account !== owner.account ||
            creator.domain !== owner.domain ||
            creator.namespaceId !== owner.namespaceId
          )
            count++;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      return count;
    });
  }

  private async queryCachedMessagesInternal(
    threadId: number,
    orderBy: 'desc' | 'asc',
    take: number,
    anchor?: number,
  ): Promise<MessageQueryRow[]> {
    if (isTauri() && this.currentUserId != null) {
      return tauriInvoke<MessageQueryRow[]>('native_db_query_messages', {
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
    const out: MessageQueryRow[] = [];
    const tx = db.transaction('messages', 'readonly');
    let cursor = await tx.store.openCursor(
      range,
      orderBy === 'desc' ? 'prev' : 'next',
    );
    while (cursor && out.length < take) {
      if (isCachedTimelineSlot(cursor.value)) out.push(cursor.value);
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
    const committedMessages: MessageQueryRow[] = [];
    for (const entry of input.messages) {
      const message = {
        ...entry,
        creator: entry.creator && localSubjectIdentity(entry.creator),
      };
      const existing = await messageStore.get([input.threadId, message.seq]);
      const merged = mergeMessageSlot<Message>(existing, message);
      await messageStore.put(merged);
      if (isCachedTimelineSlot(merged)) committedMessages.push(merged);
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

  /** Read deletion facts independently of cached bodies; an absent row is not a tombstone. */
  async getDeletedMessageSeqs(
    threadId: number,
    seqs: number[],
  ): Promise<number[]> {
    if (seqs.length === 0) return [];
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return tauriInvoke<number[]>('native_db_get_deleted_message_seqs', {
          userId: Number(this.currentUserId),
          threadId,
          seqs,
        });
      }
      const tx = (await this.messageDb()).transaction('messages', 'readonly');
      const rows = await Promise.all(
        [...new Set(seqs)].map((seq) => tx.store.get([threadId, seq])),
      );
      await tx.done;
      return rows.flatMap((row) => (row?.isDeleted ? [row.seq] : []));
    });
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
        await tx
          .objectStore('messages')
          .put(
            deleteMessageSlot(current, threadId, item.messageSeq, item.type),
          );
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

  dispose(): void {
    this.sessionInvalidation?.unsubscribe();
    void this.close();
  }
}

function compareMemberIdentity(
  left: Pick<MemberRecord, 'namespaceId' | 'domain' | 'account'>,
  right: Pick<MemberRecord, 'namespaceId' | 'domain' | 'account'>,
): number {
  return (
    left.namespaceId - right.namespaceId ||
    left.domain.localeCompare(right.domain) ||
    left.account.localeCompare(right.account)
  );
}
