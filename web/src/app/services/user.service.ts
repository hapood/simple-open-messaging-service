import type { RequestSnapshot } from '../../../../shared/request-snapshot';
import type { RequestRevocationStatus } from '../../../../shared/request-projection-status';
import {
  Injectable,
  InjectionToken,
  signal,
  computed,
  inject,
} from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { REQUEST_SCOPE, RequestScope } from '../request-context';
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
  SelfAccount,
  ConversationItem,
  StandardResponse,
  PersonalQuotaState,
} from './model';
import { WebdbService } from './webdb.service';
import { ProfileRepository, type ResolvedProfile } from './profile-store.service';
import { PreferenceStore } from './preference-store.service';
import { isTauri, tauriInvoke } from './runtime';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionSupersededError } from './session/session-identity';
import {
  parseIncomingRequestHead,
  type IncomingRequestHead,
  type PersonalRequestPage,
  type RequestBucket,
  type RequestDecisionResult,
  type RequestKind,
} from '../../../../shared/relationship-request';

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

export interface ClientStateFeedItem {
  feedId: number;
  body: IncomingRequestHead;
}

/** The persisted last-logged-in userId (device-scoped preference) — the client's sole pre-HELLO source
 *  of its own userId (the session token is opaque, server-side-lookup only). Set on establishSession,
 *  cleared on clearSession. Read at boot by {@link UserService.restoreWebdb} so the per-user IDB opens +
 *  the threadlist eager-paints the cached list BEFORE the SSE/HELLO round-trip (instant list for
 *  returning users). Removed during session preference cleanup. */
const LAST_USER_ID_KEY = 'soms.lastUserId';
const CACHE_REBUILD_KEY = 'soms.cacheRebuild';

export const CACHE_REBUILD_RELOAD = new InjectionToken<() => void>(
  'CACHE_REBUILD_RELOAD',
  { providedIn: 'root', factory: () => () => window.location.reload() },
);

/** Transient self presentation; only account facts are persisted in account state. */
export type SelfProfileView = SelfAccount & Pick<ResolvedProfile, 'name' | 'bio'>;

@Injectable({
  providedIn: 'root',
})
export class UserService {
  /** Self display hydrated from the revision-keyed profile store, never a persisted display copy. */
  sessionProfile = signal<SelfProfileView | undefined>(undefined);
  /** The authenticated user's id — sourced from the HELLO connect handshake (the session token is OPAQUE,
   *  server-side-lookup only, so HELLO is the client's sole pre-profile-fetch source of its own userId).
   *  The per-user IDB store opens on this id via {@link establishSession}; it replaces the old coupling
   *  where the webdb opened on the profile fetch's sessionProfile().id (which made the fetch un-skippable).
   *  SessionLifecycleService separately announces logout even when this id is still null. */
  readonly sessionUserId = signal<number | null>(null);
  /** Authoritative authenticated session identity; never restored from the account cache. */
  readonly sessionId = signal<number | null>(null);

  /** The client's applied state-feed cursor — seeded from HELLO and advanced after
   *  each STATE_FEED_UPDATED signal is applied. Lives here so ConversationListService (which injects this
   *  service) can read/advance it without a circular DI. In-memory only — seeded fresh each connect. */
  private readonly _stateFeedCursor = signal<number | undefined>(undefined);
  readonly stateFeedCursor = this._stateFeedCursor.asReadonly();

  private readonly _relationshipRequestHead = signal<IncomingRequestHead | undefined>(undefined);
  readonly relationshipRequestHead = this._relationshipRequestHead.asReadonly();
  private readonly _intentOptimisticReadId = signal<string | null>(null);
  /** Publish only a durable optimistic target, monotonically. A null durable
   * value clears any stale in-memory target after a confirmed read. */
  private publishIntentOptimisticRead(value: string | null): void {
    const current = this._intentOptimisticReadId();
    if (value === null || current === null || BigInt(value) > BigInt(current))
      this._intentOptimisticReadId.set(value);
  }
  readonly friendReqBadge = computed(() => {
    const head = this.relationshipRequestHead();
    if (head === undefined) return false;
    const optimistic = this._intentOptimisticReadId();
    const read = BigInt(head.requestReadId);
    const covered = optimistic !== null && BigInt(optimistic) > read
      ? BigInt(optimistic) : read;
    return BigInt(head.requestEndId) > covered;
  });
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

  constructor(private http: HttpClient) {
    this.sessionLifecycle.invalidated$.subscribe(() => this.sessionId.set(null));
  }

