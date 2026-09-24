import type { RequestRevocationStatus } from '../../../../shared/request-projection-status';
import type { ThreadStateSnapshot } from '../../../../shared/thread-state';
import {
  Injectable,
  InjectionToken,
  signal,
  computed,
  inject,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  Observable,
  of,
  map,
  switchMap,
  shareReplay,
  firstValueFrom,
} from 'rxjs';
import { apiPrefix } from './constants';
import {
  User,
  ConversationItem,
  StandardResponse,
  PersonalQuotaState,
} from './model';
import { WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { PreferenceStore } from './preference-store.service';
import { isTauri, tauriInvoke } from './runtime';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { FriendRequestProjection } from './friend-request-state';

export type { User } from './model';

export type FederatedResolveResult = {
  user: User;
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

type RelationshipIntentApplied = {
  status: 'OK';
  threadId?: number;
};

type RelationshipBusinessRejection = {
  status: 'REJECTED';
  reason: string;
  threadId?: never;
};

type MembershipIntentApplied =
  | { status: 'APPLIED' }
  | { status: 'NO_OP'; reason: string };

type ThreadReadPositionResult =
  | { status: 'APPLIED'; lastReadSeq: number }
  | { status: 'REJECTED'; reason: string };

type RequestRelationshipResponse = StandardResponse<
  | RelationshipIntentApplied
  | RelationshipBusinessRejection
  | MembershipIntentApplied
>;

export class FederatedResolveError extends Error {
  constructor(readonly reason: FederatedResolveFailure) {
    super(reason);
    this.name = 'FederatedResolveError';
  }
}

interface ClientIntentUser {
  id: number;
  account: string;
  name: string;
  avatar: string;
  bio: string;
  domain: string;
  profileRev?: number;
}

interface ClientFriendIntentBase {
  requestStatus?: RequestRevocationStatus;
  requestDirection?: FriendIntentDirection;
  established?: boolean;
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
  requestStatus?: RequestRevocationStatus;
  requestDirection?: FriendIntentDirection;
  established?: boolean;
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
      eventType: 'RELATIONSHIP_INTENT';
      subjectAccount: string;
      subjectDomain: string;
      body: ClientStateBody;
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
      account: '';
      domain: 'local';
      namespaceId: 0;
      eventType: 'THREAD_STATE';
      subjectAccount: string;
      subjectDomain: 'local';
      body: ThreadStateSnapshot;
    };

/** The persisted last-logged-in userId (device-scoped preference) — the client's sole pre-HELLO source
 *  of its own userId (the session token is opaque, server-side-lookup only). Set on establishSession,
 *  cleared on clearSession. Read at boot by {@link UserService.restoreWebdb} so the per-user IDB opens +
 *  the threadlist eager-paints the cached list BEFORE the SSE/HELLO round-trip (instant list for
 *  returning users). Cleared on logout by `clearClientPreferences`. */
const LAST_USER_ID_KEY = 'soms.lastUserId';
const CACHE_REBUILD_KEY = 'soms.cacheRebuild';

export const CACHE_REBUILD_RELOAD = new InjectionToken<() => void>(
  'CACHE_REBUILD_RELOAD',
  { providedIn: 'root', factory: () => () => window.location.reload() },
);

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
   *  SessionLifecycleService separately announces logout even when this id is still null. */
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
  private readonly webdb = inject(WebdbService);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly preferences = inject(PreferenceStore);
  private readonly sessionLifecycle = inject(SessionLifecycleService);
  /** The user key whose DB is currently open (or null) — tracks {@link establishSession} / {@link clearSession}. */
  private webdbUserKey: string | null = null;
  /** Set only by a real credential/OTP/QR login. Cold-start restore and reconnect never set it. */
  private freshCachePending = false;
  private cacheRebuildRequest?: Promise<void>;
  private readonly reloadForCacheRebuild = inject(CACHE_REBUILD_RELOAD);

  /** Persist recovery outside the damaged cache. Rebuild only after reload, when old writers are gone. */
  requestCacheRebuild(): Promise<void> {
    if (this.webdbUserKey === null || this.freshCachePending)
      return Promise.resolve();
    return (this.cacheRebuildRequest ??= this.scheduleCacheRebuild());
  }

  private async scheduleCacheRebuild(): Promise<void> {
    try {
      const userId =
        this.webdbUserKey === null ? null : Number(this.webdbUserKey);
      // A real first login has no partition yet. Its HELLO initializes a fresh cache normally.
      if (userId === null || this.freshCachePending) return;
      const scope = `account:${userId}` as const;
      if (
        (await this.preferences.get(scope, CACHE_REBUILD_KEY)) === 'attempted'
      ) {
        console.warn('[cache-recovery] automatic rebuild already attempted', {
          userId,
        });
        return;
      }
      if (this.webdbUserKey !== String(userId)) return;
      await this.preferences.set(scope, CACHE_REBUILD_KEY, 'pending');
      if (this.webdbUserKey !== String(userId)) return;
      console.warn('[cache-recovery] reloading to rebuild account cache', {
        userId,
      });
      this.reloadForCacheRebuild();
    } catch (error) {
      console.warn('[cache-recovery] could not schedule cache rebuild', error);
    }
  }

  constructor(private http: HttpClient) {}

  /** Mark the next HELLO-established user partition for drop + clean v1 initialization. */
  prepareFreshCache(): void {
    this.freshCachePending = true;
  }

  /** Delete durable account data, clear identity, then explicitly reset in-memory consumers. The
   * notification also covers pre-HELLO logout, when sessionUserId has never left null. */
  async clearSession(): Promise<void> {
    this.sessionLifecycle.invalidateSession();
    const prev = this.webdbUserKey;
    const previousUserId = this.sessionProfile()?.id;
    // Keep LAST_USER_ID until the durable cache wipe succeeds. If deletion fails, retaining that key makes
    // the same partition discoverable on retry/restart instead of orphaning undeleted account data.
    if (prev != null) await this.webdb.closeAndDelete(prev);
    await this.clearClientPreferences(previousUserId);
    this.webdbUserKey = null;
    this.freshCachePending = false;
    this.cacheRebuildRequest = undefined;
    this.sessionUserId.set(null);
    this.sessionProfile.set(undefined);
    this._stateFeedCursor.set(undefined);
    this.relationshipRequestStateRevision.set(0);
    this.relationshipIntentStateRevision.set(0);
    this.relationshipRequestReadThroughFeedId.set(0);
    this.profileFetch = undefined;
    this.sessionLifecycle.endSession();
  }

  /** Establish the session from the HELLO connect handshake — the cold-start / login entry point. Opens
   *  the per-user IDB on `userId` (the webdb-open trigger that previously rode the profile fetch) and
   *  returns once it is open, so the caller (the threadlist) can read IDB without waiting on the profile.
   *  The profile gate ({@link gateSelfProfile}) runs async: if the IDB-cached self profile's `profileRev`
   *  matches HELLO's, the cached profile is fresh and the fetch is skipped; otherwise (first boot / stale)
   *  the full profile is fetched + cached. Friend-request notification state is restored from this device's
   *  per-account database and subsequently advanced by the unified state delta. */
  async establishSession(userId: number, profileRev: number): Promise<void> {
    const epoch = this.sessionLifecycle.accountEpoch;
    const checkSession = () => {
      if (!this.sessionLifecycle.isCurrent(epoch))
        throw new Error('account session expired during HELLO');
    };
    if (this.freshCachePending) {
      await this.webdb.recreateForUser(String(userId));
      checkSession();
      await this.preferences.remove(`account:${userId}`, CACHE_REBUILD_KEY);
      checkSession();
      this.freshCachePending = false;
      this.cacheRebuildRequest = undefined;
      this.webdbUserKey = null;
    }
    if (this.sessionUserId() === userId) {
      return;
    }
    // Account switch without a logout (defensive): tear down the previous user's DB first.
    if (this.webdbUserKey !== null && this.webdbUserKey !== String(userId)) {
      await this.webdb.closeAndDelete(this.webdbUserKey);
      checkSession();
    }
    this.webdbUserKey = String(userId);
    this.persistLastUserId(userId); // remember for the next boot's eager IDB paint (pre-HELLO)
    try {
      await this.webdb.openExistingForUser(String(userId)); // strict read on the normal path
    } catch (error) {
      checkSession();
      // Every local-cache validation/open failure is rebuildable state. The Webdb epoch prevents this
      // recreation from publishing handles if logout/account-switch wins while it is in flight.
      console.warn('[cache-recovery] session cache open failed', error);
      const scope = `account:${userId}` as const;
      if (
        (await this.preferences.get(scope, CACHE_REBUILD_KEY)) === 'attempted'
      )
        throw error;
      checkSession();
      await this.preferences.set(scope, CACHE_REBUILD_KEY, 'attempted');
      checkSession();
      await this.webdb.recreateForUser(String(userId));
    }
    checkSession();
    const [latest, requestReadHead] = await Promise.all([
      this.webdb.getMeta('relationshipRequestStateRevision'),
      this.webdb.getMeta('relationshipRequestReadHead'),
    ]);
    checkSession();
    this.sessionUserId.set(userId);
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
    const lastCleanup = await this.webdb.getMeta(
      'relationshipRequestCleanupAt',
    );
    checkSession();
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
    void this.gateSelfProfile(userId, profileRev).catch(async (error) => {
      console.warn('[cache-recovery] cached self profile read failed', error);
      if (this.webdbUserKey === String(userId))
        await this.requestCacheRebuild();
    });
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
        await firstValueFrom(this.publishSelfProfile(res.data));
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

  /** Boot-time webdb restore on the persisted {@link LAST_USER_ID_KEY} — opens the per-user IDB and restores
   *  its cached self profile so the threadlist plus self name/avatar can eager-paint BEFORE the SSE/HELLO
   *  round-trip (including an offline cold start). Does NOT set sessionUserId — the session tracker stays
   *  HELLO-driven; {@link establishSession} reconciles on HELLO (idempotent `openForUser` reuse for the same
   *  user, close+reopen on a switch). No-op when no userId was ever persisted (first-ever launch). */
  async restoreWebdb(): Promise<void> {
    try {
      const userId = await this.readLastUserId();
      if (userId === null) return;
      this.webdbUserKey = String(userId);
      const scope = `account:${userId}` as const;
      const recovery = await this.preferences.get(scope, CACHE_REBUILD_KEY);
      if (recovery !== 'pending') {
        try {
          await this.webdb.openExistingForUser(String(userId));
          await this.restoreCachedSelfProfile(userId);
          return;
        } catch (error) {
          console.warn('[cache-recovery] account cache restore failed', error);
          if (recovery === 'attempted') return;
        }
      }
      // Persist before attempting: a failed rebuild must not cause a reload loop.
      await this.preferences.set(scope, CACHE_REBUILD_KEY, 'attempted');
      if (isTauri()) await tauriInvoke('native_db_recreate_cache');
      await this.webdb.recreateForUser(String(userId));
      await this.restoreCachedSelfProfile(userId);
      console.warn(
        '[cache-recovery] account cache rebuilt; awaiting full state replay',
        { userId },
      );
    } catch (error) {
      console.warn('[cache-recovery] account cache rebuild unavailable', error);
    }
  }

  private async restoreCachedSelfProfile(userId: number): Promise<void> {
    const cached = (await this.webdb.getMeta('selfProfile')) as
      | User
      | null
      | undefined;
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
      switchMap((res) => this.publishSelfProfile(res.data as User)),
      shareReplay(1),
    );
    if (!opts?.force) this.profileFetch = fetch;
    return fetch;
  }

  /** The self endpoint owns account metadata; only the runtime resolves profile bytes. */
  private publishSelfProfile(user: User): Observable<User> {
    const epoch = this.sessionLifecycle.accountEpoch;
    return this.profileRepo
      .resolve({
        type: 'EXACT',
        account: user.account,
        domain: user.domain,
        rev: user.profileRev,
      })
      .pipe(
        map((profile) => {
          const resolved = {
            ...user,
            name: profile.name,
            bio: profile.bio,
            avatar: '',
          };
          if (this.sessionLifecycle.isCurrent(epoch)) {
            this.sessionProfile.set(resolved);
            void this.webdb.putMeta('selfProfile', resolved);
            void this.webdb.putMeta('selfIdentity', {
              account: resolved.account,
              domain: 'local',
            });
          }
          return resolved;
        }),
      );
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
        item.peerUser.account === user.account &&
        item.peerUser.domain === (user.domain || 'local'),
    );
    if (friendship) return 'FRIEND' as const;
    const matches = (item: FriendRequestProjection) =>
      item.kind === 'FRIEND' &&
      item.status === 'REQUESTED' &&
      item.expiresAt > Date.now() &&
      ((user.id > 0 && item.peer?.id === user.id) ||
        (item.peer?.account === user.account &&
          item.peer.domain === (user.domain || 'local')));
    const hasPending = async (direction: FriendIntentDirection) => {
      let cursor: string | null = null;
      for (;;) {
        const page = await this.listLocalFriendRequests(direction, cursor, 200);
        if (page.items.some(matches)) return true;
        if (!page.hasMore) return false;
        cursor = page.scannedThrough;
      }
    };
    if (await hasPending('OUTGOING')) return 'OUTGOING_PENDING' as const;
    if (await hasPending('INCOMING')) return 'INCOMING_PENDING' as const;
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
      StandardResponse<
        | RelationshipIntentApplied
        | RelationshipBusinessRejection
        | MembershipIntentApplied
      >
    >(`${apiPrefix()}/relationship/accept`, params);
  }

  markRelationshipRequestAccepted(key: string): Promise<void> {
    return this.webdb.markRelationshipRequestAccepted(key);
  }

  joinGroupRequest(params: { groupId: number }) {
    return this.http.post<
      StandardResponse<MembershipIntentApplied | RelationshipBusinessRejection>
    >(`${apiPrefix()}/group/join-request`, params);
  }

  /** Revoke the current user relationship or pending request toward one exact Address. */
  revokeRelationship(params: { account: string; domain: string }) {
    return this.http.post<
      StandardResponse<
        | RelationshipIntentApplied
        | MembershipIntentApplied
        | RelationshipBusinessRejection
      >
    >(`${apiPrefix()}/relationship/revoke`, params);
  }

  /** Commit the viewport's local read HWM. SSE wakes the client to pull the compacted attention feed. */
  markRead(params: { threadId: number; localReadHwm: number }) {
    return this.http.post<StandardResponse<ThreadReadPositionResult>>(
      `${apiPrefix()}/thread/mark-read`,
      params,
    );
  }
}

/** Return the one canonical avatar resource without deriving local variants. */
export function avatarUrl(base: string | undefined | null): string {
  return base ?? '';
}

/**
 * Preference records holding USER-SCOPED client-only data (no server copy) — cleared on logout so a
 * second account on the same browser never sees the previous one's emoji recents. This mirrors
 * the IDB purge-on-logout (the per-user DB is closed + deleted): local cache is wiped, rebuilt from
 * scratch on the next login. NOTE these are client-only — clearing is permanent (even for the same user
 * re-logging in), which is the chosen trade-off for account isolation.
 *
 * Deliberately NOT cleared (device-level preferences, shared across accounts on this browser): theme,
 * language, the desktop list-pane width, the media-size threshold, and `device_id`.
 */
