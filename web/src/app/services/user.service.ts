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
  domain: string;
  isForeigner: boolean;
}

export interface ClientFriendIntent {
  key: string;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  inviteId?: string;
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  direction: FriendIntentDirection;
  /** Server-local conversation id for device state only. Never appears on the federation wire. */
  localThreadId: number | null;
  peer: ClientIntentUser;
  requestedSort: number;
}

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
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
  actionableTotal: number;
}

export type ClientStateFeedItem =
  | {
      feedId: number;
      account: string;
      domain: string;
      eventType: 'PROFILE';
      subjectAccount: '';
      subjectDomain: '';
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
      eventType: 'RELATIONSHIP_INTENT';
      subjectAccount: string;
      subjectDomain: string;
      body: ClientStateBody;
    }
  | {
      feedId: number;
      account: string;
      domain: string;
      eventType: 'GROUP_JOIN_REQUEST_HEAD';
      subjectAccount: '';
      subjectDomain: '';
      body: {
        threadId: number;
        before: string;
        latestRequestAt: number;
        readRequestId: string;
      };
    }
  | {
      feedId: number;
      account: '';
      domain: '';
      eventType: 'INCOMING_INVITE_HEAD';
      subjectAccount: '';
      subjectDomain: '';
      body: {
        readThroughFeedId: number;
      };
    }
  | {
      feedId: number;
      account: string;
      domain: string;
      eventType: 'GROUP_META_FEED_HEAD';
      subjectAccount: '';
      subjectDomain: '';
      body: { groupMetaFeedEndId: string };
    }
  | {
      feedId: number;
      account: '';
      domain: '';
      eventType: 'THREAD_BLOCK';
      subjectAccount: string;
      subjectDomain: '';
      body: { threadId: number; blocked: boolean };
    };

