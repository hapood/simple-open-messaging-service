import { Injectable, signal, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subscription, of, map, shareReplay } from 'rxjs';
import { apiPrefix } from './constants';
import { User, QueryUserThreadParams, ConversationItem, MessageThreadType, Invite, InviteDetail, StandardResponse } from './model'
import { ThreadDeltaOp } from './thread-delta'
import { WebdbService } from './webdb.service'
import { ProfileRepository } from './profile-store.service'

export type { User } from './model'

@Injectable({
  providedIn: 'root',
})
export class UserService {
  sessionProfile = signal<User | undefined>(undefined)

  /** The client's applied thread-list revision cursor — the `threadRevision` from /user/my-profile,
   *  advanced after each THREAD_REVISION_UPDATED delta is applied. Lives here (not in
   *  ConversationListService) so `queryUserThreadValid` can pin snapshot queries to the LIVE cursor
   *  (the boot-time sessionProfile.threadRevision goes stale as deltas land), and ConversationListService
   *  (which injects this service) can read/advance it without a circular DI. In-memory only — seeded
   *  fresh each boot/reconnect; not persisted (the list itself is loaded fresh each session). */
  private readonly _threadRevCursor = signal<number | undefined>(undefined)
  readonly threadRevCursor = this._threadRevCursor.asReadonly()

  private readonly webdb = inject(WebdbService)
  private readonly profileRepo = inject(ProfileRepository)
  /** The user key whose DB is currently open (or null) — tracks the lifecycle effect below. */
  private webdbUserKey: string | null = null

  constructor(private http: HttpClient) {
    // Per-user DB lifecycle: open on login, close+delete on logout/switch. UserService owns the session,
    // so it owns the DB partitioned by sessionProfile().id (WebdbService itself is pure storage).
    effect(() => {
      const id = this.sessionProfile()?.id
      const idKey = id != null ? String(id) : null
      if (idKey === this.webdbUserKey) return
      const previous = this.webdbUserKey
      this.webdbUserKey = idKey
      if (previous != null) void this.webdb.closeAndDelete(previous)
      if (idKey != null) void this.webdb.openForUser(idKey)
    })
  }

  /** Tear down the in-memory session (logout). Clears sessionProfile → the lifecycle effect closes +
   *  deletes this user's DB; a fresh ensureProfile() re-fetches on the next login. */
  clearSession(): void {
    this.sessionProfile.set(undefined)
    this._threadRevCursor.set(undefined)
    this.profileFetch = undefined
  }

  /** In-flight profile fetch (dedup): boot calls updateSessionProfile() AND ConversationListService
   *  calls ensureProfile() in the same init batch — without sharing, both would fire /user/my-profile.
   *  Cached here (shareReplay) so concurrent callers ride one HTTP request; once it resolves,
   *  sessionProfile is set and late callers take the short-circuit branch. `force:true` bypasses the
   *  cache (reconnect always re-fetches). */
  private profileFetch?: Observable<User>

  /** Idempotent self-profile load: returns the cached sessionProfile if already loaded, else fetches
   *  /user/my-profile (seeding sessionProfile + the thread-revision cursor). `force:true` re-fetches
   *  (reconnect — re-seed the cursor to the server's current threadRevision after a gap that may have
   *  missed add/delete signals). ConversationListService.load() awaits this so the snapshot is pinned
   *  to a real cursor, not the pre-seed default. */
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
        this.seedThreadRevCursor(u.threadRevision ?? 0)
        // Write-through the self profile → IDB + trigger avatar refresh when the path changed.
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

