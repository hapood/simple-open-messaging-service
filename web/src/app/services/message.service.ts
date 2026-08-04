import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpContext,
  HttpEventType,
  HttpHeaders,
  HttpResponse,
} from '@angular/common/http';
import { defer, filter, firstValueFrom, map, tap, type Observable } from 'rxjs';
import { Message, QueryMessageLogParams, StandardResponse } from './model';
import { apiPrefix } from './constants';
import { isTauri, listenEvent, tauriInvoke } from './runtime';
import { REPLAY_SAFE } from '../request-context';
import type { ForwardWireClosure } from '../components/forward-detail/forward-bundle.model';

export type UploadProgressHandler = (loaded: number, total: number) => void;

interface ResumableUploadState {
  uploadId: string;
  clientMessageId: string;
  totalBytes: number;
  offset: number;
  chunkSize: number;
  status: 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'ABORTED';
  result?: Record<string, unknown>;
}

@Injectable({
  providedIn: 'root',
})
export class MsgService {
  private readonly streamProgressHandlers = new Map<
    string,
    UploadProgressHandler
  >();
  private streamProgressListener?: Promise<void>;

  constructor(private http: HttpClient) {}

  addUser(params: { account: string; password: string }) {
    return this.http.post(`${apiPrefix()}/add-user`, params);
  }

  addFriend(account: string) {
    return this.http.post(`${apiPrefix()}/add-friend`, { account });
  }

  sendMessage(params: {
    threadId: number;
    content: string;
    contentType?: 'PURE_TEXT' | 'LINK';
    clientMessageId?: string;
  }) {
    return this.http.post<StandardResponse<{ id: string; createAt: string }>>(
      `${apiPrefix()}/send-message`,
      params,
      params.clientMessageId
        ? { context: new HttpContext().set(REPLAY_SAFE, true) }
        : undefined,
    );
  }

  /**
   * Ask the server to snapshot messages the caller can currently see and attach the immutable bundle
   * to a new FORWARD message in the destination thread. A clientMessageId is mandatory because the
   * forwarding dialog may target several conversations and each independent send must be safely
   * retryable by the HTTP replay layer.
   */
  sendForward(params: {
    threadId: number;
    sourceMessages: ReadonlyArray<{ threadId: number; seq: number }>;
    mode: 'DIRECT' | 'HISTORY';
    clientMessageId: string;
  }) {
    return this.http.post<StandardResponse<Message>>(
      `${apiPrefix()}/send-forward`,
      params,
      { context: new HttpContext().set(REPLAY_SAFE, true) },
    );
  }

