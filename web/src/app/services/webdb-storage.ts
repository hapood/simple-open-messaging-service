import { RequestProjectionStatus } from '../../../../shared/request-projection-status';
import { BusinessCode } from './biz-code';
import { applyThreadStateSnapshot } from './thread-state-projection';
import { preserveThreadProfile } from './thread-profile-projection';
import {
  restoreThread,
  restoreThreadForStorageMutation,
  storeThreadPresentation,
  type StoredThread,
  type StoredThreadAttention,
} from './thread-record';
import { signal } from '@angular/core';
import { Subject, type Observable, type Subscription } from 'rxjs';
import { apiPrefix } from './constants';
import type { ThreadFeedSyncResult } from './thread-feed-sync';
import type { BrowserNotificationBatch } from './notification-descriptor.model';
import type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaCommitPatch,
  GroupMetaProfileReference,
} from './group-meta-model';
export type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaCommitPatch,
} from './group-meta-model';
import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb';
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
import { decodeProfileAvatar } from './profile-avatar-bytes';
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
} from './friend-request-state';
import {
  reduceMessageRanges,
  type MessageInterval,
  type MessageRange,
  type ServerMessageRange,
} from './message-range';
import {
  advanceLocalAttentionRead,
  attentionCountRange,
  mergeThreadAttention,
  attentionSnapshot,
  projectThreadAttention,
  type LocalThreadAttention,
  type ThreadFeedSnapshot,
} from '../../../../shared/thread-attention';
import {
  type ProfileDemand,
  type ProfileKey,
} from '../../../../shared/profile-demand';
import { TrailingSingleFlight } from '../../../../shared/trailing-single-flight';

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

export interface ProfileSnapshot {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  profileRev: number;
  name: string;
  avatarDigest: string | null;
  bio: string;
}

export type ProfileResolutionAttempt =
  | { status: 'READY'; profile: ProfileSnapshot }
  | { status: 'PENDING'; key: ProfileKey };

export type ProfileWake =
  | { event: 'PROFILE_AVAILABLE'; key: ProfileKey; demand?: ProfileDemand }
  | {
      event: 'PROFILE_UNAVAILABLE';
      key: ProfileKey;
      reason: string;
    };

/** Cached profile-namespace binding for one (publisher, nsid-in-publisher)
 *  pair. `domain`/`rootPublicKey` mirror the server's resolve answer; a null
 *  domain is a tomb (the publisher reports no binding). An expired row must
 *  be re-resolved before its data is displayed.
 *
 *  Two coordinates with different spaces: `updateFeedId` is the publisher's
 *  own feed position from a resolve answer; `changeSeq` is the local change
 *  feed position last applied to this row. The commit guard compares against
 *  the sync round's end in the change space, so a resolve answer fetched
 *  before a newer change entry can never resurrect stale bindings. Both are
 *  JSON numbers on the client wire. */
export interface AccountInvalidationSource {
  readonly invalidated$: Observable<unknown>;
}

/** Cached profile-namespace binding for one (publisher, nsid-in-publisher)
 * pair. */
export interface ProfileNamespaceBinding {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: number;
  changeSeq: number;
  expired: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  refreshedAt: number;
}

/** Identity of one cached binding row; also the resolve-request pair shape. */
export interface ProfileNamespacePairKey {
  publisherNamespaceId: number;
  profileNamespaceId: number;
}

/** Federation-reported permanent loss of a namespace binding (the
 *  FEDERATION_NAMESPACE_UNRECOVERABLE code). A row's presence is the tomb;
 *  binding content is empty. Sparse by design. */
export interface ProfileNamespaceTomb {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  createdAt: number;
}

/** Federation-reported permanent loss of a profile (the
 *  FEDERATION_PROFILE_UNRECOVERABLE code). Tomb spans every rev, so the key
 *  omits profileRev. Sparse by design. */
export interface ProfileTomb {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  createdAt: number;
}

/** One materialized roster member selecting an exact profile revision. */
export interface MemberRecord {
  threadId: number;
  account: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  left: boolean;
  /** Profile reference selected by this group's metadata. */
  profileRev: number;
}

export interface ResolvedMemberRecord extends MemberRecord {
  /** Presentation is joined from the selected immutable profile. */
  resolvedProfileRev?: number;
  profileName?: string;
  profileBio: string;
  user: ProfileSnapshot;
}

type ClientRelationshipIntentBody = Extract<
  ClientStateFeedItem,
  { eventType: 'RELATIONSHIP_INTENT' }
>['body'];
type ClientRelationshipIntentItem = Extract<
  ClientStateFeedItem,
  { eventType: 'RELATIONSHIP_INTENT' }
>;

/** A value persisted in a stable KV store (`meta` or `syncState`, keyPath `'key'`).
 *  `value` is opaque to the store (structured-cloneable); the caller owns its shape + narrowing.
 *  `meta` holds non-cursor account state (schemaVersion, selfProfile, selfIdentity, composerDrafts);
 *  `syncState` holds account-level sync cursors. The thread-list revision cursor stays in-memory in
 *  UserService (seeded from /user/my-profile each boot) — it does NOT live here. */
interface MetaRecord {
  key: string;
  value: unknown;
}

/** Per-thread sync progress, keyed by `threadId` (keyPath `'threadId'`) in the message DB's
 *  `threadSyncState` store. Each cursor is independently absent until first written. */
interface ThreadSyncRecord {
  threadId: number;
  messageHead?: number;
  deletedHwm?: number;
}

type CachedMessageBody = Message;

/** A deletion learned before its message body. It deliberately has no synthetic content or creator. */
type CachedMessageTombstone = MessageDeletionMarker | MessageTomb;

type CachedMessage = CachedMessageBody | CachedMessageTombstone;

function mergeCachedMessage(
  current: CachedMessage | undefined,
  incoming: MessageQueryRow,
): CachedMessage {
  const merged = mergeMessageSlot<Message>(current, incoming);
  if (
    isCachedMessageBody(merged) &&
    merged.contentType === 'SYSTEM' &&
    current &&
    isCachedMessageBody(current) &&
    current.contentType === 'SYSTEM' &&
    current.content === merged.content &&
    current.localSystemProfileRevs
  )
    return {
      ...merged,
      localSystemProfileRevs: current.localSystemProfileRevs,
    };
  return merged;
}

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

function readMessageHead(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isSafeInteger(value) && (value as number) >= 0)
    return value as number;
  throw new Error('message head must be a non-negative integer');
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
type ThreadPreview = NonNullable<ThreadFeedSnapshot['previews']>[number];

type StoredThreadPreview = {
  threadId: number;
  seq: number;
  createdAt: string;
  senderAccount: string;
  senderProfileNamespaceId: number;
  senderProfileRev: number;
  status: ThreadPreview['status'];
  text: string | null;
};

function storeThreadPreview(
  threadId: number,
  preview: ThreadPreview,
): StoredThreadPreview {
  return {
    threadId,
    seq: preview.seq,
    createdAt: preview.createdAt,
    senderAccount: preview.sender.account,
    senderProfileNamespaceId: preview.sender.profileNamespaceId,
    senderProfileRev: preview.sender.profileRev,
    status: preview.status,
    text: preview.text ?? null,
  };
}

function restoreThreadPreview(row: StoredThreadPreview): ThreadPreview {
  return {
    seq: row.seq,
    createdAt: row.createdAt,
    sender: {
      account: row.senderAccount,
      profileNamespaceId: row.senderProfileNamespaceId,
      profileRev: row.senderProfileRev,
    },
    status: row.status,
    ...(row.text === null ? {} : { text: row.text }),
  };
}

function storeThreadAttention(
  state: LocalThreadAttention,
): StoredThreadAttention {
  const { previews: _previews, ...fields } = state;
  return fields;
}

function withStoredPreview(
  state: StoredThreadAttention,
  row: StoredThreadPreview | undefined,
): LocalThreadAttention {
  const {
    threadId,
    threadFeedId,
    type,
    publisherNamespaceId,
    conversationState,
    blocked,
    role,
    profileAccount,
    alias,
    profileRev,
    messageEndSeq,
    tombstoneEndSeq,
    groupMetaFeedEndId,
    joinRequestEndFeedId,
    joinRequestReadFeedId,
    groupInviteEndFeedId,
    lastReadSeq,
    announcementReadFeedId,
    unreadCount,
    lastMentionSeq,
    localReadSeq,
  } = state;
  return {
    threadId,
    threadFeedId,
    type,
    publisherNamespaceId,
    selfMentionNamespaceId: state.selfMentionNamespaceId,
    conversationState,
    blocked,
    role,
    alias,
    profileRev,
    messageEndSeq,
    tombstoneEndSeq,
    groupMetaFeedEndId,
    joinRequestEndFeedId,
    joinRequestReadFeedId,
    groupInviteEndFeedId,
    lastReadSeq,
    announcementReadFeedId,
    unreadCount,
    lastMentionSeq,
    localReadSeq,
    profileAccount,
    previews: row ? [restoreThreadPreview(row)] : [],
  };
}

/** Attention facts a projection is derived from. Comparing them inside the write transaction
 *  implements a compare-and-set: derived columns are persisted only against the exact facts the
 *  projection was computed from, so a result computed before a concurrent feed merge or local read
 *  advance can never overwrite the newer projection state. */
function attentionFactsUnchanged(
  snapshotRow: StoredThread,
  snapshotPreview: StoredThreadPreview | undefined,
  currentRow: StoredThread,
  currentPreview: StoredThreadPreview | undefined,
): boolean {
  return (
    snapshotRow.threadFeedId === currentRow.threadFeedId &&
    snapshotRow.messageEndSeq === currentRow.messageEndSeq &&
    snapshotRow.lastReadSeq === currentRow.lastReadSeq &&
    snapshotRow.unreadCount === currentRow.unreadCount &&
    snapshotRow.lastMentionSeq === currentRow.lastMentionSeq &&
    snapshotRow.localReadSeq === currentRow.localReadSeq &&
    snapshotPreview?.seq === currentPreview?.seq &&
    snapshotPreview?.createdAt === currentPreview?.createdAt &&
    snapshotPreview?.status === currentPreview?.status &&
    snapshotPreview?.text === currentPreview?.text &&
    snapshotPreview?.senderAccount === currentPreview?.senderAccount &&
    snapshotPreview?.senderProfileNamespaceId ===
      currentPreview?.senderProfileNamespaceId
  );
}