  /** Fire-and-forget profile refresh (boot + NOTIFY FRIEND_REQUEST badge). Seeds the cursor as a side
   *  effect. Prefer ensureProfile() for callers that need to await the load. */
  updateSessionProfile() {
    this.ensureProfile().subscribe({
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
    return this.http.post<{ code: number, message: string, data?: { id: number, account: string } }>(`${apiPrefix}/user/register`,
      params)
  }

  getMyProfile() {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/my-profile`, {})
  }

  /** Upload and bind the current user's avatar (multipart file → backend rewrites multiple sizes with
   *  sharp). Call updateSessionProfile() afterwards to refresh the local copy. */
  updateAvatar(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ avatar: string }>>(`${apiPrefix}/user/update-avatar`, fd)
  }

  /** Update the current user's display name / bio. Call updateSessionProfile() afterwards to refresh the
   *  local copy. */
  updateProfile(params: { name?: string, bio?: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/update-profile`, params)
  }

  /** Query a page of active conversations. `revision` (REQUIRED by the backend — pins membership to
   *  "active at R") is auto-injected from the live thread-revision cursor so callers (list load, folder
   *  editor, friend-picker) don't each have to source it. The `Omit` keeps the param type stable even
   *  if api-types is later regenerated with `revision` required. */
  queryUserThreadValid(params: Omit<QueryUserThreadParams, 'revision'> & { revision?: number }) {
    const revision = params.revision ?? this.threadRevCursor() ?? 0
    return this.http.post<StandardResponse<ConversationItem[]>>(
      `${apiPrefix}/user/query-thread/valid`,
      { ...params, revision },
    )
  }

  /** Pull the thread-list ADD/DELETE ops in the half-open range `(fromRevision, toRevision]` — the
   *  delta the client applies on a `THREAD_REVISION_UPDATED { revision }` signal. `fromRevision` = the
   *  client's current cursor (exclusive); `toRevision` = the signal's revision (inclusive). Returned
   *  ordered by revision asc. See thread-delta.ts (`planDelta`) for the apply semantics. */
  queryThreadDelta(params: { fromRevision: number; toRevision: number }) {
    return this.http.post<StandardResponse<ThreadDeltaOp[]>>(
      `${apiPrefix}/user/query-thread/delta`,
      params,
    )
  }

  /**
   * Collect the FULL thread set by paging query-thread/valid — the endpoint is offset-paginated with a
   * hard @Max(50) per request (QueryValidThreadDto), so a single call can never return more than 50.
   * Used by features that filter the complete set client-side (conversation list, folder editor).
   *
   * Emits once with the accumulated list (recent-first), then completes. The backend returns each page
   * recent-first but pages are ordered by id, so the combined list is re-sorted here by lastMessageAt
   * desc (threadId asc tiebreak, null sinks) to match the single-request ordering the list view expects.
   * Stops at the first short page (exhaustion) or HARD_CEILING. On a mid-stream server/network error,
   * emits whatever was collected so far, then errors — callers that only read `next` still get a partial
   * list, error-aware callers can surface the failure.
   */
  queryAllUserThreads(opts?: { type?: MessageThreadType }): Observable<ConversationItem[]> {
    // Backend QueryValidThreadDto @Max(50); the endpoint has no hasMore, so a short page signals exhaustion.
    const PAGE = 50
    const HARD_CEILING = 500
    return new Observable<ConversationItem[]>((sub) => {
      const acc: ConversationItem[] = []
      let skip = 0
      let done = false
      let inner: Subscription | undefined

      const finish = (err?: unknown) => {
        if (done) return
        done = true
        acc.sort(recentFirst)
        sub.next(acc)
        if (err) sub.error(err); else sub.complete()
      }

      const loadPage = () => {
        if (done) return
        inner = this.queryUserThreadValid({ take: PAGE, skip, type: opts?.type }).subscribe({
          next: (res) => {
            if (res.code !== 0) { finish(new Error(res.message || 'Failed to load chats')); return }
            const page = res.data ?? []
            acc.push(...page)
            if (page.length < PAGE || acc.length >= HARD_CEILING) { finish(); return }
            skip += page.length
            loadPage()
          },
          error: (err) => finish(err),
        })
      }
      loadPage()

      // Teardown: stop paging and release the in-flight subscription.
      return () => { done = true; inner?.unsubscribe() }
    })
  }

  queryUserInfo(params: { userIds: number[] }) {
    return this.http.post<StandardResponse<User[]>>(`${apiPrefix}/user/query`, params)
  }

  /** Resolve a user to address in friend ops. `account` alone = local lookup; `account` + `domain` =
   *  federated. The `@` separator is a UI input aid only — the caller (friend-requests search) splits a
   *  typed `alice@bbb.com` into these two fields; the API never carries an @-joined string. */
  resolveUser(params: { account: string; domain?: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/resolve`, params)
  }

  /** Local user discovery (fuzzy over account OR display name, case-insensitive). Returns up to 20
   *  LOCAL matches (server excludes federated stubs + soft-deleted; min query length 2). Federated
   *  users are NOT discoverable here — resolve those by exact account + domain via resolveUser. */
  searchUsers(params: { q: string; skip?: number; take?: number }) {
    return this.http.post<StandardResponse<{ list: User[]; total: number }>>(`${apiPrefix}/user/search`, params)
  }

  /** Pre-flight trust check for a federated handle search: has mutual trust with this peer domain been
   *  established already? Drives the first-contact "Connecting to {domain}…" affordance — shown only
   *  when the server reports the domain untrusted (a handshake IS expected during the resolve), never
   *  guessed from latency. Cheap local allow-list lookup server-side (no network). */
  peerTrustStatus(params: { domain: string }) {
    return this.http.post<StandardResponse<{ trusted: boolean }>>(`${apiPrefix}/user/peer-trust-status`, params)
  }

  /** Send a friend invite. Federated targets are delivered via S2S automatically. On auto-accept (the
   *  target already invited me back, local-only) data carries threadId instead of inviteId. */
  sendFriendInvite(params: { toUserId: number; note?: string }) {
    return this.http.post<StandardResponse<{ inviteId?: string; threadId?: number }>>(`${apiPrefix}/invite/friend`, params)
  }

  /** Refresh a peer's avatar/name/bio if stale (chat-open + profile-panel-open hook). Federated: cheap
   *  server-side /revision probe, re-pull + re-localize only when newer; local: authoritative in-DB. Pass
   *  the caller's last-seen peer updatedAt as `sinceUpdatedAt` for a lightweight data:null short-circuit
   *  when unchanged — no payload, no re-render. */
  syncPeerProfile(params: { userId: number; sinceUpdatedAt?: number }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/sync-peer-profile`, params)
  }

  /** Incoming pending friend invites (no params — backend hardcodes last-7-days, ≤200, friends filtered
   *  out). The inviter profile is embedded on each row (fromUser). */
  listIncomingInvites() {
    return this.http.post<StandardResponse<Invite[]>>(`${apiPrefix}/invite/incoming`, {})
  }

  /** My outgoing pending friend invites (same parameterless shape as incoming). */
  listOutgoingInvites() {
    return this.http.post<StandardResponse<Invite[]>>(`${apiPrefix}/invite/outgoing`, {})
  }

  /** Accept an invite by id (friend → P2P thread; group → join). data carries the threadId. */
  acceptInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse<{ threadId?: number }>>(`${apiPrefix}/invite/accept`, params)
  }

