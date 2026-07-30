import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, map, shareReplay, firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import { User, ConversationItem, Invite, InviteDetail, StandardResponse } from './model'
import { WebdbService } from './webdb.service'
import { ProfileRepository } from './profile-store.service'

export type { User } from './model'

/** One entry of the hydrated thread-list delta (POST /user/query-thread/delta). The server plans
 *  (last-op-wins) + hydrates the ADDs inline (peer/group/unread); DELETE entries carry the threadId only
 *  (the thread is leaving the roster — nothing to render). The client applies a single response — no
 *  client-side planning, no second batch-hydrate round-trip. */
export type HydratedThreadDeltaOp =
  | { threadId: number; direction: 'ADD'; item: ConversationItem }
  | { threadId: number; direction: 'DELETE' }

/** The persisted last-logged-in userId (localStorage) — the client's sole pre-HELLO source of its own
 *  userId (the session token is opaque, server-side-lookup only). Set on establishSession, cleared on
 *  clearSession. Read at boot by {@link UserService.restoreWebdb} so the per-user IDB opens + the
 *  threadlist eager-paints the cached list BEFORE the SSE/HELLO round-trip (instant list for returning
 *  users). Cleared with the other user-scoped keys on logout (see USER_SCOPED_LS_KEYS). */
const LAST_USER_ID_KEY = 'soms.lastUserId'

@Injectable({
  providedIn: 'root',
})
export class UserService {
  sessionProfile = signal<User | undefined>(undefined)
  /** The authenticated user's id — sourced from the HELLO connect handshake (the session token is OPAQUE,
   *  server-side-lookup only, so HELLO is the client's sole pre-profile-fetch source of its own userId).
   *  The per-user IDB store opens on this id via {@link establishSession}; it replaces the old coupling
   *  where the webdb opened on the profile fetch's sessionProfile().id (which made the fetch un-skippable).
   *  Other services' session-end effects key off this signal to reset their in-memory caches on logout. */
  readonly sessionUserId = signal<number | null>(null)

  /** The client's applied thread-list revision cursor — seeded from the HELLO connect handshake's
   *  threadRevision (the SOLE revision source now that the snapshot endpoint is gone), advanced after each
   *  THREAD_REVISION_UPDATED delta is applied. Lives here so ConversationListService (which injects this
   *  service) can read/advance it without a circular DI. In-memory only — seeded fresh each connect. */
  private readonly _threadRevCursor = signal<number | undefined>(undefined)
  readonly threadRevCursor = this._threadRevCursor.asReadonly()

  /** The latest friend-request revision (epoch ms | null) = MAX(createdAt) over incoming FRIEND invites
   *  (creation-based — arms ONLY on a new request), sourced from the HELLO handshake +
   *  FRIEND_REQ_REV_UPDATED pushes. Server-state (multi-device consistent). */
  readonly friendReqRev = signal<number | null>(null)
  /** The acknowledged friend-request revision (server-state, epoch ms) — the read cursor. Sourced from
   *  HELLO + FRIEND_REQ_REV_UPDATED; advanced server-side by markFriendReqRead (POST /invite/mark-read → the
   *  server bumps it + pushes, clearing the badge on ALL devices). NOT persisted to IDB — it is server-state. */
  readonly friendReqAckRev = signal<number | null>(null)
  /** The unread-friend-request badge: true while friendReqRev > friendReqAckRev. Read by the icon-rail +
   *  nav-drawer templates. */
  readonly friendReqBadge = computed(() => (this.friendReqRev() ?? 0) > (this.friendReqAckRev() ?? 0))

  private readonly webdb = inject(WebdbService)
  private readonly profileRepo = inject(ProfileRepository)
  /** The user key whose DB is currently open (or null) — tracks {@link establishSession} / {@link clearSession}. */
  private webdbUserKey: string | null = null

  constructor(private http: HttpClient) {}