function requireThreadIdentity(
  item: ConversationItem,
  state: StoredThreadAttention | undefined,
): asserts state is StoredThreadAttention {
  const subject = item.type === 'GROUP' ? item.group : item.peerUser;
  if (
    !state ||
    state.threadId !== item.threadId ||
    state.type !== item.type ||
    state.publisherNamespaceId !== item.publisherNamespaceId ||
    state.profileAccount !== subject.account
  )
    throw new Error('thread presentation has no matching feed state');
}

export interface WebdbSchema extends DBSchema {
  profiles: {
    key: [number, number, string, number];
    value: ProfileSnapshot;
  };
  profileAvatarBlobs: { key: string; value: { digest: string; blob: Blob } };
  profileNamespaces: {
    key: [number, number];
    value: ProfileNamespaceBinding;
  };
  profileNamespaceTombs: {
    key: [number, number];
    value: ProfileNamespaceTomb;
  };
  profileTombs: {
    key: [number, number, string];
    value: ProfileTomb;
  };
  members: {
    key: [number, string, number];
    value: MemberRecord;
    indexes: {
      thread: number;
      address: [number, string, number];
    };
  };
  /** One record per conversation, keyed by `threadId` (the field is the keyPath). */
  threads: { key: number; value: StoredThread };
  threadPreviews: { key: number; value: StoredThreadPreview };
  relationshipRequests: {
    key: string;
    value: FriendRequestProjection;
    indexes: { bucketStatus: [string, string, number, string] };
  };
  /** Non-cursor account state (schemaVersion, selfProfile, selfIdentity, composerDrafts). */
  meta: { key: string; value: MetaRecord };
  /** Account-level sync cursors (threadFeedCursor, stateFeedId, stateFeedFullThrough,
   *  profileNamespaceChangeEndId, relationshipRequestStateRevision,
   *  relationshipIntentStateRevision, relationshipRequestReadHead,
   *  relationshipRequestCleanupAt). */
  syncState: { key: string; value: MetaRecord };
}

export interface MessageDbSchema extends DBSchema {
  /** Stable KV store for the message-cache schema version. */
  meta: { key: string; value: MetaRecord };
  /** One record per message, keyed by `[threadId, seq]` (both fields are the keyPath). */
  messages: {
    key: [number, number];
    value: CachedMessage;
    indexes: { byOrigin: [number, number, number] };
  };
  messageRanges: {
    key: [number, number];
    value: MessageRange;
    indexes: { byThreadRight: [number, number] };
  };
  /** Per-thread sync cursors (messageHead, deletedHwm), keyed by `threadId`. */
  threadSyncState: { key: number; value: ThreadSyncRecord };
}

const DB_PREFIX = 'soms-webdb-u';
const MESSAGE_DB_PREFIX = 'soms-msgdb-u';
export const CACHE_SCHEMA_VERSION = 1;
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

function normalizeProfileSnapshot<T extends ProfileSnapshot>(snapshot: T): T {
  return {
    ...snapshot,
    account: snapshot.account.trim().toLowerCase(),
  };
}

function profileStoreKey(
  profile: ProfileSnapshot,
): [number, number, string, number] {
  return [
    profile.publisherNamespaceId,
    profile.profileNamespaceId,
    profile.account,
    profile.profileRev,
  ];
}

function parseProfileKey(value: unknown): ProfileKey | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = value as Partial<ProfileKey>;
  if (
    !Number.isSafeInteger(candidate.publisherNamespaceId) ||
    Number(candidate.publisherNamespaceId) < 0 ||
    !Number.isSafeInteger(candidate.profileNamespaceId) ||
    Number(candidate.profileNamespaceId) < 0 ||
    typeof candidate.account !== 'string' ||
    candidate.account.length === 0 ||
    !Number.isSafeInteger(candidate.rev) ||
    Number(candidate.rev) < 1
  )
    return;
  return {
    publisherNamespaceId: Number(candidate.publisherNamespaceId),
    profileNamespaceId: Number(candidate.profileNamespaceId),
    account: candidate.account,
    rev: Number(candidate.rev),
  };
}

export type StateFeedWorkerFactory = () => Worker | null;

/** Fire-and-forget events the worker pushes without a request id. */
type StateFeedWorkerEvent =
  | { type: 'message-db-committed'; userId: number; threadId: number }
  | {
      type: 'notification-batch';
      userId: number;
      entries: BrowserNotificationBatch['entries'];
    }
  | { type: 'profile-wake'; wake: ProfileWake }
  | {
      type: 'tombstone-committed';
      threadId: number;
      tombstones: Array<{
        seq: number;
        type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
      }>;
    }
  | {
      type: 'thread-feed-committed';
      userId: number;
      states: LocalThreadAttention[];
    }
  | {
      type: 'thread-attention-projection-committed';
      userId: number;
      projection: ThreadAttentionProjection;
    }
  | {
      type: 'group-meta-committed';
      userId: number;
      threadIds: number[];
      patches: GroupMetaCommitPatch[];
    }
  | { type: 'state-feed-committed'; userId: number };