  getForwardBundle(bundleId: string) {
    return this.http.get<StandardResponse<ForwardWireClosure>>(
      `${apiPrefix()}/forward-bundles/${encodeURIComponent(bundleId)}`,
    );
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
    threadId: number;
    contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO';
    clientMessageId: string;
    meta?: { w?: number; h?: number; duration?: number };
    retry?: boolean;
  }) {
    return this.http.post<StandardResponse<{ clientMessageId: string }>>(
      `${apiPrefix()}/send-media`,
      params,
      { context: new HttpContext().set(REPLAY_SAFE, true) },
    );
  }

  queryMediaStages(threadId: number) {
    return this.http.post<
      StandardResponse<
        Array<{
          clientMessageId: string;
          contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO';
          content: string;
          status: 'pending' | 'failed';
          failReason: string | null;
          createdAt: string;
          updatedAt: string;
        }>
      >
    >(`${apiPrefix()}/query-media-stages`, { threadId });
  }

  /** Upload an image (multipart: file + width/height), returns {url,w,h}. w/h are read client-side via
   *  createImageBitmap and sent along. When `clientMessageId` is set (a prior POST /send-media staged
   *  this send), the server promotes the staged send to a real Message after the upload. */
  uploadMedia(
    file: File,
    w: number,
    h: number,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Observable<StandardResponse<{ url: string; w: number; h: number }>> {
    if (clientMessageId) {
      return defer(() =>
        this.resumableUpload<{ url: string; w: number; h: number }>(
          file,
          clientMessageId,
          onProgress,
        ),
      );
    }
    if (this.canStream(file)) {
      return defer(() =>
        this.streamUpload<{ url: string; w: number; h: number }>(
          file,
          '/upload',
          { w: String(w), h: String(h) },
          clientMessageId,
          onProgress,
        ),
      );
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('w', String(w));
    fd.append('h', String(h));
    return this.httpUpload<
      StandardResponse<{ url: string; w: number; h: number }>
    >(`${apiPrefix()}/upload`, fd, clientMessageId, onProgress);
  }

  /**
   * Upload a generic file (multipart: file), returns the server-generated {url,name,size,mimeType}, used verbatim
   * as the FILE message content. The mimetype allowlist and size cap for POST /upload/file are enforced by
   * the backend. `onProgress` receives byte progress from Angular upload events in browser/Android and
   * from the Rust ReaderStream event bridge on Tauri desktop.
   */
  uploadFile(
    file: File,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Observable<
    StandardResponse<{
      url: string;
      name: string;
      size: number;
      mimeType: string;
    }>
  > {
    if (clientMessageId) {
      return defer(() =>
        this.resumableUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
        }>(file, clientMessageId, onProgress),
      );
    }
    if (this.canStream(file)) {
      return defer(() =>
        this.streamUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
        }>(file, '/upload/file', {}, clientMessageId, onProgress),
      );
    }
    const fd = new FormData();
    fd.append('file', file);
    return this.httpUpload<
      StandardResponse<{
        url: string;
        name: string;
        size: number;
        mimeType: string;
      }>
    >(`${apiPrefix()}/upload/file`, fd, clientMessageId, onProgress);
  }

  /** Upload a video (multipart: file). The server validates only the container family via magic bytes
   *  (no probe/extract); w/h/duration are NOT sent here — they are client-probed via <video>
   *  loadedmetadata and ride in the staged send's meta. Returns {url,name,size,mimeType}. When
   *  `clientMessageId` is set, the upload promotes a staged send to a real Message. */
  uploadVideo(
    file: File,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Observable<
    StandardResponse<{
      url: string;
      name: string;
      size: number;
      mimeType: string;
    }>
  > {
    if (clientMessageId) {
      return defer(() =>
        this.resumableUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
        }>(file, clientMessageId, onProgress),
      );
    }
    if (this.canStream(file)) {
      return defer(() =>
        this.streamUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
        }>(file, '/upload/video', {}, clientMessageId, onProgress),
      );
    }
    const fd = new FormData();
    fd.append('file', file);
    return this.httpUpload<
      StandardResponse<{
        url: string;
        name: string;
        size: number;
        mimeType: string;
      }>
    >(`${apiPrefix()}/upload/video`, fd, clientMessageId, onProgress);
  }

  /** Upload an audio clip (multipart: file). Same contract as uploadVideo (magic-byte check only);
   *  duration is client-probed and carried in the staged send's meta. When `clientMessageId` is set,
   *  the upload promotes a staged send to a real Message. */
  uploadAudio(
    file: File,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Observable<
    StandardResponse<{
      url: string;
      name: string;
      size: number;
      mimeType: string;
      /** True only when the staged AUDIO intent was durably promoted to a Message row. */
      promoted: boolean;
    }>
  > {
    if (clientMessageId) {
      return defer(async () => {
        const response = await this.resumableUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
        }>(file, clientMessageId, onProgress);
        return {
          ...response,
          data: response.data
            ? { ...response.data, promoted: true }
            : undefined,
        } as StandardResponse<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
          promoted: boolean;
        }>;
      });
    }
    if (this.canStream(file)) {
      return defer(() =>
        this.streamUpload<{
          url: string;
          name: string;
          size: number;
          mimeType: string;
          promoted: boolean;
        }>(file, '/upload/audio', {}, clientMessageId, onProgress),
      );
    }
    const fd = new FormData();
    fd.append('file', file);
    return this.httpUpload<
      StandardResponse<{
        url: string;
        name: string;
        size: number;
        mimeType: string;
        promoted: boolean;
      }>
    >(`${apiPrefix()}/upload/audio`, fd, clientMessageId, onProgress);
  }

  /** True when the upload can stream from disk: the Tauri DESKTOP shell, where Tauri's `<input type=file>`
   *  handling injects the real on-disk path as `File.path`. Otherwise (browser; Android — no `File.path`)
   *  the File is an in-memory blob with no path → fall back to HttpClient (buffered, same as before — no
   *  regression; the api:// proxy buffers, but there's no disk path to stream from). */
  private canStream(file: File): boolean {
    return isTauri() && typeof (file as { path?: string }).path === 'string';
  }

  /** Stream-upload a file via the Rust `upload_stream_file` command, which reads + sends it in chunks
   *  straight from disk (peak memory = one chunk, NOT the whole file — the api:// URI-scheme proxy can't
   *  do this: Tauri hands it a fully-buffered `Request<Vec<u8>>` at the IPC boundary). `endpoint` is the
   *  path SUFFIX after /api/v1 (e.g. '/upload/video'); `fields` are extra form fields (w/h). Returns the
   *  raw {code,message,data} envelope so callers read it exactly like the HttpClient response. */
  private async streamUpload<T>(
    file: File,
    endpoint: string,
    fields: Record<string, string>,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Promise<StandardResponse<T>> {
    if (clientMessageId && onProgress) {
      await this.ensureStreamProgressListener();
      this.streamProgressHandlers.set(clientMessageId, onProgress);
    }
    try {
      return await tauriInvoke<StandardResponse<T>>('upload_stream_file', {
        path: (file as { path?: string }).path,
        endpoint,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        fields,
        clientMessageId: clientMessageId ?? null,
      });
    } finally {
      if (clientMessageId) this.streamProgressHandlers.delete(clientMessageId);
    }
  }

  private ensureStreamProgressListener(): Promise<void> {
    if (this.streamProgressListener) return this.streamProgressListener;
    this.streamProgressListener = listenEvent<{
      clientMessageId: string;
      loaded: number;
      total: number;
    }>('upload-progress', ({ payload }) => {
      this.streamProgressHandlers.get(payload.clientMessageId)?.(
        Math.max(0, payload.loaded),
        Math.max(0, payload.total),
      );
    }).then(() => undefined);
    return this.streamProgressListener;
  }

  private httpUpload<T>(
    url: string,
    body: FormData,
    clientMessageId?: string,
    onProgress?: UploadProgressHandler,
  ): Observable<T> {
    if (!onProgress) {
      return this.http.post<T>(
        url,
        body,
        clientMessageId
          ? {
              headers: this.cmidHeader(clientMessageId),
              context: new HttpContext().set(REPLAY_SAFE, true),
            }
          : undefined,
      );
    }
    return this.http
      .post<T>(url, body, {
        headers: clientMessageId ? this.cmidHeader(clientMessageId) : undefined,
        context: clientMessageId
          ? new HttpContext().set(REPLAY_SAFE, true)
          : undefined,
        observe: 'events',
        reportProgress: true,
      })
      .pipe(
        tap((event) => {
          if (event.type !== HttpEventType.UploadProgress) return;
          onProgress(event.loaded, event.total ?? bodyFileSize(body));
        }),
        filter(
          (event): event is HttpResponse<T> => event instanceof HttpResponse,
        ),
        map((event) => event.body as T),
      );
  }

  /** Sequential resumable upload. Session state lives on the server; retrying this method first
   * recovers its authoritative offset, with offset=0 naturally meaning a fresh upload. */
  private async resumableUpload<T>(
    file: File,
    clientMessageId: string,
    onProgress?: UploadProgressHandler,
  ): Promise<StandardResponse<T>> {
    const init = await firstValueFrom(
      this.http.post<StandardResponse<ResumableUploadState>>(
        `${apiPrefix()}/uploads/resumable/init`,
        {
          clientMessageId,
          originalName: file.name || 'attachment',
          mimeType: file.type || 'application/octet-stream',
          totalBytes: file.size,
        },
        { context: new HttpContext().set(REPLAY_SAFE, true) },
      ),
    );
    if (init.code !== 0 || !init.data)
      throw new Error(init.message || 'upload init failed');
    let state = await firstValueFrom(
      this.http.get<StandardResponse<ResumableUploadState>>(
        `${apiPrefix()}/uploads/resumable/${encodeURIComponent(init.data.uploadId)}`,
        { context: new HttpContext().set(REPLAY_SAFE, true) },
      ),
    );
    if (state.code !== 0 || !state.data)
      throw new Error(state.message || 'upload status failed');
    let current = state.data;
    onProgress?.(current.offset, file.size);
    while (current.status === 'UPLOADING' && current.offset < file.size) {
      const end = Math.min(current.offset + current.chunkSize, file.size);
      const chunk = file.slice(current.offset, end);
      const response = await firstValueFrom(
        this.http.put<StandardResponse<ResumableUploadState>>(
          `${apiPrefix()}/uploads/resumable/${encodeURIComponent(current.uploadId)}`,
          chunk,
          {
            headers: new HttpHeaders({
              'Content-Type': 'application/octet-stream',
              'Content-Range': `bytes ${current.offset}-${end - 1}/${file.size}`,
            }),
          },
        ),
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(response.message || 'upload chunk failed');
      }
      current = response.data;
      onProgress?.(current.offset, file.size);
    }
    if (current.status === 'COMPLETED' && current.result) {
      return { code: 0, message: 'success', data: current.result as T };
    }
    const completed = await firstValueFrom(
      this.http.post<StandardResponse<ResumableUploadState>>(
        `${apiPrefix()}/uploads/resumable/${encodeURIComponent(current.uploadId)}/complete`,
        {},
        { context: new HttpContext().set(REPLAY_SAFE, true) },
      ),
    );
    if (completed.code !== 0 || !completed.data?.result) {
      throw new Error(completed.message || 'upload complete failed');
    }
    return {
      code: 0,
      message: completed.message,
      data: completed.data.result as T,
    };
  }

  /** The header that tells an upload route to promote a staged send after writing the file. */
  private cmidHeader(clientMessageId: string): HttpHeaders {
    return new HttpHeaders({ 'x-client-message-id': clientMessageId });
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<StandardResponse<Message[]>>(
      `${apiPrefix()}/query-messages`,
      params,
    );
  }

  /** Resolve the P2P thread with a peer user — returns { threadId } when friends, THREAD_NOT_FOUND otherwise. */
  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<{ threadId: number }>>(
      `${apiPrefix()}/thread/by-user-id`,
      params,
    );
  }

  /** Mute / unmute a conversation (suppresses notifications, not delivery). */
  setMuted(params: { threadId: number; muted: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/set-muted`,
      params,
    );
  }

  /** Pin / unpin a conversation (pinned-first ordering). */
  setPinned(params: { threadId: number; pinned: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/set-pinned`,
      params,
    );
  }

  /** Per-user "clear chat history" — hides all messages up to now for the caller; peer copy untouched. */
  clearHistory(params: { threadId: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/clear-history`,
      params,
    );
  }

  /** Permanently remove this conversation from the current user's roster and localizable history. */
  deleteThread(params: { threadId: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/delete`,
      params,
    );
  }

  /** Set a per-user alias/remark for a conversation — overrides the displayed name for the caller.
   *  An empty string clears it. */
  setAlias(params: { threadId: number; alias?: string }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/set-alias`,
      params,
    );
  }

  /**
   * Substring search over a conversation's text history. Returns lightweight {id, createdAt} matches
   * (no bodies) keyset-paginated by id desc — the client jumps the kernel to each id and renders the
   * bubble via the normal query path on demand. `lastSeq` is the seq cursor for the next page.
   */
  searchMessages(params: {
    threadId: number;
    keyword: string;
    take: number;
    lastSeq?: number;
  }) {
    return this.http.post<
      StandardResponse<{ seq: number; createdAt: number }[]>
    >(`${apiPrefix()}/search-messages`, params);
  }

  /** Manually re-run federated media localize for one message — the detail-view retry after a localize
   *  failure left the media inert. Idempotent (already-local digests skip the fetch, no quota burn).
   *  Returns the post-localize status ('ready' = bytes local | 'failed' = still missing). */
  relocalizeMedia(threadId: number, seq: number) {
    return this.http.post<StandardResponse<{ status: 'ready' | 'failed' }>>(
      `${apiPrefix()}/relocalize-media`,
      { threadId, seq },
    );
  }

  /** Bulk-probe federated media localize status for a set of messages — the scroll backstop for
   *  MEDIA_STATUS frames the client missed while disconnected. Returns {seq, status, sv} per existing seq. */
  queryMediaStatus(threadId: number, seqs: number[]) {
    return this.http.post<
      StandardResponse<{
        statuses: Array<{
          seq: number;
          status: 'ready' | 'failed';
          sv: number;
        }>;
      }>
    >(`${apiPrefix()}/media-status`, { threadId, seqs });
  }
}

function bodyFileSize(body: FormData): number {
  const value = body.get('file');
  return value instanceof Blob ? value.size : 0;
}