  /** Reject an incoming invite by id. */
  rejectInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/invite/reject`, params)
  }

  /** Revoke my own outgoing invite by id. */
  revokeInvite(params: { inviteId: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/invite/revoke`, params)
  }

  /** Live invite state for the group-invite dialog (validity / already-joined / group identity). */
  getInviteDetail(params: { inviteId: string }) {
    return this.http.post<StandardResponse<InviteDetail>>(`${apiPrefix}/invite/detail`, params)
  }

  /**
   * Unfriend — end an approved P2P friendship (mutual: the shared thread is soft-left for both sides).
   * On success the caller should drop the thread from the conversation list (removeThread) and close
   * the open chat/profile. Distinct from reject/revoke, which act on a still-pending invite.
   */
  deleteFriend(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/delete-friend`, params)
  }

  /** Clear the friend-invite unread badge (the user has viewed the friend-requests panel). */
  markInvitesRead() {
    return this.http.post<StandardResponse>(`${apiPrefix}/invite/mark-read`, {})
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<StandardResponse<ConversationItem>>(`${apiPrefix}/user/thread-info`, params)
  }

  /**
   * Mark a conversation read. Omit lastReadMessageId to mark all current messages read; pass it to
   * mark read up to (and including) a specific message. Fires the per-user read-cursor advance.
   */
  markRead(params: { threadId: number, lastReadMessageId?: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/thread/mark-read`, params)
  }

  /**
   * Block / unblock a user (P2P). Independent of friendship — the message path drops delivery and the
   * blocker's query-messages hides the blocked creator's messages. `block: true` blocks, `false` unblocks.
   */
  setBlock(params: { userId: number, block: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/block`, params)
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
 * Sort conversations recent-first: lastMessageAt desc (null/empty threads sink to the bottom),
 * threadId asc as a deterministic tiebreak. Mirrors the backend queryValidThread in-memory sort, used
 * after client-side pagination recombines pages that were each recent-first but globally id-ordered.
 */
function recentFirst(a: ConversationItem, b: ConversationItem): number {
  const ta = a.lastMessageAt ?? -Infinity
  const tb = b.lastMessageAt ?? -Infinity
  return tb - ta || a.threadId - b.threadId
}