/** A request response carrying the pending id. */
type StateFeedWorkerResponse =
  | {
      id: number;
      ok: true;
      result?: unknown;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

type StateFeedWorkerMessage = StateFeedWorkerEvent | StateFeedWorkerResponse;

/** Shared storage implementation used by page and background runtimes. */
export interface ThreadAttentionProjection {
  threadId: number;
  lastReadSeq: number;
  unreadCount: number;
  mentionUnread: Array<'all' | 'me'>;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
  lastMessageSenderAccount: string | null;
  lastMessageSenderNamespaceId: number | null;
}

export class WebdbStorage {
  protected readonly messageDbCommitted = new Subject<{
    userId: number;
    threadId: number;
  }>();
  readonly messageDbCommitted$ = this.messageDbCommitted.asObservable();
  private readonly workerFailed = new Subject<void>();
  readonly workerFailed$ = this.workerFailed.asObservable();
  private readonly browserNotifications =
    new Subject<BrowserNotificationBatch>();
  readonly browserNotifications$ = this.browserNotifications.asObservable();
  private readonly profileWake = new Subject<ProfileWake>();
  readonly profileWake$ = this.profileWake.asObservable();
  /** Emitted by the database worker after each tombstone page commits, so the
   *  message repository can project deletions into mounted sources. */
  protected readonly tombstoneCommitted = new Subject<{
    threadId: number;
    deletions: Array<{
      seq: number;
      type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    }>;
  }>();
  readonly tombstoneCommitted$ = this.tombstoneCommitted.asObservable();
  /** Emitted after each durable thread-feed page commits. The executor and
   * renderer consume the same committed states without re-reading storage. */
  protected readonly threadFeedCommitted = new Subject<{
    userId: number;
    states: LocalThreadAttention[];
  }>();
  readonly threadFeedCommitted$ = this.threadFeedCommitted.asObservable();

  protected readonly threadAttentionProjectionCommitted = new Subject<{
    userId: number;
    projection: ThreadAttentionProjection;
  }>();
  readonly threadAttentionProjectionCommitted$ =
    this.threadAttentionProjectionCommitted.asObservable();
  /** Emitted by the database worker after a per-thread Group Meta drain commits.
   *  `patches` carries the committed Group Meta facts so the renderer patches its
   *  in-memory conversations directly; `threadIds` additionally covers threads whose
   *  member-profile materialization changed without a meta row change. */
  protected readonly groupMetaCommitted = new Subject<{
    userId: number;
    threadIds: number[];
    patches: GroupMetaCommitPatch[];
  }>();
  readonly groupMetaCommitted$ = this.groupMetaCommitted.asObservable();
  /** Emitted by the database worker after a state-feed drain commits. */
  protected readonly stateFeedCommitted = new Subject<{ userId: number }>();
  readonly stateFeedCommitted$ = this.stateFeedCommitted.asObservable();
  /** Emitted twice per change-feed page with the touched pairs: first
   *  after the expiry transaction commits (consumers mirror the expired
   *  state: DB first, cache second), then after the resolve round commits
   *  fresh answers (consumers re-read). A resolve failure still delivers
   *  the first wake; the expired rows stay until the next retry. */
  private readonly profileNamespaceWake = new Subject<
    ProfileNamespacePairKey[]
  >();
  /** Change-feed pull scheduler: single-flight with a trailing edge, so the
   *  HELLO anchor and SSE wakes never start parallel drains, and a wake that
   *  lands mid-drain still gets observed by one trailing round. */
  private readonly profileNamespacePull = new TrailingSingleFlight<
    number | undefined
  >((anchor) =>
    this.runAccountOperation(() =>
      this.pullProfileNamespaceChangesInternal(anchor),
    ),
  );
  readonly profileNamespaceWake$ = this.profileNamespaceWake.asObservable();

  async applyProfileEvent(
    event: 'PROFILE_AVAILABLE' | 'PROFILE_UNAVAILABLE',
    data: unknown,
  ): Promise<void> {
    const key = parseProfileKey(data);
    if (!key) return;
    if (event === 'PROFILE_UNAVAILABLE') {
      const reason =
        data &&
        typeof data === 'object' &&
        typeof (data as { reason?: unknown }).reason === 'string'
          ? (data as { reason: string }).reason
          : 'TEMPORARILY_UNAVAILABLE';
      this.profileWake.next({ event, key, reason });
      return;
    }
    const result = await this.resolveProfileDemand(
      {
        publisherNamespaceId: key.publisherNamespaceId,
        lookup: 'ACCOUNT_PROFILE',
        target: {
          profileNamespaceId: key.profileNamespaceId,
          account: key.account,
          rev: key.rev,
        },
      },
      { evidence: null },
    );
    // Native SSE is delivered after SQLite materialization. Browser commits
    // notify through the worker instead of emitting again at the request layer.
    if (isTauri() && result.status === 'READY') {
      this.profileWake.next({ event, key });
    }
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
  protected cacheEpoch = 0;
  private accountResetPromise: Promise<IDBPDatabase<WebdbSchema> | null> | null =
    null;
  private accountResetUserId: string | null = null;
  /** Full account-cache operation barrier. Core and message operations are admitted synchronously; full
   * recreation/logout closes admission and waits for every admitted native/IDB operation to settle. */
  private accountOperations = 0;
  protected accountMaintenance = false;
  private accountIdleWaiters: Array<() => void> = [];
  /** Aborted before message-cache maintenance starts. Network work captures this signal and must pass it
   * back when entering a write operation, so a response from the old cache lifetime cannot populate the
   * replacement database. */
  private messageLifetime = new AbortController();
  /** The userId whose DB is open (or being opened). */
  protected currentUserId: string | null = null;
  /** Whether `navigator.storage.persist()` has been requested for this origin. */
  private persistedRequested = false;

  /** True once the current user's database is open and ready for reads/writes. */
  readonly ready = signal(false);
  private readonly sessionInvalidation?: Subscription;

  constructor(
    private readonly stateFeedWorkerFactory: StateFeedWorkerFactory = () =>
      null,
    lifecycle?: AccountInvalidationSource,
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
    if (!db.objectStoreNames.contains('meta')) {
      db.close();
      throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
    }
    try {
      if (
        (await db.get('meta', 'schemaVersion'))?.value !== CACHE_SCHEMA_VERSION
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
    if (!db.objectStoreNames.contains('meta')) {
      db.close();
      throw new LocalCacheUnavailableError(`invalid local cache: ${name}`);
    }
    try {
      if (
        (await db.get('meta', 'schemaVersion'))?.value !==
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
      'profileNamespaces',
      'profileNamespaceTombs',
      'profileTombs',
      'profiles',
      'profileAvatarBlobs',
      'members',
      'threads',
      'threadPreviews',
      'relationshipRequests',
      'meta',
      'syncState',
    ] as const;
    if (required.some((store) => !db.objectStoreNames.contains(store)))
      return false;
    if (db.objectStoreNames.length !== required.length) return false;
    try {
      const version = await db.get('meta', 'schemaVersion');
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
        db.createObjectStore('profiles', {
          keyPath: [
            'publisherNamespaceId',
            'profileNamespaceId',
            'account',
            'profileRev',
          ],
        });
        db.createObjectStore('profileNamespaces', {
          keyPath: ['publisherNamespaceId', 'profileNamespaceId'],
        });
        db.createObjectStore('profileNamespaceTombs', {
          keyPath: ['publisherNamespaceId', 'profileNamespaceId'],
        });
        db.createObjectStore('profileTombs', {
          keyPath: ['publisherNamespaceId', 'profileNamespaceId', 'account'],
        });
        db.createObjectStore('profileAvatarBlobs', { keyPath: 'digest' });
        const members = db.createObjectStore('members', {
          keyPath: ['threadId', 'account', 'namespaceId'],
        });
        members.createIndex('thread', 'threadId');
        members.createIndex('address', ['threadId', 'account', 'namespaceId']);
        db.createObjectStore('threads', { keyPath: 'threadId' });
        db.createObjectStore('threadPreviews', { keyPath: 'threadId' });
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
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('syncState', { keyPath: 'key' });
        transaction.objectStore('meta').put({
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
        db.createObjectStore('meta', { keyPath: 'key' });
        const messages = db.createObjectStore('messages', {
          keyPath: ['threadId', 'seq'],
        });
        messages.createIndex('byOrigin', [
          'threadId',
          'publisherNamespaceId',
          'originSeq',
        ]);
        const ranges = db.createObjectStore('messageRanges', {
          keyPath: ['threadId', 'left'],
        });
        ranges.createIndex('byThreadRight', ['threadId', 'right']);
        db.createObjectStore('threadSyncState', { keyPath: 'threadId' });
        transaction.objectStore('meta').put({
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
      db.objectStoreNames.length !== 4 ||
      !db.objectStoreNames.contains('meta') ||
      !db.objectStoreNames.contains('messages') ||
      !db.objectStoreNames.contains('messageRanges') ||
      !db.objectStoreNames.contains('threadSyncState')
    )
      return false;
    try {
      if (
        (await db.get('meta', 'schemaVersion'))?.value !==
        MESSAGE_CACHE_SCHEMA_VERSION
      )
        return false;
      const rangeIndexes = db.transaction('messageRanges').store.indexNames;
      return (
        rangeIndexes.contains('byThreadRight') &&
        db.transaction('messages').store.indexNames.contains('byOrigin')
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
    this.terminateStateFeedWorker();
    this.accountMaintenance = true;
    this.messageResetting = true;
    this.messageLifetime.abort();
    this.ready.set(false);
  }

  protected activateMessageLifetime(): void {
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

  /** Number of cached message rows for the active user. Coverage/thread-sync-state rows are deliberately excluded. */
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

  // ---- core sync-state store: keyed synchronization cursors ------------------------------

  async getThreadStates(): Promise<LocalThreadAttention[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<LocalThreadAttention[]>('native_db_thread_states', {
          userId: Number(this.currentUserId),
        });
      const tx = (await this.db()).transaction(
        ['threads', 'threadPreviews'],
        'readonly',
      );
      const [states, previews] = await Promise.all([
        tx.objectStore('threads').getAll(),
        tx.objectStore('threadPreviews').getAll(),
      ]);
      await tx.done;
      const byThread = new Map(previews.map((row) => [row.threadId, row]));
      return states.map((state) =>
        withStoredPreview(state, byThread.get(state.threadId)),
      );
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
        ['threads', 'threadPreviews', 'syncState'],
        'readonly',
      );
      const [rows, previews, stored] = await Promise.all([
        tx.objectStore('threads').getAll(),
        tx.objectStore('threadPreviews').getAll(),
        tx.objectStore('syncState').get('threadFeedCursor'),
      ]);
      await tx.done;
      const cursor = Number(stored?.value ?? 0);
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > 2147483647)
        throw new Error('invalid local thread feed cursor');
      const byThread = new Map(previews.map((row) => [row.threadId, row]));
      return {
        cursor,
        states: rows
          .filter(
            (row) => row.threadFeedId > after && row.threadFeedId <= cursor,
          )
          .map((row) => withStoredPreview(row, byThread.get(row.threadId))),
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
      const incoming = states.map((state) => {
        const snapshot = attentionSnapshot(
          mergeThreadAttention(undefined, state),
        )!;
        // Computing the single durable preview before opening IDB keeps malformed
        // pages from committing a partial structural row.
        const latest = snapshot.previews!.reduce<ThreadPreview | undefined>(
          (value, preview) =>
            !value || preview.seq > value.seq ? preview : value,
          undefined,
        );
        return {
          snapshot,
          latest: latest
            ? storeThreadPreview(snapshot.threadId, latest)
            : undefined,
        };
      });
      if (
        scannedThrough !== undefined &&
        (!Number.isInteger(scannedThrough) ||
          scannedThrough < 0 ||
          scannedThrough > 2_147_483_647)
      )
        throw new Error('Invalid attention feed cursor');
      if (isTauri())
        throw new Error(
          'native thread feed synchronization belongs to the Rust SSE executor',
        );
      const tx = (await this.db()).transaction(
        ['threadPreviews', 'threads', 'syncState'],
        'readwrite',
      );
      const store = tx.objectStore('threads');
      const previewStore = tx.objectStore('threadPreviews');
      const merged = new Map<number, LocalThreadAttention>();
      const commit = async (): Promise<LocalThreadAttention[]> => {
        for (const { snapshot, latest } of incoming) {
          const stored = await store.get(snapshot.threadId);
          if (
            stored &&
            (stored.type !== snapshot.type ||
              stored.publisherNamespaceId !== snapshot.publisherNamespaceId ||
              stored.profileAccount !== snapshot.profileAccount)
          )
            throw new Error('thread feed changed a conversation identity');
          const current = stored
            ? withStoredPreview(
                stored,
                await previewStore.get(snapshot.threadId),
              )
            : undefined;
          const next = mergeThreadAttention(current, snapshot);
          if (next !== current) {
            const structure = applyThreadStateSnapshot(
              stored ? restoreThreadForStorageMutation(stored) : undefined,
              snapshot,
              snapshot.threadFeedId,
            );
            await store.put({
              ...storeThreadPresentation(structure),
              ...storeThreadAttention(next),
            });
            if (latest) await previewStore.put(latest);
            else await previewStore.delete(next.threadId);
          }
          merged.set(next.threadId, next);
        }
        if (scannedThrough !== undefined) {
          const syncState = tx.objectStore('syncState');
          const cursor = await syncState.get('threadFeedCursor');
          await syncState.put({
            key: 'threadFeedCursor',
            value: Math.max(Number(cursor?.value ?? 0), scannedThrough),
          });
        }
        await tx.done;
        return [...merged.values()];
      };
      try {
        const result = await commit();
        this.threadFeedCommitted.next({
          userId: Number(this.currentUserId),
          states: result,
        });
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* Transaction may already have aborted. */
        }
        await tx.done.catch(() => undefined);
        throw error;
      }
    });
  }

  async advanceThreadRead(
    threadId: number,
    seq: number,
  ): Promise<LocalThreadAttention> {
    return this.runAccountOperation(async () => {
      if (
        !Number.isSafeInteger(threadId) ||
        threadId < 1 ||
        !Number.isSafeInteger(seq) ||
        seq < 0
      )
        throw new Error('invalid local read position');
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<LocalThreadAttention>(
          'native_db_advance_thread_read',
          {
            userId: Number(this.currentUserId),
            threadId,
            seq,
          },
        );
      const tx = (await this.db()).transaction(
        ['threads', 'threadPreviews'],
        'readwrite',
      );
      const stored = await tx.objectStore('threads').get(threadId);
      if (!stored) {
        await tx.done;
        throw new Error('cannot mark a thread read before its feed snapshot');
      }
      const current = withStoredPreview(
        stored,
        await tx.objectStore('threadPreviews').get(threadId),
      );
      const next = advanceLocalAttentionRead(current, seq);
      if (next !== current)
        await tx.objectStore('threads').put({
          ...stored,
          ...storeThreadAttention(next),
        });
      await tx.done;
      return next;
    });
  }

  /** Read a value from the `meta` store, or `undefined` when absent / IDB unavailable. The value is
   *  opaque to the store — the caller owns its shape + narrowing. */
  async getMeta(key: string): Promise<unknown> {
    return this.runAccountOperation(() => this.getMetaInternal(key));
  }

  private async getMetaInternal(key: string): Promise<unknown> {
    return this.readStateStore('meta', key);
  }

  /** Read an account-level sync cursor from the `syncState` store. */
  async getSyncState(key: string): Promise<unknown> {
    return this.runAccountOperation(() => this.getSyncStateInternal(key));
  }

  private async getSyncStateInternal(key: string): Promise<unknown> {
    return this.readStateStore('syncState', key);
  }

  /** Shared read for `meta` / `syncState`. On Tauri both map to the native `sync_state` KV (the native
   *  runtime keeps cursors and self-profile in one table); the browser split is a local-storage
   *  concern only. */
  private async readStateStore(
    store: 'meta' | 'syncState',
    key: string,
  ): Promise<unknown> {
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
      const rec = await (await this.db()).get(store, key);
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
    return this.writeStateStore('meta', key, value);
  }

  /** Write an account-level sync cursor to the `syncState` store. */
  async putSyncState(key: string, value: unknown): Promise<void> {
    return this.runAccountOperation(() =>
      this.putSyncStateInternal(key, value),
    );
  }

  private async putSyncStateInternal(
    key: string,
    value: unknown,
  ): Promise<void> {
    return this.writeStateStore('syncState', key, value);
  }

  private async writeStateStore(
    store: 'meta' | 'syncState',
    key: string,
    value: unknown,
  ): Promise<void> {
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
      await (await this.db()).put(store, { key, value });
    } catch {
      /* best-effort */
    }
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
      const statuses = Object.values(RequestProjectionStatus);
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
      const threads = await tauriInvoke<ConversationItem[]>(
        'native_db_threads',
        {
          userId: Number(this.currentUserId),
        },
      );
      return threads.map((thread) => ({
        ...this.normalizeThreadSubject(thread),
        alias: thread.alias,
      }));
    }
    const tx = (await this.db()).transaction('threads', 'readonly');
    const threads = await tx.objectStore('threads').getAll();
    await tx.done;
    return threads
      .map((thread) =>
        restoreThread(thread, {
          namespaceId: thread.publisherNamespaceId,
        }),
      )
      .map((thread) => ({
        ...this.normalizeThreadSubject(thread),
        alias: thread.alias,
      }));
  }

  private normalizeThreadSubject(item: ConversationItem): ConversationItem {
    // The feed-state columns own private aliases; presentation writes never replace them.
    item = { ...item };
    delete item.alias;
    if (item.type === 'P2P') {
      const peer = localSubjectIdentity(item.peerUser);
      // Ignore the numeric user id in caches written by older clients; conversation peers are addresses.
      const {
        id: _legacyId,
        profileRev: _nestedRev,
        ...peerUser
      } = peer as typeof peer & {
        id?: number;
        profileRev?: number;
      };
      return { ...item, peerUser };
    }
    const group = localSubjectIdentity(item.group);
    const { profileRev: _nestedRev, ...groupProfile } =
      group as typeof group & {
        profileRev?: number;
      };
    return {
      ...item,
      group: groupProfile,
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
    const tx = (await this.db()).transaction(['threads'], 'readwrite');
    // Presentation-only batch: omitted entries retain their authoritative
    // feed state; clearing the table here would silently lose valid threads.
    const previous = new Map(
      (await tx.objectStore('threads').getAll()).map((item) => [
        item.threadId,
        item,
      ]),
    );
    const selected: ConversationItem[] = [];
    for (const item of items) {
      const state = previous.get(item.threadId);
      try {
        requireThreadIdentity(item, state);
      } catch (error) {
        tx.abort();
        await tx.done.catch(() => undefined);
        throw error;
      }
      selected.push(
        preserveThreadProfile(
          { ...item, profileRev: state.profileRev },
          restoreThreadForStorageMutation(state),
        ),
      );
    }
    for (const item of selected) {
      await tx.objectStore('threads').put({
        ...previous.get(item.threadId)!,
        ...storeThreadPresentation(item),
      });
    }
    await tx.done;
  }

  async projectThreadAttention(
    threadId: number,
    self: MessageCreator,
  ): Promise<ThreadAttentionProjection> {
    // Capture the owning account before the async operation: emitting a late
    // projection under a switched account would tag another user's list.
    const userId = Number(this.currentUserId);
    const result = await this.runAccountOperation(() =>
      this.projectThreadAttentionInternal(threadId, self),
    );
    this.threadAttentionProjectionCommitted.next({
      userId,
      projection: result,
    });
    return result;
  }

  private async projectThreadAttentionInternal(
    threadId: number,
    self: MessageCreator,
  ): Promise<ThreadAttentionProjection> {
    if (
      !Number.isSafeInteger(threadId) ||
      threadId < 1 ||
      !self.account ||
      !Number.isSafeInteger(self.namespaceId) ||
      self.namespaceId < 0
    )
      throw new Error('invalid thread attention projection');
    if (isTauri() && this.currentUserId != null)
      return tauriInvoke<ThreadAttentionProjection>(
        'native_db_project_thread_attention',
        {
          userId: Number(this.currentUserId),
          threadId,
          owner: self,
        },
      );
    const core = await this.db();
    // Facts-first two-phase projection. The attention facts (thread state row + preview row) and
    // the message-DB slot count live in two databases, so they cannot share one transaction.
    // Instead: read one consistent core snapshot, count outside any core transaction, then
    // persist the derived columns only when the committed facts still match that snapshot
    // (compare-and-set). A mismatch means a concurrent feed merge / local read just committed
    // newer facts — every such writer triggers its own projection afterwards, so this attempt
    // simply fails instead of retrying: no stale result ever reaches the row or the event payload.
    const snapshotTx = core.transaction(
      ['threads', 'threadPreviews'],
      'readonly',
    );
    const stored = await snapshotTx.objectStore('threads').get(threadId);
    const preview = await snapshotTx
      .objectStore('threadPreviews')
      .get(threadId);
    await snapshotTx.done;
    if (!stored)
      throw new Error('cannot reproject thread attention before state exists');
    const state = withStoredPreview(stored, preview);
    const range = attentionCountRange(state);
    const count = await this.countUnreadMessageSlots(
      threadId,
      range.afterSeq,
      range.throughSeq,
      self,
    );
    const projection = projectThreadAttention(state, count);
    const previewText = preview
      ? preview.status === 'LIVE'
        ? (preview.text ?? '')
        : preview.status === 'USER_RETRACTION'
          ? '[Message retracted]'
          : '[Message removed by administrator]'
      : null;
    const result: ThreadAttentionProjection = {
      threadId,
      lastReadSeq: projection.lastReadSeq,
      unreadCount: projection.unreadCount,
      mentionUnread: projection.hasUnreadMention ? ['me'] : [],
      lastMessagePreview: previewText,
      lastMessageAt: preview ? Date.parse(preview.createdAt) : null,
      lastMessageSenderAccount: preview?.senderAccount ?? null,
      lastMessageSenderNamespaceId: preview?.senderProfileNamespaceId ?? null,
    };
    const writeTx = core.transaction(
      ['threads', 'threadPreviews'],
      'readwrite',
    );
    const current = await writeTx.objectStore('threads').get(threadId);
    const currentPreview = await writeTx
      .objectStore('threadPreviews')
      .get(threadId);
    if (!current) {
      await writeTx.done;
      throw new Error('cannot persist thread projection before state exists');
    }
    if (!attentionFactsUnchanged(stored, preview, current, currentPreview)) {
      await writeTx.done;
      throw new Error(
        'thread attention projection conflicted with concurrent facts',
      );
    }
    await writeTx.objectStore('threads').put({
      ...current,
      projectedUnreadCount: result.unreadCount,
      mentionMe: result.mentionUnread.includes('me'),
      mentionAll: result.mentionUnread.includes('all'),
      lastMessagePreview: result.lastMessagePreview,
      lastMessageAt: result.lastMessageAt,
      lastMessageSenderAccount: result.lastMessageSenderAccount,
      lastMessageSenderNamespaceId: result.lastMessageSenderNamespaceId,
    });
    await writeTx.done;
    return result;
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
      ['threads', 'profiles'],
      'readwrite',
    );
    const state = await tx.objectStore('threads').get(item.threadId);
    try {
      requireThreadIdentity(item, state);
    } catch (error) {
      await tx.done;
      throw error;
    }
    const current = restoreThreadForStorageMutation(state);
    item = preserveThreadProfile(
      { ...item, profileRev: state.profileRev },
      current,
    );
    if ((current?.threadFeedId ?? 0) <= (item.threadFeedId ?? 0)) {
      // Attention writes can carry presentation captured before resolution.
      // The selected immutable profile owns these fields, not the caller's
      // copy of the conversation. Read it in this same write transaction.
      const identity = item.type === 'GROUP' ? item.group : item.peerUser;
      const profile =
        item.profileRev > 0
          ? await tx
              .objectStore('profiles')
              .get([
                identity.namespaceId,
                identity.namespaceId,
                identity.account,
                item.profileRev,
              ])
          : undefined;
      if (profile)
        item =
          item.type === 'GROUP'
            ? {
                ...item,
                group: {
                  ...item.group,
                  name: profile.name,
                  avatar: '',
                  description: profile.bio,
                },
              }
            : {
                ...item,
                peerUser: {
                  ...item.peerUser,
                  name: profile.name,
                  avatar: '',
                  bio: profile.bio,
                },
              };
      await tx.objectStore('threads').put({
        ...state,
        ...storeThreadPresentation(item),
      });
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
    const tx = (await this.db()).transaction(
      ['threads', 'threadPreviews', 'members'],
      'readwrite',
    );
    await tx.objectStore('threads').delete(threadId);
    await tx.objectStore('threadPreviews').delete(threadId);
    let member = await tx
      .objectStore('members')
      .index('thread')
      .openCursor(threadId);
    while (member) {
      await member.delete();
      member = await member.continue();
    }
    await tx.done;
  }

  /** Apply one compacted state-feed page and its cursor atomically. */
  async applyStateFeedPage(
    items: ClientStateFeedItem[],
    feedId: number,
    resetProjection = false,
    fullThrough?: number | null,
  ): Promise<void> {
    await this.runAccountOperation(async () => {
      await this.applyStateFeedPageInternal(
        items,
        feedId,
        resetProjection,
        [],
        fullThrough,
      );
    });
  }

  /** Apply one fetched Group Meta page and advance its durable scan cursor atomically.
   *  Resolves with the Group Meta facts the page materialized into the thread row, or
   *  null when the thread was skipped (non-group / read-only). */
  async applyGroupMetaPage(
    update: ClientGroupMetaApply,
  ): Promise<GroupMetaCommitPatch | null> {
    return this.runAccountOperation(async () => {
      const patches = await this.applyStateFeedPageInternal([], null, false, [
        update,
      ]);
      return patches[0] ?? null;
    });
  }

  /** Submit one authorized profile demand to the platform-owned database executor.
   * READY results are committed there before this promise resolves. */
  async resolveProfileDemand(
    demand: ProfileDemand,
    options: { evidence?: null } = {},
  ): Promise<ProfileResolutionAttempt> {
    if (this.accountMaintenance || this.currentUserId === null)
      throw new Error('account cache lifetime expired');
    const userId = this.currentUserId;
    const epoch = this.cacheEpoch;
    const result = isTauri()
      ? await tauriInvoke<ProfileResolutionAttempt>('native_profile_resolve', {
          userId: Number(userId),
          request: Object.hasOwn(options, 'evidence')
            ? { demand, evidence: options.evidence }
            : demand,
        })
      : await this.requestDbWorker<ProfileResolutionAttempt>({
          type: 'resolve-profile',
          userId,
          demand,
          ...(Object.hasOwn(options, 'evidence')
            ? { evidence: options.evidence }
            : {}),
        });
    if (!result) throw new Error('database worker unavailable');
    if (epoch !== this.cacheEpoch)
      throw new Error('account cache lifetime expired');
    return result;
  }

  /** Drive per-thread Group Meta + tombstone drains in the database worker.
   *
   *  `threadId === null` is the stop signal: the worker finishes the current
   *  page and commits it, then stops (the next page's guard fails). A non-null
   *  `threadId` sets it as the open thread and fires the requested drains
   *  concurrently; each checks `openThreadId === threadId` between pages. A
   *  `null` target skips that drain (e.g. a tombstone-only advance from a
   *  thread-feed commit must not re-drain Group Meta). */
  async drainThreadMisc(
    threadId: number | null,
    groupMetaEndId: string | null,
    tombstoneEndSeq: number | null,
  ): Promise<void> {
    if (this.accountMaintenance || this.currentUserId === null)
      throw new Error('account cache lifetime expired');
    const userId = this.currentUserId;
    const pending = this.requestDbWorker<void>({
      type: 'drain-thread-misc',
      userId,
      threadId,
      groupMetaEndId,
      tombstoneEndSeq,
    });
    if (!pending) throw new Error('database worker unavailable');
    await pending;
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
        event: MessageEvent<StateFeedWorkerMessage>,
      ) => {
        if (this.stateFeedWorker !== worker) return;
        const data = event.data;
        // Events carry a `type` discriminant; responses carry an `id`.
        if (!('type' in data)) {
          const pending = this.stateFeedWorkerPending.get(data.id);
          if (!pending) return;
          this.stateFeedWorkerPending.delete(data.id);
          if (data.ok) pending.resolve(data.result);
          else pending.reject(new Error(data.error));
          return;
        }
        if (data.type === 'notification-batch') {
          if (data.userId === Number(this.currentUserId))
            this.browserNotifications.next({
              userId: data.userId,
              entries: data.entries,
            });
          return;
        }
        if (data.type === 'profile-wake') {
          this.profileWake.next(data.wake);
          return;
        }
        if (data.type === 'message-db-committed') {
          if (data.userId === Number(this.currentUserId))
            this.messageDbCommitted.next(data);
          return;
        }
        if (data.type === 'tombstone-committed') {
          this.tombstoneCommitted.next({
            threadId: data.threadId,
            deletions: data.tombstones,
          });
          return;
        }
        if (data.type === 'thread-feed-committed') {
          this.threadFeedCommitted.next({
            userId: data.userId,
            states: data.states,
          });
          return;
        }
        if (data.type === 'group-meta-committed') {
          this.groupMetaCommitted.next({
            userId: data.userId,
            threadIds: data.threadIds,
            patches: data.patches,
          });
          return;
        }
        if (data.type === 'state-feed-committed') {
          this.stateFeedCommitted.next({ userId: data.userId });
          return;
        }
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
    fullThrough?: number | null,
  ): Promise<GroupMetaCommitPatch[]> {
    if (isTauri())
      throw new Error(
        'native state-feed commits belong to the Rust SSE executor',
      );
    const db = await this.db();
    const tx = db.transaction(
      [
        'threads',
        'profileNamespaces',
        'profiles',
        'members',
        'relationshipRequests',
        'syncState',
      ],
      'readwrite',
    );
    const patches: GroupMetaCommitPatch[] = [];
    try {
      if (resetProjection) {
        await tx.objectStore('relationshipRequests').clear();
        await tx
          .objectStore('syncState')
          .delete('relationshipIntentStateRevision');
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
            | 'subjectNamespaceId'
            | 'kind'
          >;
          const groupAuthored = op.account.startsWith('!');
          const groupAccount = groupAuthored ? op.account : op.subjectAccount;
          const direction =
            body.direction ?? (groupAuthored ? 'INCOMING' : 'OUTGOING');
          const group = body.group;
          if (groupAuthored && body.status === 'ACCEPTED') {
            // The group may have accepted a member's outgoing application or
            // completed its own incoming invitation. Both projections belong to
            // this group address; settle any existing pending row, but do not
            // manufacture request history from a compacted terminal fact.
            for (const side of ['INCOMING', 'OUTGOING'] as const) {
              const key = groupRequestKey(op.namespaceId, groupAccount, side);
              const current = await store.get(key);
              if (
                current?.status === 'REQUESTED' &&
                op.feedId > current.sourceFeedId
              )
                await store.put(
                  markProjectionAccepted(current, Date.now(), op.feedId),
                );
            }
            return;
          }
          const targetDirection =
            body.requestDirection ??
            projectionDirectionForFact({
              status: body.status,
              direction,
            });
          if (targetDirection === null) return;
          const key = groupRequestKey(
            op.namespaceId,
            groupAccount,
            targetDirection,
          );
          const transition = applyGroupIntentToProjection(
            await store.get(key),
            {
              namespaceId: op.namespaceId,
              feedId: op.feedId,
              ...body,
              group,
              direction,
            },
            Date.now(),
          );
          if (transition.record) await store.put(transition.record);
          if (transition.becameActionable)
            await tx.objectStore('syncState').put({
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
          | 'subjectNamespaceId'
          | 'requestedSort'
        >;
        const targetDirection =
          body.requestDirection ?? projectionDirectionForFact(body);
        if (targetDirection === null) return;
        const projectionKey = friendRequestKey(
          { ...op, direction: body.direction },
          targetDirection,
        );
        const transition = applyFriendIntentToProjection(
          await store.get(projectionKey),
          {
            namespaceId: op.namespaceId,
            feedId: op.feedId,
            account: op.account,
            subjectAccount: op.subjectAccount,
            subjectNamespaceId: op.subjectNamespaceId,
            ...body,
            peer: {
              ...body.peer,
              namespaceId: op.namespaceId,
            },
          },
          Date.now(),
        );
        if (transition.record) await store.put(transition.record);
        if (transition.becameActionable)
          await tx.objectStore('syncState').put({
            key: 'relationshipRequestStateRevision',
            value: op.feedId,
          });
      };
      // Request projections never create or revoke conversations.
      for (const op of items) {
        if (op.eventType === 'RELATIONSHIP_INTENT')
          await applyRequestProjectionEffect(op);
      }

      for (const update of groupMeta) {
        const members = tx.objectStore('members');
        const currentThread = await tx
          .objectStore('threads')
          .get(update.threadId);
        if (
          currentThread?.type !== 'GROUP' ||
          currentThread.conversationState === 'READ_ONLY'
        )
          continue;
        for (const item of update.page.items) {
          if (item.operation === 'GROUP_ANNOUNCEMENT') {
            const thread = await tx.objectStore('threads').get(update.threadId);
            if (thread?.type === 'GROUP') {
              const announcement = {
                feedId: item.feedId,
                text: item.body.text,
              };
              const presentation = restoreThreadForStorageMutation(thread);
              if (presentation.type !== 'GROUP')
                throw new Error('invalid group structure');
              const next =
                update.page.mode === 'full'
                  ? {
                      ...presentation,
                      groupMetaRecoveryAnnouncement: announcement,
                    }
                  : {
                      ...presentation,
                      group: { ...presentation.group, announcement },
                    };
              await tx.objectStore('threads').put({
                ...thread,
                ...storeThreadPresentation(next),
              });
            }
            continue;
          }
          if (item.operation === 'GROUP_PROFILE') {
            // The complete thread feed selects the avatar revision. Meta pages
            // can arrive first and must not create a competing revision in threads.
            continue;
          }
          const previous = await members
            .index('address')
            .get([update.threadId, item.body.account, item.body.namespaceId]);
          if (item.operation === 'MEMBER_DEPART') {
            if (previous) await members.put({ ...previous, left: true });
            continue;
          }
          const body = item.body;
          await members.put({
            threadId: update.threadId,
            account: body.account,
            namespaceId: body.namespaceId,
            role: body.role,
            left: false,
            profileRev: body.profileRev,
          });
        }
        const currentMembers = await members
          .index('thread')
          .getAll(update.threadId);
        const activeMembers = currentMembers.filter((member) => !member.left);
        const thread = await tx.objectStore('threads').get(update.threadId);
        if (thread?.type === 'GROUP') {
          const presentation = restoreThreadForStorageMutation(thread);
          if (presentation.type !== 'GROUP')
            throw new Error('invalid group structure');
          const next = {
            ...presentation,
            groupMetaRecoveryThrough: update.page.hasMore
              ? presentation.groupMetaRecoveryThrough
              : null,
            groupMetaRecoveryAnnouncement:
              update.page.mode === 'full' && update.page.hasMore
                ? (presentation.groupMetaRecoveryAnnouncement ?? null)
                : null,
            group: {
              ...presentation.group,
              memberCount: activeMembers.length,
              groupMetaFeedId: update.page.scannedThrough,
              ...(update.page.mode === 'full' && !update.page.hasMore
                ? {
                    announcement:
                      presentation.groupMetaRecoveryAnnouncement ?? null,
                  }
                : {}),
            },
          };
          await tx.objectStore('threads').put({
            ...thread,
            ...storeThreadPresentation(next),
          });
          patches.push({
            threadId: update.threadId,
            groupMetaFeedId: next.group.groupMetaFeedId,
            memberCount: next.group.memberCount,
            announcement: next.group.announcement ?? null,
            groupMetaRecoveryThrough: next.groupMetaRecoveryThrough ?? null,
          });
        }
      }
      for (const op of items) {
        if (op.eventType === 'RELATIONSHIP_INTENT') continue;
        if (op.eventType === 'INCOMING_INVITE_HEAD') {
          await tx.objectStore('syncState').put({
            key: 'relationshipRequestReadHead',
            value: op.body,
          });
        }
      }
      const intentRevision = items
        .filter((item) => item.eventType === 'RELATIONSHIP_INTENT')
        .reduce((highest, item) => Math.max(highest, item.feedId), 0);
      if (intentRevision > 0) {
        const syncState = tx.objectStore('syncState');
        const previous = await syncState.get('relationshipIntentStateRevision');
        await syncState.put({
          key: 'relationshipIntentStateRevision',
          value: Math.max(
            intentRevision,
            typeof previous?.value === 'number' ? previous.value : 0,
          ),
        });
      }
      if (fullThrough !== undefined) {
        const syncState = tx.objectStore('syncState');
        if (fullThrough === null)
          await syncState.delete('stateFeedFullThrough');
        else if (feedId !== null && fullThrough > feedId)
          await syncState.put({
            key: 'stateFeedFullThrough',
            value: fullThrough,
          });
        else throw new Error('invalid state-feed full boundary');
      }
      if (feedId !== null)
        await tx
          .objectStore('syncState')
          .put({ key: 'stateFeedId', value: feedId });
      await tx.done;
      return patches;
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

  /** Cached bindings for the given pairs, in request order. Missing rows
   *  are simply absent from the result — callers demand-fill. */
  async getProfileNamespaceBindings(
    pairs: readonly ProfileNamespacePairKey[],
  ): Promise<ProfileNamespaceBinding[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return tauriInvoke<ProfileNamespaceBinding[]>(
          'native_db_profile_namespace_bindings',
          {
            userId: Number(this.currentUserId),
            pairs: pairs.map((pair) => [
              pair.publisherNamespaceId,
              pair.profileNamespaceId,
            ]),
          },
        );
      }
      const db = await this.db();
      const rows: ProfileNamespaceBinding[] = [];
      for (const pair of pairs) {
        const row = await db.get('profileNamespaces', [
          pair.publisherNamespaceId,
          pair.profileNamespaceId,
        ]);
        if (row) rows.push(row);
      }
      return rows;
    });
  }

  /** Persists resolve answers from one sync round that ended at
   *  `roundEnd` (change-feed coordinate). A row whose `changeSeq` already
   *  moved past `roundEnd` was expired by a newer round; the stale answer
   *  must not resurrect it. The answer's `expired` flag is stored as-is:
   *  a fresh answer (including a null-domain "no binding" fact) carries
   *  expired=false; a stale-window answer keeps the row expired until the
   *  convergence change re-resolves it. */
  async commitProfileNamespaceBindings(
    entries: readonly Omit<
      ProfileNamespaceBinding,
      'changeSeq' | 'refreshedAt'
    >[],
    roundEnd: number,
  ): Promise<void> {
    await this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_commit_profile_namespace_bindings', {
          userId: Number(this.currentUserId),
          entries,
          roundEnd,
        });
        return;
      }
      const db = await this.db();
      const tx = db.transaction('profileNamespaces', 'readwrite');
      const store = tx.objectStore('profileNamespaces');
      for (const entry of entries) {
        const previous = await store.get([
          entry.publisherNamespaceId,
          entry.profileNamespaceId,
        ]);
        // A newer round's expiry must survive this round's stale answer.
        if ((previous?.changeSeq ?? 0) > roundEnd) continue;
        await store.put({
          ...entry,
          changeSeq: Math.max(previous?.changeSeq ?? 0, roundEnd),
          expired: entry.expired === true,
          refreshedAt: Date.now(),
        });
      }
      await tx.done;
    });
  }

  /** Persist a permanent-loss tomb for a namespace binding (the
   *  FEDERATION_NAMESPACE_UNRECOVERABLE code). Sparse by design: a row's
   *  presence is the tomb; the UI renders "gone". Idempotent — re-writing
   *  the same key refreshes `createdAt` harmlessly. */
  async writeProfileNamespaceTomb(
    pair: ProfileNamespacePairKey,
  ): Promise<void> {
    await this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_write_profile_namespace_tomb', {
          userId: Number(this.currentUserId),
          pair,
        });
        return;
      }
      const db = await this.db();
      await db.put('profileNamespaceTombs', {
        publisherNamespaceId: pair.publisherNamespaceId,
        profileNamespaceId: pair.profileNamespaceId,
        createdAt: Date.now(),
      });
    });
  }

  /** Persist a permanent-loss tomb for a profile (the
   *  FEDERATION_PROFILE_UNRECOVERABLE code). Keyed without `profileRev` —
   *  one tomb spans every revision of the account. */
  async writeProfileTomb(key: {
    publisherNamespaceId: number;
    profileNamespaceId: number;
    account: string;
  }): Promise<void> {
    await this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        await tauriInvoke('native_db_write_profile_tomb', {
          userId: Number(this.currentUserId),
          key,
        });
        return;
      }
      const db = await this.db();
      await db.put('profileTombs', {
        publisherNamespaceId: key.publisherNamespaceId,
        profileNamespaceId: key.profileNamespaceId,
        account: key.account,
        createdAt: Date.now(),
      });
    });
  }

  /** Applies one change-feed page: every item either expires a cached row or
   *  plants a tomb for a pair this device has not cached yet (feed pulled,
   *  cache not — the tomb marks the pair known-but-unresolved). Returns the
   *  pairs touched, for optional repository prefetch. A supplied checkpoint
   *  commits atomically with expiry facts. */
  async applyProfileNamespaceChanges(
    items: ReadonlyArray<{
      publisherNamespaceId: number;
      profileNamespaceId: number;
      changeId: number;
    }>,
    checkpoint?: number,
  ): Promise<ProfileNamespacePairKey[]> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return tauriInvoke<ProfileNamespacePairKey[]>(
          'native_db_apply_profile_namespace_changes',
          { userId: Number(this.currentUserId), items },
        );
      }
      const db = await this.db();
      const tx = db.transaction(
        ['profileNamespaces', 'syncState'],
        'readwrite',
      );
      const store = tx.objectStore('profileNamespaces');
      const touched: ProfileNamespacePairKey[] = [];
      for (const item of items) {
        const key: ProfileNamespacePairKey = {
          publisherNamespaceId: item.publisherNamespaceId,
          profileNamespaceId: item.profileNamespaceId,
        };
        const row = await store.get([
          key.publisherNamespaceId,
          key.profileNamespaceId,
        ]);
        if (row && row.expired && row.changeSeq >= item.changeId) continue; // stale replay
        await store.put(
          row
            ? { ...row, expired: true, changeSeq: item.changeId }
            : {
                ...key,
                domain: null,
                rootPublicKey: null,
                updateFeedId: 0,
                changeSeq: item.changeId,
                expired: true,
                status: 'ACTIVE',
                refreshedAt: 0,
              },
        );
        touched.push(key);
      }
      if (checkpoint !== undefined) {
        await tx.objectStore('syncState').put({
          key: 'profileNamespaceChangeEndId',
          value: checkpoint,
        });
      }
      await tx.done;
      return touched;
    });
  }

  /** Client change-feed cursor, persisted in syncState. The HELLO anchor
   *  (`profileNamespaceChangeEndId`) enables the skip-pull fast path; a
   *  wake (SSE PROFILE_NAMESPACE_UPDATED) or a stale cursor triggers this
   *  pull. Single-flight through the shared TrailingSingleFlight primitive.
   */
  pullProfileNamespaceChanges(anchor?: number): Promise<void> {
    return this.profileNamespacePull.trigger(anchor);
  }

  private async pullProfileNamespaceChangesInternal(
    anchor: number | undefined,
  ): Promise<void> {
    const db = await this.db();
    if (isTauri()) {
      // The native runtime owns its own SSE-driven sync; this pull is the
      // browser path. Native wiring lands with the Tauri executor.
      return;
    }
    const syncState = db.transaction('syncState');
    const cursorRow = await syncState.store.get('profileNamespaceChangeEndId');
    const cursor =
      typeof cursorRow?.value === 'number' &&
      Number.isSafeInteger(cursorRow.value)
        ? cursorRow.value
        : 0;
    await syncState.done.catch(() => undefined);
    if (anchor !== undefined && anchor === cursor) return;
    let after = cursor;
    for (;;) {
      const response = await fetch(
        `${apiPrefix()}/user/profile-namespace-feed?after=${after}&take=100`,
        { credentials: 'same-origin' },
      );
      if (!response.ok && response.status === 400 && after > 0) {
        // The server's coordinate space moved backwards (reset): resync
        // from the beginning.
        after = 0;
        continue;
      }
      if (!response.ok)
        throw new Error(
          `profile-namespace change feed HTTP ${response.status}`,
        );
      const envelope = (await response.json()) as {
        code?: number;
        data?: {
          items: Array<{
            publisherNamespaceId: number;
            profileNamespaceId: number;
            changeId: number;
          }>;
          scannedThrough: number;
          endId: number;
          hasMore: boolean;
        };
      };
      if (envelope.code !== 0 || !envelope.data)
        throw new Error('profile-namespace change feed failed');
      const page = envelope.data;
      const touched = await this.applyProfileNamespaceChanges(
        page.items,
        page.scannedThrough,
      );
      // Facts (expiry + cursor) are committed before optional repository work.
      // Namespace convergence must never hold up the change-feed drain.
      if (touched.length) this.profileNamespaceWake.next(touched);
      if (!page.hasMore) return;
      after = page.scannedThrough;
    }
  }

  /** Resolves pairs through the server cache for demanded resolution and
   *  optional repository prefetch. Each pair is a single POST:
   *  READY answers are committed; PENDING answers (server planted a tomb,
   *  refresh scheduled) are skipped — a later wake re-resolves them. A
   *  failure leaves the expired row in place; the next wake retries. */
  async resolveProfileNamespacePairs(
    pairs: readonly ProfileNamespacePairKey[],
    roundEnd: number,
  ): Promise<{
    pending: ProfileNamespacePairKey[];
    failed: ProfileNamespacePairKey[];
    unrecoverable: ProfileNamespacePairKey[];
  }> {
    const epoch = this.cacheEpoch;
    const userId = this.currentUserId;
    const assertCurrentAccount = () => {
      if (epoch !== this.cacheEpoch || userId !== this.currentUserId)
        throw new Error('namespace resolve account lifetime expired');
    };
    const pending: ProfileNamespacePairKey[] = [];
    const failed: ProfileNamespacePairKey[] = [];
    const unrecoverable: ProfileNamespacePairKey[] = [];
    for (const pair of pairs) {
      try {
        assertCurrentAccount();
        const response = await fetch(
          `${apiPrefix()}/profile-namespaces/resolve`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pair),
          },
        );
        if (!response.ok)
          throw new Error(`profile-namespace resolve HTTP ${response.status}`);
        const envelope = (await response.json()) as {
          code?: number;
          data?:
            | {
                status: 'READY';
                entry: {
                  publisherNamespaceId: number;
                  profileNamespaceId: number;
                  domain: string | null;
                  rootPublicKey: string | null;
                  updateFeedId: number;
                  expired: boolean;
                  status: 'ACTIVE' | 'ARCHIVED';
                };
              }
            | { status: 'PENDING' };
        };
        assertCurrentAccount();
        if (envelope.code === BusinessCode.FEDERATION_NAMESPACE_UNRECOVERABLE) {
          await this.runAccountOperation(async () => {
            assertCurrentAccount();
            await this.writeProfileNamespaceTomb(pair);
          });
          unrecoverable.push(pair);
          continue;
        }
        if (envelope.code !== 0 || !envelope.data)
          throw new Error('profile-namespace resolve failed');
        if (envelope.data.status === 'PENDING') {
          pending.push(pair);
          continue;
        }
        const entry = envelope.data.entry;
        await this.runAccountOperation(async () => {
          assertCurrentAccount();
          await this.commitProfileNamespaceBindings([entry], roundEnd);
        });
      } catch (error) {
        // A failed request is not PENDING — the server never acknowledged
        // it. The repository can retry on the next demand or wake;
        // failed pairs are reported back
        // instead of being silently swallowed.
        console.warn(
          '[profile-namespace] resolve failed for pair',
          pair,
          error,
        );
        failed.push(pair);
      }
    }
    return { pending, failed, unrecoverable };
  }

  async getProfile(
    demand: ProfileDemand,
  ): Promise<ProfileSnapshot | undefined> {
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return (
          (await tauriInvoke<ProfileSnapshot | null>('native_db_get_profile', {
            userId: Number(this.currentUserId),
            demand,
          })) ?? undefined
        );
      return (await this.db()).get('profiles', [
        demand.publisherNamespaceId,
        demand.target.profileNamespaceId,
        demand.target.account,
        demand.target.rev,
      ]);
    });
  }

  async profileDemandForDemand(demand: ProfileDemand): Promise<ProfileDemand> {
    return demand;
  }

  async groupAccountForThread(threadId: number): Promise<string> {
    return this.runAccountOperation(async () => {
      const state = await (await this.db()).get('threads', threadId);
      if (state?.type !== 'GROUP')
        throw new Error('Group thread is not locally available');
      return state.profileAccount;
    });
  }

  /** Resolve an demand to an already materialized local snapshot. */
  /** Resolve a demand to an already materialized local snapshot. */
  async findProfileForDemand(
    demand: ProfileDemand,
  ): Promise<ProfileSnapshot | undefined> {
    return this.runAccountOperation(async () => {
      return (await this.db()).get('profiles', [
        demand.publisherNamespaceId,
        demand.target.profileNamespaceId,
        demand.target.account,
        demand.target.rev,
      ]);
    });
  }

  private memberUser(
    member: MemberRecord,
    publisherNamespaceId: number,
    snapshot?: ProfileSnapshot,
  ): ProfileSnapshot {
    return {
      publisherNamespaceId,
      account: member.account,
      profileNamespaceId: member.namespaceId,
      profileRev: member.profileRev,
      name: snapshot?.name ?? member.account,
      avatarDigest: snapshot?.avatarDigest ?? null,
      bio: snapshot?.bio ?? '',
    };
  }

  private resolveMember(
    member: MemberRecord,
    publisherNamespaceId: number,
    snapshot?: ProfileSnapshot,
  ): ResolvedMemberRecord {
    return {
      ...member,
      user: this.memberUser(member, publisherNamespaceId, snapshot),
      resolvedProfileRev: snapshot?.profileRev,
      profileName: snapshot?.name,
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
      const thread = await tx.objectStore('threads').get(threadId);
      if (
        thread?.type !== 'GROUP' ||
        thread.conversationState === 'READ_ONLY'
      ) {
        await tx.done;
        return;
      }
      let member = await tx
        .objectStore('members')
        .index('thread')
        .openCursor(IDBKeyRange.only(threadId));
      while (member) {
        await member.delete();
        member = await member.continue();
      }
      await tx.objectStore('threads').put({
        ...thread,
        groupMetaRecoveryThrough: through,
        recoveryAnnouncementFeedId: null,
        recoveryAnnouncementText: null,
        groupMemberCount: 0,
        groupMetaFeedId: '0',
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
      const thread = await db.get('threads', params.threadId);
      if (thread?.type !== 'GROUP') return [];
      const publisherNamespaceId = thread.publisherNamespaceId;
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
          publisherNamespaceId,
          member.namespaceId,
          member.account,
          member.profileRev,
        ]);
        const user = this.memberUser(member, publisherNamespaceId, snapshot);
        if (
          !search ||
          user.name.toLocaleLowerCase().includes(search) ||
          user.account.toLocaleLowerCase().includes(search)
        )
          result.push(
            this.resolveMember(member, publisherNamespaceId, snapshot),
          );
      }
      return result;
    });
  }

  async getGroupMember(
    threadId: number,
    account: string,
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
              namespaceId,
            },
          )) ?? undefined
        );
      const db = await this.db();
      const member = await db.get('members', [threadId, account, namespaceId]);
      const thread = await db.get('threads', threadId);
      if (!member || member.left || thread?.type !== 'GROUP') return undefined;
      const snapshot = await db.get('profiles', [
        thread.publisherNamespaceId,
        namespaceId,
        account,
        member.profileRev,
      ]);
      return this.resolveMember(member, thread.publisherNamespaceId, snapshot);
    });
  }

  async getUnresolvedGroupMetaProfiles(): Promise<
    import('./group-meta-model').GroupMetaProfileReference[]
  > {
    return this.runAccountOperation(async () => {
      if (isTauri()) return [];
      const tx = (await this.db()).transaction(
        ['threads', 'members', 'profiles'],
        'readonly',
      );
      const references: import('./group-meta-model').GroupMetaProfileReference[] =
        [];
      for (const state of await tx.objectStore('threads').getAll()) {
        if (
          state.type !== 'GROUP' ||
          state.conversationState === 'READ_ONLY' ||
          state.profileRev < 1
        )
          continue;
        const cached = await tx
          .objectStore('profiles')
          .get([
            state.publisherNamespaceId,
            0,
            state.profileAccount,
            state.profileRev,
          ]);
        if (!cached)
          references.push({
            type: 'GROUP',
            threadId: state.threadId,
            account: state.profileAccount,
            namespaceId: state.publisherNamespaceId,
            rev: state.profileRev,
          });
      }
      for (const member of await tx.objectStore('members').getAll()) {
        if (member.left || member.profileRev < 1) continue;
        const thread = await tx.objectStore('threads').get(member.threadId);
        if (thread?.type !== 'GROUP') continue;
        const cached = await tx
          .objectStore('profiles')
          .get([
            thread.publisherNamespaceId,
            member.namespaceId,
            member.account,
            member.profileRev,
          ]);
        if (!cached)
          references.push({
            type: 'GROUP_MEMBER',
            threadId: member.threadId,
            account: member.account,
            namespaceId: member.namespaceId,
            rev: member.profileRev,
          });
      }
      await tx.done;
      return references;
    });
  }

  async commitResolvedGroupMetaProfile(
    reference: GroupMetaProfileReference,
    profile: {
      namespaceId: number;
      account: string;
      rev: number;
      name: string;
      bio: string;
      avatarBase64: string | null;
    },
  ): Promise<boolean> {
    if (
      profile.rev !== reference.rev ||
      profile.account !== reference.account ||
      profile.namespaceId !== reference.namespaceId
    )
      throw new Error('resolved profile does not match Group Meta reference');
    const decodedAvatar = await decodeProfileAvatar(profile.avatarBase64);
    if (reference.type === 'GROUP_MEMBER')
      return this.runAccountOperation(async () => {
        const tx = (await this.db()).transaction(
          ['threads', 'members', 'profiles', 'profileAvatarBlobs'],
          'readwrite',
        );
        const thread = await tx.objectStore('threads').get(reference.threadId);
        const member = await tx
          .objectStore('members')
          .get([reference.threadId, reference.account, reference.namespaceId]);
        if (
          thread?.type !== 'GROUP' ||
          !member ||
          member.left ||
          member.profileRev !== reference.rev
        ) {
          await tx.done;
          return false;
        }
        await this.writeSnapshot(tx.objectStore('profiles'), {
          publisherNamespaceId: thread.publisherNamespaceId,
          profileNamespaceId: reference.namespaceId,
          account: reference.account,
          profileRev: reference.rev,
          name: profile.name,
          avatarDigest: decodedAvatar?.digest ?? null,
          bio: profile.bio,
        });
        if (decodedAvatar)
          await tx.objectStore('profileAvatarBlobs').put(decodedAvatar);
        await tx.done;
        return true;
      });
    return this.runAccountOperation(async () => {
      const tx = (await this.db()).transaction(
        ['threads', 'profiles', 'profileAvatarBlobs'],
        'readwrite',
      );
      const thread = await tx.objectStore('threads').get(reference.threadId);
      if (
        thread?.type !== 'GROUP' ||
        thread.profileAccount !== reference.account ||
        thread.publisherNamespaceId !== reference.namespaceId ||
        thread.profileRev !== reference.rev
      ) {
        await tx.done;
        return false;
      }
      await this.writeSnapshot(tx.objectStore('profiles'), {
        publisherNamespaceId: reference.namespaceId,
        profileNamespaceId: 0,
        account: reference.account,
        profileRev: reference.rev,
        name: profile.name,
        avatarDigest: decodedAvatar?.digest ?? null,
        bio: profile.bio,
      });
      if (decodedAvatar)
        await tx.objectStore('profileAvatarBlobs').put(decodedAvatar);
      await tx.objectStore('threads').put({
        ...thread,
        subjectName: profile.name,
        subjectAvatar: '',
        subjectBio: profile.bio,
      });
      await tx.done;
      return true;
    });
  }

  /** Commit an immutable resolved snapshot. Runtime executors call this before notifying the UI. */
  async commitResolvedProfile(profile: {
    publisherNamespaceId: number;
    profileNamespaceId: number;
    account: string;
    rev: number;
    name: string;
    bio: string;
    avatarBase64: string | null;
  }): Promise<ProfileSnapshot> {
    const avatar = await decodeProfileAvatar(profile.avatarBase64);
    const snapshot: ProfileSnapshot = normalizeProfileSnapshot({
      publisherNamespaceId: profile.publisherNamespaceId,
      profileNamespaceId: profile.profileNamespaceId,
      account: profile.account,
      profileRev: profile.rev,
      name: profile.name,
      bio: profile.bio,
      avatarDigest: avatar?.digest ?? null,
    });
    const written = await this.runAccountOperation(async () => {
      const tx = (await this.db()).transaction(
        ['profiles', 'profileAvatarBlobs', 'threads'],
        'readwrite',
      );
      if (avatar) await tx.objectStore('profileAvatarBlobs').put(avatar);
      const written = await this.writeSnapshot(
        tx.objectStore('profiles'),
        snapshot,
      );
      for (const thread of await tx.objectStore('threads').getAll()) {
        if (
          thread.profileAccount === snapshot.account &&
          thread.publisherNamespaceId === snapshot.publisherNamespaceId &&
          thread.profileRev === snapshot.profileRev
        )
          await tx.objectStore('threads').put({
            ...thread,
            subjectName: snapshot.name,
            subjectAvatar: '',
            subjectBio: snapshot.bio,
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
          publisherNamespaceId: snapshot.publisherNamespaceId,
          profileNamespaceId: snapshot.profileNamespaceId,
          rev: snapshot.profileRev,
        },
      });
    return snapshot;
  }

  /** Read the binary avatar selected by an immutable profile snapshot. */
  async getProfileAvatarBlob(digest: string): Promise<Blob | undefined> {
    if (!/^[a-f0-9]{64}$/.test(digest)) return undefined;
    return this.runAccountOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        const bytes = await tauriInvoke<number[] | null>(
          'native_db_get_profile_avatar',
          {
            userId: Number(this.currentUserId),
            digest,
          },
        );
        return bytes
          ? new Blob([new Uint8Array(bytes)], { type: 'image/webp' })
          : undefined;
      }
      return (await (await this.db()).get('profileAvatarBlobs', digest))?.blob;
    });
  }

  private async writeSnapshot(
    store: {
      get(
        key: [number, number, string, number],
      ): Promise<ProfileSnapshot | undefined>;
      put(record: ProfileSnapshot): Promise<unknown>;
      transaction: { abort(): void; done: Promise<void> };
    },
    record: ProfileSnapshot,
  ): Promise<boolean> {
    if (typeof record.name !== 'string' || typeof record.bio !== 'string') {
      store.transaction.abort();
      await store.transaction.done.catch(() => {});
      throw new Error('profile snapshot text is incomplete');
    }
    record = normalizeProfileSnapshot(record);
    const previous = await store.get(profileStoreKey(record));
    if (previous) {
      if (
        previous.name !== record.name ||
        previous.bio !== record.bio ||
        previous.avatarDigest !== record.avatarDigest
      ) {
        store.transaction.abort();
        await store.transaction.done.catch(() => {});
        throw new Error('conflicting cached profile revision');
      }
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

  /** Persist a correction for one participant of one cached SYSTEM row only. */
  async correctSystemMessageProfile(
    threadId: number,
    seq: number,
    account: string,
    publisherNamespaceId: number,
    profileNamespaceId: number,
    profileRev: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(threadId) ||
      threadId < 1 ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      !account ||
      !Number.isSafeInteger(publisherNamespaceId) ||
      publisherNamespaceId < 0 ||
      !Number.isSafeInteger(profileNamespaceId) ||
      profileNamespaceId < 0 ||
      !Number.isSafeInteger(profileRev) ||
      profileRev < 1
    )
      throw new Error('invalid system profile correction');
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null)
        return tauriInvoke<boolean>(
          'native_db_correct_system_message_profile',
          {
            userId: Number(this.currentUserId),
            threadId,
            seq,
            account,
            publisherNamespaceId,
            profileNamespaceId,
            profileRev,
          },
        );
      const tx = (await this.messageDb()).transaction('messages', 'readwrite');
      const message = await tx.store.get([threadId, seq]);
      if (
        !message ||
        !isCachedMessageBody(message) ||
        message.contentType !== 'SYSTEM'
      ) {
        await tx.done;
        return false;
      }
      const participant = JSON.stringify([
        publisherNamespaceId,
        profileNamespaceId,
        account,
      ]);
      if (message.localSystemProfileRevs?.[participant] === profileRev) {
        await tx.done;
        return false;
      }
      await tx.store.put({
        ...message,
        localSystemProfileRevs: {
          ...message.localSystemProfileRevs,
          [participant]: profileRev,
        },
      });
      await tx.done;
      return true;
    });
  }

  async putCachedMessages(messages: MessageQueryRow[]): Promise<void> {
    if (messages.length === 0) return;
    return this.runMessageOperation(async () => {
      const userId = this.currentUserId;
      const epoch = this.cacheEpoch;
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
        await tx.store.put(mergeCachedMessage(existing, message));
      }
      await tx.done;
      if (epoch === this.cacheEpoch && userId === this.currentUserId) {
        for (const threadId of new Set(
          messages.map((message) => message.threadId),
        )) {
          this.messageDbCommitted.next({ userId: Number(userId), threadId });
        }
      }
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
      !Number.isInteger(self.namespaceId) ||
      self.namespaceId < 0 ||
      self.namespaceId > 2_147_483_647
    )
      throw new Error('Invalid unread message count range or identity');
    const owner = self;
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
      const record = await (
        await this.messageDb()
      ).get('threadSyncState', threadId);
      return readMessageHead(record?.messageHead);
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
      const tx = db.transaction('threadSyncState', 'readwrite');
      const current = await tx.store.get(threadId);
      const old = readMessageHead(current?.messageHead) ?? 0;
      await tx.store.put({
        threadId,
        ...(current?.deletedHwm !== undefined
          ? { deletedHwm: current.deletedHwm }
          : {}),
        messageHead: Math.max(knownNewestSeq, old),
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
    const userId = this.currentUserId;
    const epoch = this.cacheEpoch;
    if (input.messages.some((message) => message.threadId !== input.threadId))
      throw new Error('message page contains a message from another thread');
    if (
      input.knownNewestSeq !== undefined &&
      (!Number.isSafeInteger(input.knownNewestSeq) || input.knownNewestSeq < 0)
    )
      throw new Error('known newest message sequence is invalid');

    const tx = (await this.messageDb()).transaction(
      ['messages', 'messageRanges', 'threadSyncState'],
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
    for (const message of input.messages) {
      const existing = await messageStore.get([input.threadId, message.seq]);
      const merged = mergeCachedMessage(existing, message);
      await messageStore.put(merged);
      if (isCachedTimelineSlot(merged)) committedMessages.push(merged);
    }
    await rangeStore.delete(rangeKey);
    for (const range of ranges) await rangeStore.put(range);
    if (input.knownNewestSeq !== undefined) {
      const syncState = tx.objectStore('threadSyncState');
      const current = await syncState.get(input.threadId);
      const old = readMessageHead(current?.messageHead) ?? 0;
      await syncState.put({
        threadId: input.threadId,
        ...(current?.deletedHwm !== undefined
          ? { deletedHwm: current.deletedHwm }
          : {}),
        messageHead: Math.max(input.knownNewestSeq, old),
      });
    }
    await tx.done;
    if (epoch === this.cacheEpoch && userId === this.currentUserId) {
      this.messageDbCommitted.next({
        userId: Number(userId),
        threadId: input.threadId,
      });
    }
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

  /** Read a cached origin target without changing timeline coverage. */
  async getMessageByOrigin(
    threadId: number,
    namespaceId: number,
    originSeq: number,
  ): Promise<Message | undefined> {
    return this.runMessageOperation(async () => {
      if (isTauri() && this.currentUserId != null) {
        return (
          (await tauriInvoke<Message | null>(
            'native_db_get_message_by_origin',
            {
              userId: Number(this.currentUserId),
              threadId,
              namespaceId,
              originSeq,
            },
          )) ?? undefined
        );
      }
      const db = await this.messageDb();
      const row =
        namespaceId === 0
          ? await db.get('messages', [threadId, originSeq])
          : await db.getFromIndex('messages', 'byOrigin', [
              threadId,
              namespaceId,
              originSeq,
            ]);
      if (!row || !isCachedMessageBody(row)) return undefined;
      if (namespaceId !== 0 && row.publisherNamespaceId !== namespaceId)
        return undefined;
      return row;
    });
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
      const tx = (await this.messageDb()).transaction(
        'threadSyncState',
        'readonly',
      );
      const record = await tx.store.get(threadId);
      const hwm = readDeletedHwm(record?.deletedHwm);
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
        ['messages', 'threadSyncState'],
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
      const syncState = tx.objectStore('threadSyncState');
      const current = await syncState.get(threadId);
      await syncState.put({
        threadId,
        ...(current?.messageHead !== undefined
          ? { messageHead: current.messageHead }
          : {}),
        deletedHwm: hwm,
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
      ['messages', 'messageRanges', 'threadSyncState'],
      'readwrite',
    );
    await tx
      .objectStore('messages')
      .delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
    await tx
      .objectStore('messageRanges')
      .delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
    await tx.objectStore('threadSyncState').delete(threadId);
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
  left: Pick<MemberRecord, 'namespaceId' | 'account'>,
  right: Pick<MemberRecord, 'namespaceId' | 'account'>,
): number {
  return (
    left.namespaceId - right.namespaceId ||
    left.account.localeCompare(right.account)
  );
}