  /** Tear down the in-memory session (logout / account switch). Clears sessionUserId + sessionProfile →
   *  every DB-layer repository's session-end effect (watching sessionUserId) resets its cache; the per-user
   *  IDB is closed + deleted. Also wipes the user-scoped localStorage keys (client-only folders / emoji). */
  clearSession(): void {
    const prev = this.webdbUserKey
    this.webdbUserKey = null
    this.sessionUserId.set(null)
    this.sessionProfile.set(undefined)
    this._threadRevCursor.set(undefined)
    this.friendReqRev.set(null)
    this.friendReqAckRev.set(null)
    this.profileFetch = undefined
    clearUserScopedLocalStorage()
    if (prev != null) void this.webdb.closeAndDelete(prev)
  }

  /** Establish the session from the HELLO connect handshake — the cold-start / login entry point. Opens
   *  the per-user IDB on `userId` (the webdb-open trigger that previously rode the profile fetch) and
   *  returns once it is open, so the caller (the threadlist) can read IDB without waiting on the profile.
   *  The profile gate ({@link gateSelfProfile}) runs async: if the IDB-cached self profile's `profileRev`
   *  matches HELLO's, the cached profile is fresh and the fetch is skipped; otherwise (first boot / stale)
   *  the full profile is fetched + cached. The friend-request badge is derived from HELLO's `friendReqRev`
   *  vs `friendReqAckRev` (both server-state, multi-device consistent). Idempotent for the same user across
   *  reconnects (re-applies both). */
  async establishSession(
    userId: number,
    profileRev: number,
    friendReqRev: number | null,
    friendReqAckRev: number,
  ): Promise<void> {
    if (this.sessionUserId() === userId) {
      // Re-establish on reconnect (same user): the webdb is already open — re-apply the server-state badge
      // pair (the badge re-derives friendReqRev > friendReqAckRev).
      this.applyFriendReqRev(friendReqRev, friendReqAckRev);
      return;
    }
    // Account switch without a logout (defensive): tear down the previous user's DB first.
    if (this.webdbUserKey !== null && this.webdbUserKey !== String(userId)) {
      await this.webdb.closeAndDelete(this.webdbUserKey);
    }
    this.webdbUserKey = String(userId);
    this.sessionUserId.set(userId);
    this.persistLastUserId(userId); // remember for the next boot's eager IDB paint (pre-HELLO)
    await this.webdb.openForUser(String(userId)); // webdb open — callers can now read IDB
    // Apply HELLO's server-state badge pair. Profile gate runs async — the threadlist needs only the open
    // webdb, not the profile.
    this.applyFriendReqRev(friendReqRev, friendReqAckRev);
    void this.gateSelfProfile(userId, profileRev);
  }

