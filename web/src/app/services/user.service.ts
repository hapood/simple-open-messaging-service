import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import { apiPrefix } from './constants';
import { User, QueryUserThreadParams, ConversationItem, MessageThreadType, FriendshipWithPeer, StandardResponse } from './model'

export type { User } from './model'

@Injectable({
  providedIn: 'root',
})
export class UserService {
  sessionProfile = signal<User | undefined>(undefined)
  constructor(private http: HttpClient) {
  }

  updateSessionProfile() {
    this.getMyProfile().subscribe({
      next: res => {
        this.sessionProfile.set(res.data)
      },
      error: (err) => {
        console.error(err)
      }
    })
  }

  register(params: { uniqName: string, password: string }) {
    return this.http.post<{ code: number, message: string, data?: { id: number, uniqName: string } }>(`${apiPrefix}/user/register`,
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

  queryUserThreadValid(params: QueryUserThreadParams) {
    return this.http.post<StandardResponse<ConversationItem[]>>(`${apiPrefix}/user/query-thread/valid`, params)
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

  getUserInfoByUniqName(params: { uniqName: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/by-uniq-name`, params)
  }

  sendFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/send-friend-request`, params)
  }

  queryToPending(params: {
    take: number, beforeDate: number
  }) {
    return this.http.post<StandardResponse<FriendshipWithPeer[]>>(`${apiPrefix}/user/query-thread/to-pending`, params)
  }

  queryFromPending(params: {
    take: number, beforeDate: number
  }) {
    return this.http.post<StandardResponse<FriendshipWithPeer[]>>(`${apiPrefix}/user/query-thread/from-pending`, params)
  }

  approveFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/approve-friend-request`, params)
  }

  declineFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/decline-friend-request`, params)
  }

  cancelFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/cancel-friend-request`, params)
  }

  /**
   * Unfriend — end an approved P2P friendship (mutual: the shared thread is deleted for both sides).
   * On success the caller should drop the thread from the conversation list (removeThread) and close
   * the open chat/profile. Distinct from decline/cancel, which act on a still-pending request.
   */
  deleteFriend(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/delete-friend`, params)
  }

  /** Clear the friend-request unread marker (the user has viewed the friend-requests panel; writing it
   *  back dismisses the badge). */
  markFriendReqRead() {
    return this.http.post<StandardResponse>(`${apiPrefix}/notify/mark-friend-req-read`, {})
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
