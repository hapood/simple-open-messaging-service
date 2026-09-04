import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, map, shareReplay, firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import {
  User,
  ConversationItem,
  StandardResponse,
  ThreadReadDelta,
  PersonalQuotaState,
} from './model';
import { WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { PreferenceStore } from './preference-store.service';
import { isTauri } from './runtime';
import type { FriendRequestProjection } from './friend-request-state';

export type { User } from './model';

export type FederatedResolveResult = {
  user: User;
  relationship: 'NONE' | 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'FRIEND';
};
export type FederatedResolveStage =
  | 'DISCOVERING'
  | 'VERIFYING_IDENTITY'
  | 'CONNECTING'
  | 'WAITING_FOR_PEER'
  | 'FETCHING_USER';

export type FederatedResolveFailure =
  | 'INVALID_ADDRESS'
  | 'DOMAIN_RESOLUTION_FAILED'
  | 'TIMEOUT'
  | 'BLOCKED'
  | 'NOT_FOUND'
  | 'UNREACHABLE'
  | 'UNKNOWN';

type DurableTaskAccepted = {
  taskId: string;
  status: 'PENDING';
};

type RequestRelationshipResponse = StandardResponse<
  Partial<DurableTaskAccepted> & {
    threadId?: number;
    account?: string;
    domain?: string;
  }
>;

export class FederatedResolveError extends Error {
  constructor(readonly reason: FederatedResolveFailure) {
    super(reason);
    this.name = 'FederatedResolveError';
  }
}

export interface ClientIntentUser {
  id: number;
  account: string;
  name: string;
  avatar: string;
  bio: string;
  domain: string;
  profileRev?: number;
}

interface ClientFriendIntentBase {
  key: string;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  peer: ClientIntentUser;
  requestedSort: number;
}

/** Device-facing friend intent. An authored local request always has its server-local conversation
 * shell; a peer-authored request may remain address-only until the backend accepts it. */
export type ClientFriendIntent = ClientFriendIntentBase &
  (
    | {
        direction: 'OUTGOING';
        status: 'REQUESTED';
        localThreadId: number;
      }
    | {
        direction: 'INCOMING';
        status: 'REQUESTED';
        localThreadId: number | null;
      }
    | {
        direction: FriendIntentDirection;
        status: 'ACCEPTED';
        localThreadId: number;
      }
    | {
        direction: FriendIntentDirection;
        status: 'REVOKED';
        localThreadId: number | null;
      }
  );

export interface ClientGroupInviteIntent {
  key: string;
  kind: 'GROUP_INVITE';
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  direction?: FriendIntentDirection;
  threadId: number;
  group: {
    account: string;
    domain: string;
    namespaceId: number;
    isLocal: boolean;
    name: string;
    avatar: string;
    description: string;
    profileRev: number;
  };
}

export type FriendIntentDirection = 'INCOMING' | 'OUTGOING';

type ClientStateBody =
  | Omit<
      ClientFriendIntent,
      | 'key'
      | 'account'
      | 'domain'
      | 'subjectAccount'
      | 'subjectDomain'
      | 'requestedSort'
    >
  | Omit<
      ClientGroupInviteIntent,
      'key' | 'account' | 'domain' | 'subjectAccount' | 'subjectDomain' | 'kind'
    >;

export interface FriendIntentPage {
  items: FriendRequestProjection[];
  scannedThrough: string | null;
  hasMore: boolean;
  total: number;
  actionableTotal: number;
}

export type ClientStateFeedItem =
  | {
      feedId: number;
      account: string;
      domain: string;
      namespaceId: number;
      eventType: 'PROFILE';
      subjectAccount: '';
      subjectDomain: 'local';
      body: {
        profileRev: number;
        displayName: string;
        bio: string;
        avatar: string | null;
      };
    }
  | {
      feedId: number;
      account: string;
      domain: string;
      namespaceId: number;
      eventType: 'RELATIONSHIP_INTENT';
      subjectAccount: string;
      subjectDomain: string;
      body: ClientStateBody;
    }
  | {
      feedId: number;
      account: string;
      domain: string;
      namespaceId: number;
      eventType: 'GROUP_JOIN_REQUEST_HEAD';
      subjectAccount: '';
      subjectDomain: 'local';
      body: {
        threadId: number;
        latestFeedId: number;
        latestRequestAt: number;
        readFeedId: number;
      };
    }
  | {
      feedId: number;
      account: '';
      domain: 'local';
      namespaceId: 0;
      eventType: 'INCOMING_INVITE_HEAD';
      subjectAccount: '';
      subjectDomain: 'local';
      body: {
        readThroughFeedId: number;
      };
    }
  | {
      feedId: number;
      account: string;
      domain: string;
      namespaceId: number;
      eventType: 'GROUP_META_FEED_HEAD';
      subjectAccount: '';
      subjectDomain: 'local';
      body: { groupMetaFeedEndId: string };
    }
  | {
      feedId: number;
      account: '';
      domain: 'local';
      namespaceId: 0;
      eventType: 'THREAD_CONTENT_HEAD';
      subjectAccount: '';
      subjectDomain: 'local';
      body: {
        threadId: number;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
    }
  | {
      feedId: number;
      account: '';
      domain: 'local';
      namespaceId: 0;
      eventType: 'THREAD_BLOCK';
      subjectAccount: string;
      subjectDomain: 'local';
      body: { threadId: number; blocked: boolean };
    };

export interface ClientGroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: Array<{
    feedId: string;
    account: string;
    domain: string;
    namespaceId: number;
    operation: 'UPSERT' | 'DEPART';
    body:
      | {
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          profileRev: number;
          profileMessageSeq?: number | null;
          profileResolved?: boolean;
          displayName: string;
          avatar: string | null;
          bio: string;
        }
      | Record<string, never>;
  }>;
  scannedThrough: string;
  groupMetaFeedEndId: string;
  hasMore: boolean;
}

/** The persisted last-logged-in userId (localStorage) — the client's sole pre-HELLO source of its own
 *  userId (the session token is opaque, server-side-lookup only). Set on establishSession, cleared on
 *  clearSession. Read at boot by {@link UserService.restoreWebdb} so the per-user IDB opens + the
 *  threadlist eager-paints the cached list BEFORE the SSE/HELLO round-trip (instant list for returning
 *  users). Cleared with the other user-scoped keys on logout (see USER_SCOPED_LS_KEYS). */
const LAST_USER_ID_KEY = 'soms.lastUserId';

@Injectable({
  providedIn: 'root',
})
export class UserService {
  /** Fatal startup/open failure (missing or unreadable stable cache, excluding a handled version reset). */
  sessionProfile = signal<User | undefined>(undefined);
  /** The authenticated user's id — sourced from the HELLO connect handshake (the session token is OPAQUE,
   *  server-side-lookup only, so HELLO is the client's sole pre-profile-fetch source of its own userId).
   *  The per-user IDB store opens on this id via {@link establishSession}; it replaces the old coupling
   *  where the webdb opened on the profile fetch's sessionProfile().id (which made the fetch un-skippable).
   *  Other services' session-end effects key off this signal to reset their in-memory caches on logout. */
  readonly sessionUserId = signal<number | null>(null);

  /** The client's applied state-feed cursor — seeded from HELLO and advanced after
   *  each STATE_FEED_UPDATED signal is applied. Lives here so ConversationListService (which injects this
   *  service) can read/advance it without a circular DI. In-memory only — seeded fresh each connect. */
  private readonly _stateFeedCursor = signal<number | undefined>(undefined);
  readonly stateFeedCursor = this._stateFeedCursor.asReadonly();

  /** Latest incoming relationship-request revision discovered through the unified state delta. */
  readonly relationshipRequestStateRevision = signal(0);
  /** Latest relationship-intent revision applied in this renderer. Unlike the incoming-request revision, this
   *  also advances for terminal and outgoing changes so an open request dialog can refresh without
   *  turning those changes into an unread badge. */
  readonly relationshipIntentStateRevision = signal(0);
  /** Account-wide relationship-request read watermark, synchronized through the client state feed. */
  readonly relationshipRequestReadThroughFeedId = signal(0);
  readonly friendReqBadge = computed(
    () =>
      this.relationshipRequestStateRevision() >
      this.relationshipRequestReadThroughFeedId(),
  );
  /** Latest application projection coordinate and read watermark, keyed by group thread. */
  readonly groupJoinRequestHeads = signal<
    ReadonlyMap<number, { latestFeedId: number; readFeedId: number }>
  >(new Map());

  private readonly webdb = inject(WebdbService);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly preferences = inject(PreferenceStore);
  /** The user key whose DB is currently open (or null) — tracks {@link establishSession} / {@link clearSession}. */
  private webdbUserKey: string | null = null;
  /** Set only by a real credential/OTP/QR login. Cold-start restore and reconnect never set it. */
  private freshCachePending = false;

  constructor(private http: HttpClient) {}

  /** Mark the next HELLO-established user partition for drop + clean v1 initialization. */
  prepareFreshCache(): void {
    this.freshCachePending = true;
  }

  /** Tear down the in-memory session (logout / account switch). Clears sessionUserId + sessionProfile →
   *  every DB-layer repository's session-end effect (watching sessionUserId) resets its cache; the per-user
   *  IDB is closed + deleted. Also wipes user-scoped client preferences such as recent emoji. */
  async clearSession(): Promise<void> {
    const prev = this.webdbUserKey;
    const previousUserId = this.sessionProfile()?.id;
    // Keep LAST_USER_ID until the durable cache wipe succeeds. If deletion fails, retaining that key makes
    // the same partition discoverable on retry/restart instead of orphaning undeleted account data.
    if (prev != null) await this.webdb.closeAndDelete(prev);
    await this.clearClientPreferences(previousUserId);
    this.webdbUserKey = null;
    this.freshCachePending = false;
    this.sessionUserId.set(null);
    this.sessionProfile.set(undefined);
    this._stateFeedCursor.set(undefined);
    this.relationshipRequestStateRevision.set(0);
    this.relationshipIntentStateRevision.set(0);
    this.relationshipRequestReadThroughFeedId.set(0);
    this.groupJoinRequestHeads.set(new Map());
    this.profileFetch = undefined;
  }

  /** Establish the session from the HELLO connect handshake — the cold-start / login entry point. Opens
   *  the per-user IDB on `userId` (the webdb-open trigger that previously rode the profile fetch) and
   *  returns once it is open, so the caller (the threadlist) can read IDB without waiting on the profile.
   *  The profile gate ({@link gateSelfProfile}) runs async: if the IDB-cached self profile's `profileRev`
   *  matches HELLO's, the cached profile is fresh and the fetch is skipped; otherwise (first boot / stale)
   *  the full profile is fetched + cached. Friend-request notification state is restored from this device's
   *  per-account database and subsequently advanced by the unified state delta. */
  async establishSession(userId: number, profileRev: number): Promise<void> {
    if (this.freshCachePending) {
      this.freshCachePending = false;
      await this.webdb.recreateForUser(String(userId));
      this.webdbUserKey = null;
    }
    if (this.sessionUserId() === userId) {
      return;
    }
    // Account switch without a logout (defensive): tear down the previous user's DB first.
    if (this.webdbUserKey !== null && this.webdbUserKey !== String(userId)) {
      await this.webdb.closeAndDelete(this.webdbUserKey);
    }
    this.webdbUserKey = String(userId);
    this.sessionUserId.set(userId);
    this.persistLastUserId(userId); // remember for the next boot's eager IDB paint (pre-HELLO)
    try {
      await this.webdb.openExistingForUser(String(userId)); // strict read on the normal path
    } catch {
      // Every local-cache validation/open failure is rebuildable state. The Webdb epoch prevents this
      // recreation from publishing handles if logout/account-switch wins while it is in flight.
      await this.webdb.recreateForUser(String(userId));
    }
    const [latest, requestReadHead, groupHeads, groupReads] = await Promise.all(
      [
        this.webdb.getMeta('relationshipRequestStateRevision'),
        this.webdb.getMeta('relationshipRequestReadHead'),
        this.webdb.getMeta('groupJoinRequestHeads'),
        this.webdb.getMeta('groupJoinRequestReadFeedIds'),
      ],
    );
    this.relationshipRequestStateRevision.set(
      typeof latest === 'number' && latest >= 0 ? latest : 0,
    );
    const readThroughFeedId =
      requestReadHead && typeof requestReadHead === 'object'
        ? (requestReadHead as { readThroughFeedId?: unknown }).readThroughFeedId
        : undefined;
    this.relationshipRequestReadThroughFeedId.set(
      typeof readThroughFeedId === 'number' && readThroughFeedId >= 0
        ? readThroughFeedId
        : 0,
    );
    const heads = this.nonNegativeIntegerRecord(groupHeads);
    const reads = this.nonNegativeIntegerRecord(groupReads);
    this.groupJoinRequestHeads.set(
      new Map(
        Object.entries(heads).map(([threadId, latestFeedId]) => [
          Number(threadId),
          { latestFeedId, readFeedId: reads[threadId] ?? 0 },
        ]),
      ),
    );
    const lastCleanup = await this.webdb.getMeta(
      'relationshipRequestCleanupAt',
    );
    if (
      typeof lastCleanup !== 'number' ||
      Date.now() - lastCleanup >= 86_400_000
    ) {
      void this.webdb
        .cleanupRelationshipRequests()
        .then(() =>
          this.webdb.putMeta('relationshipRequestCleanupAt', Date.now()),
        );
    }
    void this.gateSelfProfile(userId, profileRev);
  }

  /** Gate the /user/my-profile fetch on the IDB-cached profileRev. Cache hit + fresh → skip the fetch;
   *  cache miss (first boot) or stale → fetch + cache the full profile. */
  private async gateSelfProfile(
    userId: number,
    profileRev: number,
  ): Promise<void> {
    const cached = (await this.webdb.getMeta('selfProfile')) as
      | User
      | null
      | undefined;
    if (cached && cached.id === userId && cached.profileRev === profileRev) {
      this.sessionProfile.set(cached);
      return;
    }
    try {
      const res = await firstValueFrom(this.getMyProfile());
      if (res.code === 0 && res.data) {
        const u = res.data;
        this.sessionProfile.set(u);
        void this.webdb.putMeta('selfProfile', u);
        // Write-through the partial profile too → avatar-refresh signal on a path change.
        void this.profileRepo.putProfile(`u${u.id}`, 'user', {
          id: u.id,
          name: u.name,
          account: u.account,
          avatar: u.avatar,
          bio: u.bio,
          domain: u.domain,
          sourceServer: u.domain,
          namespaceId: u.namespaceId,
          profileRev: u.profileRev,
        });
      }
    } catch {
      /* best-effort — sessionProfile stays undefined; the UI holds a placeholder until a retry */
    }
  }

  /** Publish a relationship-request revision after the state delta and its cursor committed atomically. */
  applyRelationshipRequestStateRevision(revision: number): void {
    if (revision > this.relationshipRequestStateRevision())
      this.relationshipRequestStateRevision.set(revision);
  }

  /** Publish any relationship-intent change after its state delta has committed locally. */
  applyRelationshipIntentStateRevision(revision: number): void {
    if (revision > this.relationshipIntentStateRevision())
      this.relationshipIntentStateRevision.set(revision);
  }

  /** Advance the account-wide read watermark to the state feed already applied by this client. */
  markRelationshipRequestsRead(): void {
    const readThroughFeedId = this.stateFeedCursor();
    if (
      readThroughFeedId === undefined ||
      readThroughFeedId <= this.relationshipRequestReadThroughFeedId()
    )
      return;
    this.http
      .post<
        StandardResponse<{ readThroughFeedId: number }>
      >(`${apiPrefix()}/relationship/requests/read`, { readThroughFeedId })
      .subscribe({
        next: (res) => {
          if (res.code === 0 && res.data)
            this.applyRelationshipRequestReadHead(res.data.readThroughFeedId);
        },
        error: (error) =>
          console.error(
            '[relationship] failed to mark incoming requests read',
            error,
          ),
      });
  }

  applyRelationshipRequestReadHead(readThroughFeedId: number): void {
    if (readThroughFeedId > this.relationshipRequestReadThroughFeedId())
      this.relationshipRequestReadThroughFeedId.set(readThroughFeedId);
  }

  applyGroupJoinRequestHead(
    threadId: number,
    latestFeedId: number,
    serverReadFeedId: number,
  ): boolean {
    if (latestFeedId < 1) return false;
    const previous = this.groupJoinRequestHeads().get(threadId);
    // The panel advances readFeedId optimistically. The server then republishes the compacted head with
    // the same latestFeedId; that acknowledgement is not new attention and must not move the thread.
    const hasNewUnread = latestFeedId > (previous?.readFeedId ?? 0);
    this.groupJoinRequestHeads.update((current) => {
      const previous = current.get(threadId);
      const nextLatest = Math.max(previous?.latestFeedId ?? 0, latestFeedId);
      const nextRead = Math.max(previous?.readFeedId ?? 0, serverReadFeedId);
      if (
        previous?.latestFeedId === nextLatest &&
        previous.readFeedId === nextRead
      )
        return current;
      const next = new Map(current);
      next.set(threadId, {
        latestFeedId: nextLatest,
        readFeedId: nextRead,
      });
      return next;
    });
    const heads = Object.fromEntries(
      [...this.groupJoinRequestHeads()].map(([id, value]) => [
        String(id),
        value.latestFeedId,
      ]),
    );
    void this.webdb.putMeta('groupJoinRequestHeads', heads);
    return hasNewUnread;
  }

  markGroupJoinRequestsRead(threadId: number): void {
    const current = this.groupJoinRequestHeads().get(threadId);
    if (!current || current.readFeedId >= current.latestFeedId) return;
    const next = new Map(this.groupJoinRequestHeads());
    next.set(threadId, {
      ...current,
      readFeedId: current.latestFeedId,
    });
    this.groupJoinRequestHeads.set(next);
    const reads = Object.fromEntries(
      [...next].map(([id, value]) => [String(id), value.readFeedId]),
    );
    void this.webdb.putMeta('groupJoinRequestReadFeedIds', reads);
  }

  /** Drop manager-only join-request attention after member state removes this user's manager role. */
  clearGroupJoinRequestHead(threadId: number): void {
    if (!this.groupJoinRequestHeads().has(threadId)) return;
    const next = new Map(this.groupJoinRequestHeads());
    next.delete(threadId);
    this.groupJoinRequestHeads.set(next);
    void this.webdb.putMeta(
      'groupJoinRequestHeads',
      Object.fromEntries(
        [...next].map(([id, value]) => [String(id), value.latestFeedId]),
      ),
    );
    void this.webdb.putMeta(
      'groupJoinRequestReadFeedIds',
      Object.fromEntries(
        [...next].map(([id, value]) => [String(id), value.readFeedId]),
      ),
    );
  }

  private nonNegativeIntegerRecord(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0,
      ),
    );
  }

  applyStateProfile(u: User): void {
    if (u.id === this.sessionUserId()) {
      const current = this.sessionProfile();
      if (!current || u.profileRev >= current.profileRev) {
        this.sessionProfile.set(u);
        void this.webdb.putMeta('selfProfile', u);
      }
    }
    void this.profileRepo.putProfile(`u${u.id}`, 'user', {
      id: u.id,
      name: u.name,
      account: u.account,
      avatar: u.avatar,
      bio: u.bio,
      domain: u.domain,
      sourceServer: u.domain,
      namespaceId: u.namespaceId,
      profileRev: u.profileRev,
    });
  }

  /** Boot-time webdb restore on the persisted {@link LAST_USER_ID_KEY} — opens the per-user IDB and restores
   *  its cached self profile so the threadlist plus self name/avatar can eager-paint BEFORE the SSE/HELLO
   *  round-trip (including an offline cold start). Does NOT set sessionUserId — the session tracker stays
   *  HELLO-driven; {@link establishSession} reconciles on HELLO (idempotent `openForUser` reuse for the same
   *  user, close+reopen on a switch). No-op when no userId was ever persisted (first-ever launch). */
  async restoreWebdb(): Promise<void> {
    const userId = await this.readLastUserId();
    if (userId === null) return;
    // Track the open user so clearSession can close it (a pre-HELLO logout) + establishSession can detect
    // a token-swap (close+reopen when HELLO's userId differs from the optimistic lastUserId).
    this.webdbUserKey = String(userId);
    try {
      await this.webdb.openExistingForUser(String(userId));
    } catch {
      await this.webdb.recreateForUser(String(userId));
    }
    const cached = (await this.webdb.getMeta('selfProfile')) as
      | User
      | null
      | undefined;
    // Validate the partition owner defensively before exposing cached identity data to the UI.
    if (cached?.id === userId) this.sessionProfile.set(cached);
  }

  /** Read the persisted last-logged-in userId, or null when absent / unparseable / storage unavailable. */
  private async readLastUserId(): Promise<number | null> {
    const raw = await this.preferences.get<number>('device', LAST_USER_ID_KEY);
    if (raw == null) return null;
    const userId = Number(raw);
    return Number.isFinite(userId) && userId > 0 ? userId : null;
  }

  /** Persist the userId so the next boot's restoreWebdb can open the per-user IDB pre-HELLO. SSR-safe. */
  private persistLastUserId(userId: number): void {
    void this.preferences
      .set('device', LAST_USER_ID_KEY, userId)
      .catch(() => {});
  }

  private async clearClientPreferences(userId?: number): Promise<void> {
    await Promise.all([
      this.preferences.remove('device', LAST_USER_ID_KEY),
      ...(userId == null
        ? []
        : [
            this.preferences.remove(
              `account:${userId}`,
              'soms.chat.emojiRecents',
            ),
          ]),
    ]).catch(() => {});
  }

  /** In-flight profile fetch (dedup): boot calls updateSessionProfile() AND ConversationListService
   *  calls ensureProfile() in the same init batch — without sharing, both would fire /user/my-profile.
   *  Cached here (shareReplay) so concurrent callers ride one HTTP request; once it resolves,
   *  sessionProfile is set and late callers take the short-circuit branch. `force:true` bypasses the
   *  cache (reconnect always re-fetches). */
  private profileFetch?: Observable<User>;

  /** Idempotent self-profile get-or-load: returns the cached sessionProfile if already loaded (set by
   *  {@link establishSession} from HELLO, or a prior fetch), else fetches /user/my-profile. `force:true`
   *  re-fetches for live refresh (the friend-request state delta and post-edit re-read).
   *  The state-feed cursor is NOT seeded here — HELLO owns the sole feed-end source now. */
  ensureProfile(opts?: { force?: boolean }): Observable<User> {
    if (!opts?.force && this.sessionProfile() !== undefined) {
      return of(this.sessionProfile() as User);
    }
    if (!opts?.force && this.profileFetch) {
      return this.profileFetch;
    }
    const fetch = this.getMyProfile().pipe(
      map((res) => {
        const u = res.data as User;
        this.sessionProfile.set(u);
        // Cache the full self profile so the next cold start's HELLO gating can skip this fetch.
        void this.webdb.putMeta('selfProfile', u);
        // Write-through the partial profile → IDB + trigger avatar refresh when the path changed.
        void this.profileRepo.putProfile(`u${u.id}`, 'user', {
          id: u.id,
          name: u.name,
          account: u.account,
          avatar: u.avatar,
          bio: u.bio,
          domain: u.domain,
          sourceServer: u.domain,
          namespaceId: u.namespaceId,
          profileRev: u.profileRev,
        });
        return u;
      }),
      shareReplay(1),
    );
    if (!opts?.force) this.profileFetch = fetch;
    return fetch;
  }

  /** Fire-and-forget profile refresh — ALWAYS hits the network (`force: true`), because every caller
   *  wants FRESH data: friend-request badge arming, the post-avatar / post-name-bio edit
   *  re-read. A non-force call would short-circuit on the
   *  already-set sessionProfile (`ensureProfile` returns `of(cached)`) and serve stale data — which is
   *  why a live friend request didn't surface the badge, and an avatar/name edit didn't refresh the
   *  rail/drawer, until a full reload. Use ensureProfile() (no force) for the idempotent get-or-load at
   *  boot. stateFeedEndId is unchanged by all these triggers, so re-seeding the cursor is a no-op. */
  updateSessionProfile() {
    this.ensureProfile({ force: true }).subscribe({
      error: (err) => {
        console.error(err);
      },
    });
  }

  /** Seed the durable client state-feed cursor. */
  seedStateFeedCursor(feedId: number): void {
    this._stateFeedCursor.set(feedId);
  }

  /** Advance the cursor after applying a delta (monotonic — ignore a non-advancing/stale revision). */
  advanceStateFeedCursor(feedId: number): void {
    const cur = this._stateFeedCursor();
    if (cur === undefined || feedId > cur) this._stateFeedCursor.set(feedId);
  }

  register(params: { account: string; name: string; password: string }) {
    return this.http.post<{
      code: number;
      message: string;
      data?: { id: number; account: string };
    }>(`${apiPrefix()}/user/register`, params);
  }

  getMyProfile() {
    return this.http.post<StandardResponse<User>>(
      `${apiPrefix()}/user/my-profile`,
      {},
    );
  }

  getMyQuota() {
    return this.http.post<StandardResponse<PersonalQuotaState>>(
      `${apiPrefix()}/user/my-quota`,
      {},
    );
  }

  /** Create one complete profile revision. */
  updateProfile(params: {
    name: string;
    bio: string;
    avatarBase64?: string | null;
  }) {
    return this.http.post<StandardResponse<User>>(
      `${apiPrefix()}/user/update-profile`,
      params,
    );
  }

  startProfileResolution(
    selector:
      | { account: string; domain: string; rev: number }
      | { threadId: number; messageSeq: number }
      | { threadId: number; memberAccount: string; memberDomain: string },
  ) {
    return this.http.post<
      StandardResponse<
        | {
            status: 'READY';
            profile: {
              account: string;
              domain: string;
              rev: number;
              name: string;
              bio: string;
              avatarBase64: string | null;
            };
          }
        | { status: 'PENDING'; requestId: string }
      >
    >(`${apiPrefix()}/user/profile-resolution`, selector);
  }

  /** Read compacted client-state projections in one fixed feed-id range. */
  queryStateFeed(params: {
    mode: 'full' | 'delta';
    after: number;
    take?: number;
    through?: number;
  }) {
    const query = new URLSearchParams({
      after: String(params.after),
      take: String(params.take ?? 100),
      mode: params.mode,
    });
    if (params.through !== undefined)
      query.set('through', String(params.through));
    return this.http.get<
      StandardResponse<{
        mode: 'full' | 'delta';
        items: ClientStateFeedItem[];
        scannedThrough: number;
        stateFeedEndId: number;
        hasMore: boolean;
      }>
    >(`${apiPrefix()}/user/state-feed?${query.toString()}`);
  }

  queryGroupMeta(params: {
    threadId: number;
    mode: 'full' | 'delta';
    after: string;
    take?: number;
    through?: string;
  }) {
    const query = new URLSearchParams({
      threadId: String(params.threadId),
      mode: params.mode,
      after: params.after,
      take: String(params.take ?? 100),
    });
    if (params.through !== undefined) query.set('through', params.through);
    return this.http.get<StandardResponse<ClientGroupMetaFeedPage>>(
      `${apiPrefix()}/user/group-meta?${query.toString()}`,
    );
  }

  queryUserInfo(params: { userIds: number[] }) {
    return this.http.post<StandardResponse<User[]>>(
      `${apiPrefix()}/user/query`,
      params,
    );
  }

  /** Resolve a local account (an explicitly supplied own-domain value is also local). Federated exact
   * lookup must use resolveFederatedUser so it remains a temporary SSE and cannot create a stub. */
  resolveUser(params: { account: string; domain?: string }) {
    return this.http.post<StandardResponse<User>>(
      `${apiPrefix()}/user/resolve`,
      params,
    );
  }

  /** One-shot temporary SSE used only for federated exact resolve. Unsubscribing closes the stream;
   * the server emits exactly one resolved/failed terminal and never creates a User stub. */
  resolveFederatedUser(
    params: { account: string; domain: string },
    onProgress?: (stage: FederatedResolveStage) => void,
  ): Observable<FederatedResolveResult> {
    const query = new URLSearchParams(params);
    // HttpClient is intentional: browser requests use the httpOnly cookie and
    // TauriHttpBackend routes native requests through Rust, which injects its
    // in-memory Bearer. The response is terminal and server-closed, so native
    // may safely deliver the complete SSE body as one IPC response.
    if (isTauri())
      return this.http
        .get(
          `${apiPrefix()}/user/resolve-federated-stream?${query.toString()}`,
          {
            responseType: 'text',
            headers: { Accept: 'text/event-stream' },
          },
        )
        .pipe(
          map((text) => {
            for (const frame of text.split(/\r?\n\r?\n/)) {
              const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
              const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
              if (!event || !data) continue;
              if (event === 'progress') {
                onProgress?.(
                  (JSON.parse(data) as { stage: FederatedResolveStage }).stage,
                );
              }
              if (event === 'resolved')
                return JSON.parse(data) as FederatedResolveResult;
              if (event === 'failed')
                throw new FederatedResolveError(
                  (JSON.parse(data) as { reason?: FederatedResolveFailure })
                    .reason ?? 'UNKNOWN',
                );
            }
            throw new Error('resolve stream ended without a terminal event');
          }),
        );

    return new Observable<FederatedResolveResult>((subscriber) => {
      const aborter = new AbortController();
      void (async () => {
        const response = await fetch(
          `${apiPrefix()}/user/resolve-federated-stream?${query.toString()}`,
          {
            signal: aborter.signal,
            headers: { Accept: 'text/event-stream' },
            cache: 'no-store',
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(`federated resolve failed: HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
            const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
            if (!event || !data) continue;
            if (event === 'progress') {
              onProgress?.(
                (JSON.parse(data) as { stage: FederatedResolveStage }).stage,
              );
            } else if (event === 'resolved') {
              subscriber.next(JSON.parse(data) as FederatedResolveResult);
              subscriber.complete();
              return;
            } else if (event === 'failed') {
              throw new FederatedResolveError(
                (JSON.parse(data) as { reason?: FederatedResolveFailure })
                  .reason ?? 'UNKNOWN',
              );
            }
          }
        }
        throw new Error('resolve stream ended without a terminal event');
      })().catch((error: unknown) => {
        if (!aborter.signal.aborted) subscriber.error(error);
      });
      return () => aborter.abort();
    });
  }

  /** Local user discovery (fuzzy over account OR display name, case-insensitive). Returns up to 20
   *  LOCAL matches (server excludes federated stubs + soft-deleted; min query length 2). Federated
   *  users are NOT discoverable here — resolve those by exact account + domain via resolveUser. */
  searchUsers(params: { q: string; skip?: number; take?: number }) {
    return this.http.post<StandardResponse<{ list: User[]; total: number }>>(
      `${apiPrefix()}/user/search`,
      params,
    );
  }

  /** Author a relationship request toward one exact user or group Address. */
  requestRelationship(params: {
    account: string;
    domain: string;
    displayName?: string;
    avatar?: string;
    note?: string;
  }) {
    return this.http.post<RequestRelationshipResponse>(
      `${apiPrefix()}/relationship/request`,
      params,
    );
  }

  /** Relationship state from synchronized local projections: an active P2P thread owns FRIEND, while
   * the request-intent projection owns pending directions. No relationship network request is needed. */
  async localRelationship(user: Pick<User, 'id' | 'account' | 'domain'>) {
    const threads = await this.webdb.getThreads();
    const friendship = threads.some(
      (item) =>
        item.type === 'P2P' &&
        item.friendshipActive !== false &&
        (item.peerUser.id === user.id ||
          (item.peerUser.account === user.account &&
            item.peerUser.domain === (user.domain || 'local'))),
    );
    if (friendship) return 'FRIEND' as const;
    const matches = (item: FriendRequestProjection) =>
      item.kind === 'FRIEND' &&
      item.status === 'REQUESTED' &&
      item.expiresAt > Date.now() &&
      (item.peer?.id === user.id ||
        (item.peer?.account === user.account &&
          item.peer.domain === (user.domain || 'local')));
    const [incoming, outgoing] = await Promise.all([
      this.listLocalFriendRequests('INCOMING', null, 200),
      this.listLocalFriendRequests('OUTGOING', null, 200),
    ]);
    if (outgoing.items.some(matches)) return 'OUTGOING_PENDING' as const;
    if (incoming.items.some(matches)) return 'INCOMING_PENDING' as const;
    return 'NONE' as const;
  }

  /** Reads the durable request projection produced by the local intent-pair state machine. */
  async listLocalFriendRequests(
    direction: FriendIntentDirection,
    cursor: string | null = null,
    take = 20,
  ): Promise<FriendIntentPage> {
    const me = this.sessionUserId();
    if (me === null)
      return {
        items: [],
        scannedThrough: null,
        hasMore: false,
        total: 0,
        actionableTotal: 0,
      };
    await this.webdb.cleanupRelationshipRequests();
    const localPage = await this.webdb.getRelationshipRequestPage(
      direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
      cursor,
      take + 1,
    );
    const items = localPage.items.slice(0, take);
    const hasMore = localPage.items.length > take;
    const tail = items.at(-1);
    return {
      items,
      scannedThrough: tail
        ? JSON.stringify([tail.requestedSort, tail.key])
        : cursor,
      hasMore,
      total: localPage.total,
      actionableTotal: localPage.actionableTotal,
    };
  }

  /** Accept a stored user relationship request or group invitation. */
  acceptRelationship(params: { account: string; domain: string }) {
    return this.http.post<
      StandardResponse<Partial<DurableTaskAccepted> & { threadId?: number }>
    >(`${apiPrefix()}/relationship/accept`, params);
  }

  markRelationshipRequestAccepted(key: string): Promise<void> {
    return this.webdb.markRelationshipRequestAccepted(key);
  }

  joinGroupRequest(params: { groupId: number }) {
    return this.http.post<StandardResponse<DurableTaskAccepted>>(
      `${apiPrefix()}/group/join-request`,
      params,
    );
  }

  /** Revoke the current user relationship or pending request toward one exact Address. */
  revokeRelationship(params: { account: string; domain: string }) {
    return this.http.post<StandardResponse<DurableTaskAccepted>>(
      `${apiPrefix()}/relationship/revoke`,
      params,
    );
  }

  /** Commit the viewport's local read HWM. SSE wakes the client to pull the compacted attention feed. */
  markRead(params: { threadId: number; localReadHwm: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/mark-read`,
      params,
    );
  }

  queryReadDelta(params: { fromRevision: number; toRevision: number }) {
    return this.http.post<StandardResponse<ThreadReadDelta>>(
      `${apiPrefix()}/thread/read-delta`,
      params,
    );
  }
}

/** Return the one canonical avatar resource without deriving local variants. */
export function avatarUrl(base: string | undefined | null): string {
  return base ?? '';
}

/**
 * localStorage keys holding USER-SCOPED client-only data (no server copy) — cleared on logout so a
 * second account on the same browser never sees the previous one's emoji recents. This mirrors
 * the IDB purge-on-logout (the per-user DB is closed + deleted): local cache is wiped, rebuilt from
 * scratch on the next login. NOTE these are client-only — clearing is permanent (even for the same user
 * re-logging in), which is the chosen trade-off for account isolation.
 *
 * Deliberately NOT cleared (device-level preferences, shared across accounts on this browser): theme,
 * language, the desktop list-pane width, the media-size threshold, `device_id`, and `is_keep_login`.
 */