  /** Gate the /user/my-profile fetch on the IDB-cached profileRev. Cache hit + fresh → skip the fetch;
   *  cache miss (first boot) or stale → fetch + cache the full profile. */
  private async gateSelfProfile(userId: number, profileRev: number): Promise<void> {
    const cached = (await this.webdb.getMeta('selfProfile')) as User | null | undefined;
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
          id: u.id, name: u.name, avatar: u.avatar, bio: u.bio, domain: u.domain,
        });
      }
    } catch {
      /* best-effort — sessionProfile stays undefined; the UI holds a placeholder until a retry */
    }
  }

  /** Apply the friend-request badge state (from HELLO or a live FRIEND_REQ_REV_UPDATED push). Sets both
   *  server-state signals; the badge re-derives via the `friendReqBadge` computed (friendReqRev > ack). */
  applyFriendReqRev(rev: number | null, ackRev: number): void {
    this.friendReqRev.set(rev);
    this.friendReqAckRev.set(ackRev);
  }

  /** Acknowledge the current friend-request state — the user opened the friend-requests panel. POSTs
   *  /invite/mark-read, which advances the SERVER-side `friendReqAckRev` to the current friendReqRev + pushes
   *  FRIEND_REQ_REV_UPDATED → this client (and every other device) clears the badge. Optimistically clears
   *  locally for snappy UX (the push confirms; on POST failure the next HELLO re-arms it). */
  markFriendReqRead(): void {
    this.friendReqAckRev.set(this.friendReqRev()); // optimistic clear
    this.markInvitesRead().subscribe({ error: () => { /* best-effort — the next HELLO/push re-derives the truth */ } });
  }

  /** A live PROFILE_REV_UPDATED arrived. Skip the echo of THIS device's own edit: the edit component calls
   *  updateSessionProfile() (force re-fetch) right after every avatar/name/bio edit, so sessionProfile
   *  already carries the fresh profileRev by the time the backend's PROFILE_REV_UPDATED echo of that same
   *  edit arrives — a re-fetch would be redundant. Only a NEWER rev (another device/tab's edit) refetches.
   *  (The native layer also merges this into its cached HELLO, so a webview reclaim replays a fresh rev.) */
  invalidateSelfProfile(pushedRev: number): void {
    const cur = this.sessionProfile()?.profileRev;
    if (cur !== undefined && pushedRev <= cur) return; // our own edit echoing back — already applied
    void this.ensureProfile({ force: true }).subscribe({
      error: () => { /* best-effort — the next HELLO/gate re-fetches */ },
    });
  }

  /** Boot-time webdb restore on the persisted {@link LAST_USER_ID_KEY} — opens the per-user IDB and restores
   *  its cached self profile so the threadlist plus self name/avatar can eager-paint BEFORE the SSE/HELLO
   *  round-trip (including an offline cold start). Does NOT set sessionUserId — the session tracker stays
   *  HELLO-driven; {@link establishSession} reconciles on HELLO (idempotent `openForUser` reuse for the same
   *  user, close+reopen on a switch). No-op when no userId was ever persisted (first-ever launch). */
  async restoreWebdb(): Promise<void> {
    const userId = this.readLastUserId();
    if (userId === null) return;
    // Track the open user so clearSession can close it (a pre-HELLO logout) + establishSession can detect
    // a token-swap (close+reopen when HELLO's userId differs from the optimistic lastUserId).
    this.webdbUserKey = String(userId);
    await this.webdb.openForUser(String(userId));
    const cached = (await this.webdb.getMeta('selfProfile')) as User | null | undefined;
    // Validate the partition owner defensively before exposing cached identity data to the UI.
    if (cached?.id === userId) this.sessionProfile.set(cached);
  }

  /** Read the persisted last-logged-in userId, or null when absent / unparseable / storage unavailable. */
  private readLastUserId(): number | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LAST_USER_ID_KEY);
    if (!raw) return null;
    const userId = Number(raw);
    return Number.isFinite(userId) && userId > 0 ? userId : null;
  }

  /** Persist the userId so the next boot's restoreWebdb can open the per-user IDB pre-HELLO. SSR-safe. */
  private persistLastUserId(userId: number): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LAST_USER_ID_KEY, String(userId));
    } catch {
      /* private mode / quota — best-effort; the next boot just awaits HELLO to open the DB */
    }
  }

  /** In-flight profile fetch (dedup): boot calls updateSessionProfile() AND ConversationListService
   *  calls ensureProfile() in the same init batch — without sharing, both would fire /user/my-profile.
   *  Cached here (shareReplay) so concurrent callers ride one HTTP request; once it resolves,
   *  sessionProfile is set and late callers take the short-circuit branch. `force:true` bypasses the
   *  cache (reconnect always re-fetches). */
  private profileFetch?: Observable<User>

  /** Idempotent self-profile get-or-load: returns the cached sessionProfile if already loaded (set by
   *  {@link establishSession} from HELLO, or a prior fetch), else fetches /user/my-profile. `force:true`
   *  re-fetches for live refresh (the NOTIFY FRIEND_REQUEST badge, post-edit re-read, markInvitesRead).
   *  The thread-revision cursor is NOT seeded here — HELLO owns the sole revision source now. */
  ensureProfile(opts?: { force?: boolean }): Observable<User> {
    if (!opts?.force && this.sessionProfile() !== undefined) {
      return of(this.sessionProfile() as User)
    }
    if (!opts?.force && this.profileFetch) {
      return this.profileFetch
    }
    const fetch = this.getMyProfile().pipe(
      map((res) => {
        const u = res.data as User
        this.sessionProfile.set(u)
        // Cache the full self profile so the next cold start's HELLO gating can skip this fetch.
        void this.webdb.putMeta('selfProfile', u)
        // Write-through the partial profile → IDB + trigger avatar refresh when the path changed.
        void this.profileRepo.putProfile(`u${u.id}`, 'user', {
          id: u.id, name: u.name, avatar: u.avatar, bio: u.bio, domain: u.domain,
        })
        return u
      }),
      shareReplay(1),
    )
    if (!opts?.force) this.profileFetch = fetch
    return fetch
  }

  /** Fire-and-forget profile refresh — ALWAYS hits the network (`force: true`), because every caller
   *  wants FRESH data: the NOTIFY FRIEND_REQUEST badge arming, the post-avatar / post-name-bio edit
   *  re-read, and markInvitesRead clearing the badge. A non-force call would short-circuit on the
   *  already-set sessionProfile (`ensureProfile` returns `of(cached)`) and serve stale data — which is
   *  why a live friend request didn't surface the badge, and an avatar/name edit didn't refresh the
   *  rail/drawer, until a full reload. Use ensureProfile() (no force) for the idempotent get-or-load at
   *  boot. threadRevision is unchanged by all these triggers, so re-seeding the cursor is a no-op. */
  updateSessionProfile() {
    this.ensureProfile({ force: true }).subscribe({
      error: (err) => {
        console.error(err)
      },
    })
  }

  /** Seed the thread-revision cursor (from /user/my-profile). */
  seedThreadRevCursor(rev: number): void {
    this._threadRevCursor.set(rev)
  }

  /** Advance the cursor after applying a delta (monotonic — ignore a non-advancing/stale revision). */
  advanceThreadRevCursor(rev: number): void {
    const cur = this._threadRevCursor()
    if (cur === undefined || rev > cur) this._threadRevCursor.set(rev)
  }

  register(params: { account: string, name: string, password: string }) {
    return this.http.post<{ code: number, message: string, data?: { id: number, account: string } }>(`${apiPrefix()}/user/register`,
      params)
  }

  getMyProfile() {
    return this.http.post<StandardResponse<User>>(`${apiPrefix()}/user/my-profile`, {})
  }

  /** Upload and bind the current user's avatar (multipart file → backend rewrites multiple sizes with
   *  sharp). Call updateSessionProfile() afterwards to refresh the local copy. */
  updateAvatar(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ avatar: string }>>(`${apiPrefix()}/user/update-avatar`, fd)
  }

  /** Update the current user's display name / bio. Call updateSessionProfile() afterwards to refresh the
   *  local copy. */
  updateProfile(params: { name?: string, bio?: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix()}/user/update-profile`, params)
  }

  /** One entry of the hydrated thread-list delta from POST /user/query-thread/delta. The server plans
   *  (last-op-wins) + hydrates the ADDs inline (peer/group/unread); DELETE entries carry the threadId
   *  only (the thread is leaving the roster — nothing to render). The client applies a single response —
   *  no client-side planning, no second batch-hydrate round-trip. */
  queryThreadDelta(params: { fromRevision: number; toRevision: number }) {
    return this.http.post<StandardResponse<HydratedThreadDeltaOp[]>>(
      `${apiPrefix()}/user/query-thread/delta`,
      params,
    )
  }

  queryUserInfo(params: { userIds: number[] }) {
    return this.http.post<StandardResponse<User[]>>(`${apiPrefix()}/user/query`, params)
  }

  /** Resolve a user to address in friend ops. `account` alone = local lookup; `account` + `domain` =
   *  federated. The `@` separator is a UI input aid only — the caller (friend-requests search) splits a
   *  typed `alice@bbb.com` into these two fields; the API never carries an @-joined string. */
  resolveUser(params: { account: string; domain?: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix()}/user/resolve`, params)
  }

  /** Local user discovery (fuzzy over account OR display name, case-insensitive). Returns up to 20
   *  LOCAL matches (server excludes federated stubs + soft-deleted; min query length 2). Federated
   *  users are NOT discoverable here — resolve those by exact account + domain via resolveUser. */
  searchUsers(params: { q: string; skip?: number; take?: number }) {
    return this.http.post<StandardResponse<{ list: User[]; total: number }>>(`${apiPrefix()}/user/search`, params)
  }

  /** Pre-flight trust check for a federated handle search: has mutual trust with this peer domain been
   *  established already? Drives the first-contact "Connecting to {domain}…" affordance — shown only
   *  when the server reports the domain untrusted (a handshake IS expected during the resolve), never
   *  guessed from latency. Cheap local allow-list lookup server-side (no network). */
  peerTrustStatus(params: { domain: string }) {
    return this.http.post<StandardResponse<{ trusted: boolean }>>(`${apiPrefix()}/user/peer-trust-status`, params)
  }

  /** Send a friend invite. Federated targets are delivered via S2S automatically. On auto-accept (the
   *  target already invited me back, local-only) data carries threadId instead of inviteId. */
  sendFriendInvite(params: { toUserId: number; note?: string }) {
    return this.http.post<StandardResponse<{ inviteId?: string; threadId?: number }>>(`${apiPrefix()}/invite/friend`, params)
  }

  /** Authoritative relationship/invite state for discovery rows. Server-backed so refreshes and other
   *  devices see the same state; accepts a batch to avoid one request per search result. */
  friendRelationshipStatuses(params: { userIds: number[] }) {
    return this.http.post<StandardResponse<Array<{
      userId: number
      status: 'NONE' | 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'FRIEND'
      inviteId?: string
    }>>>(`${apiPrefix()}/invite/friend-status`, params)
  }

  /** Refresh a peer's avatar/name/bio if stale (chat-open + profile-panel-open hook). Federated: cheap
   *  server-side /revision probe, re-pull + re-localize only when newer; local: authoritative in-DB. Pass
   *  the caller's last-seen `profileRev` for a lightweight ACK-only short-circuit when unchanged. */
  syncPeerProfile(params: { userId: number; sinceProfileRev?: number }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix()}/user/sync-peer-profile`, params)
  }

  /** ACK-only self-profile revision probe used when the profile surface opens. A stale revision causes
   *  PROFILE_REV_UPDATED; the existing SSE handler then pulls /user/my-profile and writes it through IDB. */
  syncSelfProfile(sinceProfileRev: number): void {
    this.http
      .post<StandardResponse<never>>(`${apiPrefix()}/user/sync-self-profile`, { sinceProfileRev })
      .subscribe({ error: () => { /* best-effort — HELLO/reconnect remains the backstop */ } })
  }

  /** Incoming pending friend invites (no params — backend hardcodes last-7-days, ≤200, friends filtered
   *  out). The inviter profile is embedded on each row (fromUser). */
  listIncomingInvites() {
    return this.http.post<StandardResponse<Invite[]>>(`${apiPrefix()}/invite/incoming`, {})
  }

  /** My outgoing pending friend invites (same parameterless shape as incoming). */
  listOutgoingInvites() {
    return this.http.post<StandardResponse<Invite[]>>(`${apiPrefix()}/invite/outgoing`, {})
  }

  /** Accept an invite by id (friend → P2P thread; group → join). data carries the threadId. */
  acceptInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse<{ threadId?: number }>>(`${apiPrefix()}/invite/accept`, params)
  }

  /** Reject an incoming invite by id. */
  rejectInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/invite/reject`, params)
  }

  /** Revoke my own outgoing invite by id. */
  revokeInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/invite/revoke`, params)
  }

  /** Live invite state for the group-invite dialog (validity / already-joined / group identity). */
  getInviteDetail(params: { inviteId: string }) {
    return this.http.post<StandardResponse<InviteDetail>>(`${apiPrefix()}/invite/detail`, params)
  }

  /**
   * Unfriend — end an approved P2P friendship (mutual: the shared thread is soft-left for both sides).
   * On success the caller should drop the thread from the conversation list (removeThread) and close
   * the open chat/profile. Distinct from reject/revoke, which act on a still-pending invite.
   */
  deleteFriend(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/user/delete-friend`, params)
  }

  /** Clear the friend-invite unread badge (the user has viewed the friend-requests panel). */
  markInvitesRead() {
    return this.http.post<StandardResponse>(`${apiPrefix()}/invite/mark-read`, {})
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<StandardResponse<ConversationItem>>(`${apiPrefix()}/user/thread-info`, params)
  }

  /**
   * Mark a conversation read up to (and including) `lastReadSeq` — the per-thread seq of the newest message
   * the client knows (the item's `lastMessageSeq` on open, or a live NEW_MESSAGE's seq while the chatbox is
   * open). `lastReadSeq` is REQUIRED: every caller passes it (mark-read never uses the backend's no-seq
   * "mark all current" fallback). Fires the per-user read-cursor advance (mirrors the backend MarkReadDto).
   */
  markRead(params: { threadId: number, lastReadSeq: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/thread/mark-read`, params)
  }

  /**
   * Block / unblock a user (P2P). Independent of friendship — the message path drops delivery and the
   * blocker's query-messages hides the blocked creator's messages. `block: true` blocks, `false` unblocks.
   */
  setBlock(params: { userId: number, block: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/user/block`, params)
  }

}