export interface ClientGroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: Array<{
    feedId: string;
    account: string;
    domain: string;
    rev: number;
    operation: 'UPSERT' | 'DELETE';
    body:
      | {
          userId: number;
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          profileRev: number;
          displayName: string;
          avatar: string | null;
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

  /** Latest incoming friend-request state revision discovered through the unified state delta. */
  readonly friendRequestStateRevision = signal(0);
  /** Latest friend-intent revision applied in this renderer. Unlike the incoming-request revision, this
   *  also advances for terminal and outgoing changes so an open request dialog can refresh without
   *  turning those changes into an unread badge. */
  readonly friendIntentStateRevision = signal(0);
  /** Account-wide incoming-invitation read watermark, synchronized through the client state feed. */
  readonly incomingInviteReadThroughFeedId = signal(0);
  readonly friendReqBadge = computed(
    () =>
      this.friendRequestStateRevision() >
      this.incomingInviteReadThroughFeedId(),
  );
  /** Latest application id and device-local read watermark, keyed by group thread. */
  readonly groupJoinRequestHeads = signal<
    ReadonlyMap<number, { latestRequestId: string; readRequestId: string }>
  >(new Map());

  private readonly webdb = inject(WebdbService);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly preferences = inject(PreferenceStore);
  /** The user key whose DB is currently open (or null) — tracks {@link establishSession} / {@link clearSession}. */
  private webdbUserKey: string | null = null;
  /** Set only by a real credential/OTP/QR login. Cold-start restore and reconnect never set it. */
  private freshCachePending = false;
  private readonly pendingProfileFetches = new Set<string>();

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
    this.friendRequestStateRevision.set(0);
    this.friendIntentStateRevision.set(0);
    this.incomingInviteReadThroughFeedId.set(0);
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
    const [latest, inviteHead, groupHeads, groupReads] = await Promise.all([
      this.webdb.getMeta('friendRequestStateRevision'),
      this.webdb.getMeta('incomingInviteHead'),
      this.webdb.getMeta('groupJoinRequestHeads'),
      this.webdb.getMeta('groupJoinRequestReadFeedIds'),
    ]);
    this.friendRequestStateRevision.set(
      typeof latest === 'number' && latest >= 0 ? latest : 0,
    );
    const readThroughFeedId =
      inviteHead && typeof inviteHead === 'object'
        ? (inviteHead as { readThroughFeedId?: unknown }).readThroughFeedId
        : undefined;
    this.incomingInviteReadThroughFeedId.set(
      typeof readThroughFeedId === 'number' && readThroughFeedId >= 0
        ? readThroughFeedId
        : 0,
    );
    const heads = this.integerStringRecord(groupHeads);
    const reads = this.integerStringRecord(groupReads);
    this.groupJoinRequestHeads.set(
      new Map(
        Object.entries(heads).map(([threadId, latestId]) => [
          Number(threadId),
          { latestRequestId: latestId, readRequestId: reads[threadId] ?? '0' },
        ]),
      ),
    );
    const lastCleanup = await this.webdb.getMeta('friendRequestCleanupAt');
    if (
      typeof lastCleanup !== 'number' ||
      Date.now() - lastCleanup >= 86_400_000
    ) {
      void this.webdb
        .cleanupFriendRequests()
        .then(() => this.webdb.putMeta('friendRequestCleanupAt', Date.now()));
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
          avatar: u.avatar,
          bio: u.bio,
          domain: u.domain,
          profileRev: u.profileRev,
        });
      }
    } catch {
      /* best-effort — sessionProfile stays undefined; the UI holds a placeholder until a retry */
    }
  }

  /** Publish a friend-request revision after the state delta and its cursor committed atomically. */
  applyFriendRequestStateRevision(revision: number): void {
    if (revision > this.friendRequestStateRevision())
      this.friendRequestStateRevision.set(revision);
  }

  /** Publish any friend-intent change after its state delta has committed to the local database. */
  applyFriendIntentStateRevision(revision: number): void {
    if (revision > this.friendIntentStateRevision())
      this.friendIntentStateRevision.set(revision);
  }

  /** Advance the account-wide read watermark to the state feed already applied by this client. */
  markFriendReqRead(): void {
    const readThroughFeedId = this.stateFeedCursor();
    if (
      readThroughFeedId === undefined ||
      readThroughFeedId <= this.incomingInviteReadThroughFeedId()
    )
      return;
    this.http
      .post<StandardResponse<{ readThroughFeedId: number }>>(
        `${apiPrefix()}/invite/incoming/read`,
        { readThroughFeedId },
      )
      .subscribe({
        next: (res) => {
          if (res.code === 0 && res.data)
            this.applyIncomingInviteReadHead(res.data.readThroughFeedId);
        },
        error: (error) =>
          console.error('[invite] failed to mark incoming requests read', error),
      });
  }

  applyIncomingInviteReadHead(readThroughFeedId: number): void {
    if (readThroughFeedId > this.incomingInviteReadThroughFeedId())
      this.incomingInviteReadThroughFeedId.set(readThroughFeedId);
  }

  applyGroupJoinRequestHead(
    threadId: number,
    before: string,
    serverReadRequestId: string,
  ): void {
    const latestId = (BigInt(before) - 1n).toString();
    if (BigInt(latestId) < 1n) return;
    this.groupJoinRequestHeads.update((current) => {
      const previous = current.get(threadId);
      const nextLatest =
        previous && BigInt(previous.latestRequestId) > BigInt(latestId)
          ? previous.latestRequestId
          : latestId;
      const nextRead =
        previous && BigInt(previous.readRequestId) > BigInt(serverReadRequestId)
          ? previous.readRequestId
          : serverReadRequestId;
      if (
        previous?.latestRequestId === nextLatest &&
        previous.readRequestId === nextRead
      )
        return current;
      const next = new Map(current);
      next.set(threadId, {
        latestRequestId: nextLatest,
        readRequestId: nextRead,
      });
      return next;
    });
    const heads = Object.fromEntries(
      [...this.groupJoinRequestHeads()].map(([id, value]) => [
        String(id),
        value.latestRequestId,
      ]),
    );
    void this.webdb.putMeta('groupJoinRequestHeads', heads);
  }

  markGroupJoinRequestsRead(threadId: number): void {
    const current = this.groupJoinRequestHeads().get(threadId);
    if (
      !current ||
      BigInt(current.readRequestId) >= BigInt(current.latestRequestId)
    )
      return;
    const next = new Map(this.groupJoinRequestHeads());
    next.set(threadId, {
      ...current,
      readRequestId: current.latestRequestId,
    });
    this.groupJoinRequestHeads.set(next);
    const reads = Object.fromEntries(
      [...next].map(([id, value]) => [String(id), value.readRequestId]),
    );
    void this.webdb.putMeta('groupJoinRequestReadFeedIds', reads);
  }

  private integerStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, String(entry)] as const)
        .filter(([, entry]) => /^\d+$/.test(entry)),
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
      avatar: u.avatar,
      bio: u.bio,
      domain: u.domain,
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
          avatar: u.avatar,
          bio: u.bio,
          domain: u.domain,
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

  /** Upload and bind the current user's avatar (multipart file → backend rewrites multiple sizes with
   *  sharp). Call updateSessionProfile() afterwards to refresh the local copy. */
  updateAvatar(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return this.http.post<StandardResponse<{ avatar: string }>>(
      `${apiPrefix()}/user/update-avatar`,
      fd,
    );
  }

  /** Update the current user's display name / bio. Call updateSessionProfile() afterwards to refresh the
   *  local copy. */
  updateProfile(params: { name?: string; bio?: string }) {
    return this.http.post<StandardResponse<User>>(
      `${apiPrefix()}/user/update-profile`,
      params,
    );
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

  /** Pre-flight trust check for a federated handle search: has mutual trust with this peer domain been
   *  established already? Drives the first-contact "Connecting to {domain}…" affordance — shown only
   *  when the server reports the domain untrusted (a handshake IS expected during the resolve), never
   *  guessed from latency. Cheap local allow-list lookup server-side (no network). */
  peerTrustStatus(params: { domain: string }) {
    return this.http.post<StandardResponse<{ trusted: boolean }>>(
      `${apiPrefix()}/user/peer-trust-status`,
      params,
    );
  }

  /** Send a friend invite. Federated targets are delivered via S2S automatically. On auto-accept (the
   *  target already invited me back, local-only) data carries threadId instead of inviteId. */
  sendFriendInvite(params: { toUserId: number; note?: string }) {
    return this.http.post<
      StandardResponse<{ inviteId?: string; threadId?: number }>
    >(`${apiPrefix()}/invite/friend`, params);
  }

  sendFederatedFriendInvite(params: {
    account: string;
    domain: string;
    displayName?: string;
    avatar?: string;
    note?: string;
  }) {
    return this.http.post<
      StandardResponse<{ inviteId?: string; threadId?: number }>
    >(`${apiPrefix()}/invite/federated-friend`, params);
  }

  /** Authoritative relationship/invite state for discovery rows. Server-backed so refreshes and other
   *  devices see the same state; accepts a batch to avoid one request per search result. */
  friendRelationshipStatuses(params: { userIds: number[] }) {
    return this.http.post<
      StandardResponse<
        Array<{
          userId: number;
          status: 'NONE' | 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'FRIEND';
          inviteId?: string;
        }>
      >
    >(`${apiPrefix()}/invite/friend-status`, params);
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
        nextCursor: null,
        hasMore: false,
        total: 0,
        actionableTotal: 0,
      };
    await this.webdb.cleanupFriendRequests();
    const localPage = await this.webdb.getFriendRequestPage(
      direction,
      cursor,
      take + 1,
      direction === 'OUTGOING',
    );
    const items = localPage.items.slice(0, take);
    for (const item of items)
      if (
        item.kind === 'FRIEND' &&
        item.direction === 'OUTGOING' &&
        item.peer &&
        item.expiresAt !== null
      )
        void this.ensurePendingFriendProfile(item.peer, item.expiresAt);
    const hasMore = localPage.items.length > take;
    const tail = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && tail ? JSON.stringify([tail.requestedSort, tail.key]) : null,
      hasMore,
      total: localPage.total,
      actionableTotal: localPage.actionableTotal,
    };
  }

  private async ensurePendingFriendProfile(
    peer: ClientIntentUser,
    expiresAt: number,
  ): Promise<void> {
    if (!peer.isForeigner || !peer.domain || !peer.account) return;
    const identity = `pending:${peer.domain}\u0000${peer.account}`;
    if (await this.webdb.getProfile(identity)) return;
    if (this.pendingProfileFetches.has(identity)) return;
    this.pendingProfileFetches.add(identity);
    try {
      const resolved = await firstValueFrom(
        this.resolveFederatedUser({
          account: peer.account,
          domain: peer.domain,
        }),
      );
      await this.webdb.putProfile({
        identity,
        id: 0,
        kind: 'user',
        name: resolved.user.name || peer.account,
        account: peer.account,
        avatar: resolved.user.avatar,
        bio: resolved.user.bio ?? '',
        domain: peer.domain,
        profileRev: resolved.user.profileRev,
        source: 'OUTGOING_FRIEND_REQUEST',
        expiresAt,
      });
    } catch {
      // The default card remains usable; a later panel open may retry.
    } finally {
      this.pendingProfileFetches.delete(identity);
    }
  }

  /** Accept an invite by id (friend → P2P thread; group → join). data carries the threadId. */
  acceptInvite(
    params: { inviteId: string } | { account: string; domain: string },
  ) {
    return this.http.post<StandardResponse<{ threadId?: number }>>(
      `${apiPrefix()}/invite/accept`,
      params,
    );
  }

  markFriendRequestAccepted(key: string): Promise<void> {
    return this.webdb.markFriendRequestAccepted(key);
  }

  joinGroupRequest(params: { groupId: number }) {
    return this.http.post<StandardResponse<void>>(
      `${apiPrefix()}/group/join-request`,
      params,
    );
  }

  /** Revoke my own outgoing invite by id. */
  revokeInvite(
    params: { inviteId: string } | { account: string; domain: string },
  ) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/invite/revoke`,
      params,
    );
  }

  rejectInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/invite/reject`,
      params,
    );
  }

  /**
   * Unfriend an approved P2P relationship. The established thread remains visible as read-only
   * history unless the caller explicitly requests local data deletion.
   */
  deleteFriend(params: { userId: number; deleteData?: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/user/delete-friend`,
      params,
    );
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<
      StandardResponse<
        Omit<ConversationItem, 'lastReadSeq' | 'unreadCount' | 'mentionUnread'>
      >
    >(`${apiPrefix()}/user/thread-info`, params);
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

/** Avatar edge sizes (aligned with the backend UploadService.AVATAR_SIZES). */
const AVATAR_SIZES = [32, 64, 128, 256, 512] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

/**
 * Derive a multi-size avatar URL: swap the representative URL (/uploads/<base>-512.webp) for the requested
 * size. Returns the input unchanged when base is empty or not a local multi-size image (regex miss), so a
 * default avatar can fall through.
 */
export function avatarUrl(
  base: string | undefined | null,
  size: AvatarSize,
): string {
  return base && AVATAR_SIZES.includes(size)
    ? base.replace(/-\d+\.webp$/, `-${size}.webp`)
    : (base ?? '');
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
