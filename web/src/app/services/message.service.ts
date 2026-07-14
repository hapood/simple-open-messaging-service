import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Message, QueryMessageLogParams, StandardResponse } from './model'
import { apiPrefix } from './constants';

@Injectable({
  providedIn: 'root'
})
export class MsgService {
  constructor(private http: HttpClient) { }

  addUser(params: { account: string, password: string }) {
    return this.http.post(`${apiPrefix()}/add-user`, params)
  }

  addFriend(account: string) {
    return this.http.post(`${apiPrefix()}/add-friend`, { account })
  }

  sendMessage(params: { threadId: number, content: string, contentType?: string, clientMessageId?: string }) {
    return this.http.post<StandardResponse<{ id: string, createAt: string }>>(`${apiPrefix()}/send-message`, params)
  }

  /**
   * Stage a media message BEFORE its upload: the server creates a PendingMedia row keyed by
   * `clientMessageId` (+ the client-probed display meta) — durable intent recorded before the file
   * write, so a crash between staging and upload leaves a reclaimable record, never an orphan. No
   * Message or seq is created yet. The caller follows this with the matching upload() carrying the
   * same clientMessageId, which writes the file and promotes the stage to a real Message (confirmed
   * via the NEW_MESSAGE SSE echo keyed by clientMessageId).
   */
  sendMedia(params: {
    threadId: number,
    contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO',
    clientMessageId: string,
    meta?: { w?: number, h?: number, duration?: number },
  }) {
    return this.http.post<StandardResponse<{ clientMessageId: string }>>(`${apiPrefix()}/send-media`, params)
  }

  /** Upload an image (multipart: file + width/height), returns {url,w,h}. w/h are read client-side via
   *  createImageBitmap and sent along. When `clientMessageId` is set (a prior POST /send-media staged
   *  this send), the server promotes the staged send to a real Message after the upload. */
  uploadMedia(file: File, w: number, h: number, clientMessageId?: string) {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('w', String(w))
    fd.append('h', String(h))
    return this.http.post<StandardResponse<{ url: string, w: number, h: number }>>(
      `${apiPrefix()}/upload`,
      fd,
      clientMessageId ? { headers: this.cmidHeader(clientMessageId) } : undefined,
    )
  }

  /**
   * Upload a generic file (multipart: file), returns the server-generated {url,name,size,mimeType}, used verbatim
   * as the FILE message content. observe:'events' + reportProgress let callers render upload progress
   * (HttpProgressEvent); the final response body arrives in the last HttpResponse event. The mimetype allowlist
   * and size cap for POST /upload/file are enforced by the backend.
   */
  uploadFile(file: File, clientMessageId?: string) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix()}/upload/file`,
      fd,
      {
        reportProgress: true,
        observe: 'events',
        ...(clientMessageId ? { headers: this.cmidHeader(clientMessageId) } : {}),
      },
    )
  }

  /** Upload a video (multipart: file). The server validates only the container family via magic bytes
   *  (no probe/extract); w/h/duration are NOT sent here — they are client-probed via <video>
   *  loadedmetadata and ride in the staged send's meta. Returns {url,name,size,mimeType}. When
   *  `clientMessageId` is set, the upload promotes a staged send to a real Message. */
  uploadVideo(file: File, clientMessageId?: string) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix()}/upload/video`,
      fd,
      clientMessageId ? { headers: this.cmidHeader(clientMessageId) } : undefined,
    )
  }

  /** Upload an audio clip (multipart: file). Same contract as uploadVideo (magic-byte check only);
   *  duration is client-probed and carried in the staged send's meta. When `clientMessageId` is set,
   *  the upload promotes a staged send to a real Message. */
  uploadAudio(file: File, clientMessageId?: string) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix()}/upload/audio`,
      fd,
      clientMessageId ? { headers: this.cmidHeader(clientMessageId) } : undefined,
    )
  }

  /** The header that tells an upload route to promote a staged send after writing the file. */
  private cmidHeader(clientMessageId: string): HttpHeaders {
    return new HttpHeaders({ 'x-client-message-id': clientMessageId })
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<StandardResponse<Message[]>>(`${apiPrefix()}/query-messages`, params)
  }

  /** Resolve the P2P thread with a peer user — returns { threadId } when friends, THREAD_NOT_FOUND otherwise. */
  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<{ threadId: number }>>(`${apiPrefix()}/thread/by-user-id`, params)
  }

  /** Mute / unmute a conversation (suppresses notifications, not delivery). */
  setMuted(params: { threadId: number, muted: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/thread/set-muted`, params)
  }

  /** Pin / unpin a conversation (pinned-first ordering). */
  setPinned(params: { threadId: number, pinned: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/thread/set-pinned`, params)
  }

  /** Per-user "clear chat history" — hides all messages up to now for the caller; peer copy untouched. */
  clearHistory(params: { threadId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/thread/clear-history`, params)
  }

  /** Set a per-user alias/remark for a conversation — overrides the displayed name for the caller.
   *  An empty string clears it. */
  setAlias(params: { threadId: number, alias?: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix()}/thread/set-alias`, params)
  }

  /**
   * Substring search over a conversation's text history. Returns lightweight {id, createdAt} matches
   * (no bodies) keyset-paginated by id desc — the client jumps the kernel to each id and renders the
   * bubble via the normal query path on demand. `lastSeq` is the seq cursor for the next page.
   */
  searchMessages(params: { threadId: number, keyword: string, take: number, lastSeq?: number }) {
    return this.http.post<StandardResponse<{ seq: number, createdAt: number }[]>>(
      `${apiPrefix()}/search-messages`,
      params,
    )
  }

  /** Manually re-run federated media localize for one message — the detail-view retry after a localize
   *  failure left the media inert. Idempotent (already-local digests skip the fetch, no quota burn).
   *  Returns the post-localize status ('ready' = bytes local | 'failed' = still missing). */
  relocalizeMedia(threadId: number, seq: number) {
    return this.http.post<StandardResponse<{ status: 'ready' | 'failed' }>>(
      `${apiPrefix()}/relocalize-media`,
      { threadId, seq },
    )
  }

  /** Bulk-probe federated media localize status for a set of messages — the scroll backstop for
   *  MEDIA_STATUS frames the client missed while disconnected. Returns {seq, status, sv} per existing seq. */
  queryMediaStatus(threadId: number, seqs: number[]) {
    return this.http.post<StandardResponse<{ statuses: Array<{ seq: number; status: 'ready' | 'failed'; sv: number }> }>>(
      `${apiPrefix()}/media-status`,
      { threadId, seqs },
    )
  }
}