/** Avatar edge sizes (aligned with the backend UploadService.AVATAR_SIZES). */
const AVATAR_SIZES = [32, 64, 128, 256, 512] as const
export type AvatarSize = (typeof AVATAR_SIZES)[number]

/**
 * Derive a multi-size avatar URL: swap the representative URL (/uploads/<base>-512.webp) for the requested
 * size. Returns the input unchanged when base is empty or not a local multi-size image (regex miss), so a
 * default avatar can fall through.
 */
export function avatarUrl(base: string | undefined | null, size: AvatarSize): string {
  return base && AVATAR_SIZES.includes(size)
    ? base.replace(/-\d+\.webp$/, `-${size}.webp`)
    : (base ?? '')
}

/**
 * localStorage keys holding USER-SCOPED client-only data (no server copy) — cleared on logout so a
 * second account on the same browser never sees the previous one's folders / emoji recents. This mirrors
 * the IDB purge-on-logout (the per-user DB is closed + deleted): local cache is wiped, rebuilt from
 * scratch on the next login. NOTE these are client-only — clearing is permanent (even for the same user
 * re-logging in), which is the chosen trade-off for account isolation.
 *
 * Deliberately NOT cleared (device-level preferences, shared across accounts on this browser): theme,
 * language, the desktop list-pane width, the media-size threshold, `device_id`, and `is_keep_login`.
 */
const USER_SCOPED_LS_KEYS = ['soms.chatFolders', 'soms.chat.emojiRecents', LAST_USER_ID_KEY]

/** Remove every user-scoped localStorage key (logout / account switch). SSR/prerender-safe. */
export function clearUserScopedLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  for (const k of USER_SCOPED_LS_KEYS) {
    try { localStorage.removeItem(k) } catch { /* private-mode / quota — best-effort */ }
  }
}