  /** Mark the next HELLO-established user partition for drop + clean v1 initialization. */
  prepareFreshCache(): void {
    // Credential replacement is a login boundary even without a preceding logout.
    // Reject old requests and callbacks before initializing the successor cache.
    this.sessionLifecycle.invalidateSession();
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
    await this.clearSessionPreferences(previousUserId);
    this.resetSessionState();
  }

  /** Release the renderer's native-session resources without deleting retained account data. */
  async releaseSession(): Promise<void> {
    this.sessionLifecycle.invalidateSession();
    this.resetSessionState();
    await this.webdb.close();
  }

  /** In-memory only. The session owner handles invalidation, connections and physical deletion. */
  resetSessionState(): void {
    this.webdbUserKey = null;
    this.freshCachePending = false;
    this.cacheRebuildRequest = undefined;
    this.sessionId.set(null);
    this.sessionUserId.set(null);
    this.sessionProfile.set(undefined);
    this._stateFeedCursor.set(undefined);
    this._relationshipRequestHead.set(undefined);
    this._intentOptimisticReadId.set(null);
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
  async establishSession(userId: number, profileRev: number, sessionId: number): Promise<void> {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('invalid HELLO sessionId');
    const scope = this.sessionLifecycle.capture();
    const checkSession = () => {
      if (!this.sessionLifecycle.isCurrent(scope))
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
      this.sessionId.set(sessionId);
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
      // Every local-cache validation/open failure is rebuildable state. The Webdb maintenance fence prevents this
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
    const state = await this.webdb.readAccountState();
    checkSession();
    this.sessionUserId.set(userId);
    this.sessionId.set(sessionId);
    if (state.intentRequestEndId !== null && state.intentRequestReadId !== null)
      this.applyRelationshipRequestHead({ requestEndId: state.intentRequestEndId,
        requestReadId: state.intentRequestReadId });
    this._intentOptimisticReadId.set(state.intentRequestOptimisticReadId);
    // Durable resubmission: a read target that was persisted but never
    // confirmed (failed submission, restart in between) retries once the
    // session owns the account again. Best-effort — the next page view retries
    // again if this submission also fails.
    const durableOptimistic = state.intentRequestOptimisticReadId;
    if (
      durableOptimistic !== null &&
      state.intentRequestReadId !== null &&
      BigInt(durableOptimistic) > BigInt(state.intentRequestReadId)
    )
      void this.markRelationshipRequestsRead(durableOptimistic).catch(
        () => undefined,
      );
    void this.gateSelfProfile(userId, profileRev).catch(async (error) => {
      console.warn('[cache-recovery] cached self profile read failed', error);
      if (this.webdbUserKey === String(userId))
        await this.requestCacheRebuild();
    });
  }

  /** Matching account metadata skips HTTP; display content still comes from the selected profile revision. */
  private async gateSelfProfile(
    userId: number,
    profileRev: number,
  ): Promise<void> {
    const cached = (await this.webdb.readAccountState()).selfProfile;
    if (cached && cached.id === userId && cached.profileRev === profileRev) {
      await firstValueFrom(this.publishSelfProfile(cached));
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

  /** Publish only server-confirmed heads. HTTP responses never write durable sync state. */
  applyRelationshipRequestHead(value: unknown): void {
    const next = parseIncomingRequestHead(value);
    const current = this.relationshipRequestHead();
    const merged = current ? {
      requestEndId: BigInt(next.requestEndId) > BigInt(current.requestEndId)
        ? next.requestEndId : current.requestEndId,
      requestReadId: BigInt(next.requestReadId) > BigInt(current.requestReadId)
        ? next.requestReadId : current.requestReadId,
    } : next;
    this._relationshipRequestHead.set(merged);
    // Mirror the storage rule: a confirmed read covering the optimistic target retires it.
    const optimistic = this._intentOptimisticReadId();
    if (optimistic !== null && BigInt(merged.requestReadId) >= BigInt(optimistic))
      this._intentOptimisticReadId.set(null);
  }

  /** The caller supplies the end ID observed in a successful RECEIVED page, not a feed cursor. */
  async markRelationshipRequestsRead(requestReadId: string): Promise<void> {
    const scope = this.sessionLifecycle.capture();
    const sessionId = this.sessionId();
    if (sessionId === null) throw new Error('request read requires an active session');
    const res = await firstValueFrom(this.http.post<StandardResponse<IncomingRequestHead>>(
      `${apiPrefix()}/relationship/requests/read`, { requestReadId },
    ));
    if (!this.sessionLifecycle.isCurrent(scope) || this.sessionId() !== sessionId) return;
    if (res.code !== 0) throw new Error(res.message);
    this.applyRelationshipRequestHead(res.data);
  }

  /** Boot-time webdb restore on the persisted {@link LAST_USER_ID_KEY} — opens the per-user IDB and restores
   *  its cached self profile so the threadlist plus self name/avatar can eager-paint BEFORE the SSE/HELLO
   *  round-trip (including an offline cold start). Does NOT set sessionUserId — the session tracker stays
   *  HELLO-driven; {@link establishSession} reconciles on HELLO (idempotent `openForUser` reuse for the same
   *  user, close+reopen on a switch). No-op when no userId was ever persisted (first-ever launch). */
  async restoreWebdb(signal?: AbortSignal): Promise<void> {
    const check = () => {
      if (signal?.aborted) throw new SessionSupersededError();
    };
    try {
      check();
      const userId = await this.readLastUserId(Boolean(signal));
      check();
      if (userId === null) return;
      this.webdbUserKey = String(userId);
      const scope = `account:${userId}` as const;
      const recovery = signal
        ? await this.preferences.getStrict(scope, CACHE_REBUILD_KEY)
        : await this.preferences.get(scope, CACHE_REBUILD_KEY);
      check();
      if (recovery !== 'pending') {
        try {
          await this.webdb.openExistingForUser(String(userId));
          await this.restoreCachedSelfProfile(userId, signal);
          check();
          return;
        } catch (error) {
          check();
          console.warn('[cache-recovery] account cache restore failed', error);
          if (recovery === 'attempted') {
            if (signal) throw error;
            return;
          }
        }
      }
      // Persist before attempting: a failed rebuild must not cause a reload loop.
      await this.preferences.set(scope, CACHE_REBUILD_KEY, 'attempted');
      check();
      if (isTauri()) await tauriInvoke('native_db_recreate_cache');
      await this.webdb.recreateForUser(String(userId));
      await this.restoreCachedSelfProfile(userId, signal);
      check();
      console.warn(
        '[cache-recovery] account cache rebuilt; awaiting full state replay',
        { userId },
      );
    } catch (error) {
      console.warn('[cache-recovery] account cache rebuild unavailable', error);
      if (signal) throw error;
    }
  }

  private async restoreCachedSelfProfile(userId: number, signal?: AbortSignal): Promise<void> {
    const cached = (await this.webdb.readAccountState()).selfProfile;
    if (signal?.aborted) throw new SessionSupersededError();
    if (cached?.id === userId)
      await firstValueFrom(this.publishSelfProfile(cached));
  }

  /** Read the persisted last-logged-in userId, or null when absent / unparseable / storage unavailable. */
  private async readLastUserId(strict = false): Promise<number | null> {
    const raw = strict
      ? await this.preferences.getStrict<number>('device', LAST_USER_ID_KEY)
      : await this.preferences.get<number>('device', LAST_USER_ID_KEY);
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

  async clearSessionPreferences(userId?: number): Promise<void> {
    if (userId === undefined) {
      const saved = await this.preferences.getStrict<unknown>('device', LAST_USER_ID_KEY);
      if (typeof saved === 'number' && Number.isSafeInteger(saved) && saved > 0) userId = saved;
    }
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
    ]);
  }

  /** In-flight profile fetch (dedup): boot calls updateSessionProfile() AND ConversationListService
   *  calls ensureProfile() in the same init batch — without sharing, both would fire /user/my-profile.
   *  Cached here (shareReplay) so concurrent callers ride one HTTP request; once it resolves,
   *  sessionProfile is set and late callers take the short-circuit branch. `force:true` bypasses the
   *  cache (reconnect always re-fetches). */
  private profileFetch?: Observable<SelfProfileView>;

  /** Idempotent self-profile get-or-load: returns the cached sessionProfile if already loaded (set by
   *  {@link establishSession} from HELLO, or a prior fetch), else fetches /user/my-profile. `force:true`
   *  re-fetches for live refresh (the friend-request state delta and post-edit re-read).
   *  The state-feed cursor is NOT seeded here — HELLO owns the sole feed-end source now. */
  ensureProfile(opts?: { force?: boolean }): Observable<SelfProfileView> {
    if (!opts?.force && this.sessionProfile() !== undefined) {
      return of(this.sessionProfile() as SelfProfileView);
    }
    if (!opts?.force && this.profileFetch) {
      return this.profileFetch;
    }
    const fetch = this.getMyProfile().pipe(
      switchMap((res) => {
        if (res.code !== 0 || !res.data)
          throw new Error(res.message || 'missing self account');
        return this.publishSelfProfile(res.data);
      }),
      shareReplay(1),
    );
    if (!opts?.force) this.profileFetch = fetch;
    return fetch;
  }

  /** The self endpoint owns account metadata; only the runtime resolves profile bytes. */
  private publishSelfProfile(user: SelfAccount): Observable<SelfProfileView> {
    const scope = this.sessionLifecycle.capture();
    // Revision zero is an account without a published profile, not a resolver demand.
    const display =
      user.profileRev === 0
        ? of({ name: user.account, bio: '' })
        : this.profileRepo.resolve({
            publisherNamespaceId: 0,
            lookup: 'ACCOUNT_PROFILE',
            target: {
              profileNamespaceId: 0,
              account: user.account,
              rev: user.profileRev,
            },
          });
    return display.pipe(
      switchMap(async (profile) => {
        const resolved: SelfProfileView = {
          id: user.id,
          account: user.account,
          namespaceId: user.namespaceId,
          profileRev: user.profileRev,
          isGroup: user.isGroup,
          isDeleted: user.isDeleted,
          name: profile.name,
          bio: profile.bio,
        };
        if (this.sessionLifecycle.isCurrent(scope)) {
          await this.webdb.writeSelfProfile({
            id: user.id,
            account: user.account,
            namespaceId: user.namespaceId,
            profileRev: user.profileRev,
            isGroup: user.isGroup,
            isDeleted: user.isDeleted,
          });
          if (this.sessionLifecycle.isCurrent(scope))
            this.sessionProfile.set(resolved);
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

  /** Rehydrate signals from committed state-feed storage, including a full recovery that reset the cursor. */
  async refreshCommittedStateFeed(): Promise<number | undefined> {
    const userId = this.sessionUserId();
    if (userId === null) return undefined;
    const scope = this.sessionLifecycle.capture();
    const state = await this.webdb.readAccountState();
    const cursor = state.stateFeedId;
    if (!this.sessionLifecycle.isCurrent(scope) || this.sessionUserId() !== userId) return undefined;
    const committed = cursor ?? 0;
    if (
      typeof committed !== 'number' ||
      !Number.isSafeInteger(committed) ||
      committed < 0
    )
      return undefined;
    this.seedStateFeedCursor(committed);
    if (state.intentRequestEndId !== null && state.intentRequestReadId !== null)
      this.applyRelationshipRequestHead({ requestEndId: state.intentRequestEndId,
        requestReadId: state.intentRequestReadId });
    this._intentOptimisticReadId.set(state.intentRequestOptimisticReadId);
    return committed;
  }

  /** Advance the cursor after applying a delta (monotonic — ignore a non-advancing/stale revision). */
  advanceStateFeedCursor(feedId: number): void {
    const cur = this._stateFeedCursor();
    if (cur === undefined || feedId > cur) this._stateFeedCursor.set(feedId);
  }

  /** Account-only registration: the account is created at profile rev 0 and the user sets
   *  their display name through their own first profile edit afterwards. */
  register(params: { account: string; password: string }) {
    return this.http.post<{
      code: number;
      message: string;
      data?: { id: number; account: string };
    }>(`${apiPrefix()}/user/register`, params, {
      context: new HttpContext().set(REQUEST_SCOPE, RequestScope.Authentication),
    });
  }

  getMyProfile() {
    return this.http.post<StandardResponse<SelfAccount>>(
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
    params: {
      account: string;
      domain: string;
      publicKey?: string;
      publisherNamespaceId?: number;
      profileNamespaceId?: number;
    },
    onProgress?: (stage: FederatedResolveStage) => void,
  ): Observable<FederatedResolveResult> {
    const query = new URLSearchParams();
    query.set('account', params.account);
    query.set('domain', params.domain);
    if (params.publicKey) query.set('publicKey', params.publicKey);
    if (params.publisherNamespaceId !== undefined)
      query.set('publisherNamespaceId', String(params.publisherNamespaceId));
    if (params.profileNamespaceId !== undefined)
      query.set('profileNamespaceId', String(params.profileNamespaceId));
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

  /** A RECEIVED page was seen: persist the durable read intent first, publish
   * it only once persisted, then submit it. The durable target survives a
   * failed submission for the next retry; a superseded session publishes
   * nothing. */
  async observeIncomingRequestPage(head: IncomingRequestHead): Promise<void> {
    parseIncomingRequestHead(head);
    const scope = this.sessionLifecycle.capture();
    const sessionId = this.sessionId();
    if (sessionId === null) throw new Error('request read requires an active session');
    const state = await this.webdb.advanceIntentRequestRead(head.requestEndId);
    if (!this.sessionLifecycle.isCurrent(scope) || this.sessionId() !== sessionId) return;
    this.publishIntentOptimisticRead(state.intentRequestOptimisticReadId);
    await this.markRelationshipRequestsRead(head.requestEndId);
  }

  /** Author a relationship request toward one exact user or group identity. */
  requestRelationship(params: {
    account: string;
    namespaceId: number;
    snapshot: RequestSnapshot;
    note?: string;
  }) {
    return this.http.post<RequestRelationshipResponse>(
      `${apiPrefix()}/relationship/request`,
      params,
    );
  }

  /** Threads own established relationships; pending rounds are queried online. */
  async localRelationship(
    user: Pick<User, 'id' | 'account' | 'namespaceId'>,
  ) {
    const threads = await this.webdb.getThreads();
    const isGroup = user.account.startsWith('!');
    const friendship = threads.some(
      (item) =>
        item.type === (isGroup ? 'GROUP' : 'P2P') &&
        item.conversationState === 'ACTIVE' &&
        item.account === user.account &&
        item.publisherNamespaceId === user.namespaceId,
    );
    if (friendship) return 'FRIEND' as const;
    if (isGroup) return 'NONE' as const;
    if (await this.hasPendingRound('SENT', user)) return 'OUTGOING_PENDING' as const;
    if (await this.hasPendingRound('RECEIVED', user)) return 'INCOMING_PENDING' as const;
    return 'NONE' as const;
  }

  /** Page the online seven-day window until a live round for one target is found. */
  private async hasPendingRound(
    bucket: RequestBucket,
    target: Pick<User, 'account' | 'namespaceId'>,
    kind: RequestKind = 'FRIEND',
  ): Promise<boolean> {
    let before: string | undefined;
    for (;;) {
      const res = await firstValueFrom(
        this.queryRelationshipRequests({ bucket, before, take: 50 }),
      );
      const page = res.data;
      if (res.code !== 0 || !page) throw new Error(res.message);
      if (page.items.some((item) => {
        const peer = bucket === 'SENT' ? item.receiver : item.author;
        return item.kind === kind && item.status === 'REQUESTED' &&
          peer.account === target.account && peer.namespaceId === target.namespaceId;
      })) return true;
      if (!page.hasMore) return false;
      if (page.before === null) throw new Error('request page has no continuation');
      before = page.before;
    }
  }

  /** Group cards disable their join action while one live application exists. */
  async hasPendingGroupApplication(target: Pick<User, 'account' | 'namespaceId'>): Promise<boolean> {
    return this.hasPendingRound('SENT', target, 'GROUP_APPLICATION');
  }

  queryRelationshipRequests(params: { bucket: RequestBucket; before?: string; take?: number }) {
    return this.http.post<StandardResponse<PersonalRequestPage>>(
      `${apiPrefix()}/relationship/requests`, params,
    );
  }

  acceptRelationship(params: { requestId: string }) {
    return this.http.post<StandardResponse<RequestDecisionResult>>(
      `${apiPrefix()}/relationship/accept`, params,
    );
  }

  rejectRelationshipRequest(params: { requestId: string }) {
    return this.http.post<StandardResponse<RequestDecisionResult>>(
      `${apiPrefix()}/relationship/requests/reject`, params,
    );
  }

  withdrawRelationshipRequest(params: { requestId: string }) {
    return this.http.post<StandardResponse<RequestDecisionResult>>(
      `${apiPrefix()}/relationship/requests/withdraw`, params,
    );
  }

  joinGroupRequest(params: { requestId: string }) {
    return this.http.post<StandardResponse<RequestDecisionResult>>(
      `${apiPrefix()}/group/join-request`, params,
    );
  }

  /** End the established relationship by its P2P thread, symmetric to group
   * leave; never decides a pending request round. */
  revokeRelationship(params: { threadId: number }) {
    return this.http.post<
      StandardResponse<
        RelationshipIntentApplied | RelationshipBusinessRejection
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
