import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpContext,
  HttpEventType,
  HttpHeaders,
  HttpResponse,
} from '@angular/common/http';
import {
  defer,
  filter,
  firstValueFrom,
  map,
  of,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';
import {
  Message,
  MessageQueryRow,
  StandardResponse,
  type ContactCardTarget,
} from './model';
import { apiPrefix } from './constants';
import { isTauri, listenEvent, tauriInvoke } from './runtime';
import type { ThreadAliasApplied } from '../../../../shared/thread-attention';
import { SessionLifecycleService } from './session-lifecycle.service';
import { REPLAY_SAFE } from '../request-context';
import type { ForwardWireBundle } from '../components/forward-detail/forward-bundle.model';

export type UploadProgressHandler = (loaded: number, total: number) => void;
type UploadPartIntent = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

export interface UploadPartIdentity {
  clientMessageId: string;
  partId: string;
  position: number;
  intent: UploadPartIntent;
}

interface ResumableUploadState {
  uploadId: string;
  clientMessageId: string;
  totalBytes: number;
  offset: number;
  chunkSize: number;
  status: 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'ABORTED';
  result?: Record<string, unknown>;
}

interface MessageHistoryGap {
  startSeq: number;
  endSeq: number;
  recoverable: boolean;
}

export interface MessageQueryPage {
  messages: MessageQueryRow[];
  gaps: MessageHistoryGap[];
  scannedThrough: number;
  hasMore: boolean;
}

export interface MessageQueryCursorData {
  resumeAfter: number;
  resumeBefore: number;
}

type MessageHistoryBackendData = MessageQueryPage | MessageQueryCursorData;

export interface MessageHistoryBackendRequest {
  threadId: number;
  take?: number;
  after?: number;
  before?: number;
  through?: number;
}

interface MessageTombstoneQueryPage {
  tombstones: import('./model').DeletedMessageItem[];
  scannedThrough: number;
  hasMore: boolean;
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

  private readonly aliasWrites = new Map<
    string,
    Promise<StandardResponse<ThreadAliasApplied>>
  >();

  constructor(
    private http: HttpClient,
    private readonly lifecycle: SessionLifecycleService,
  ) {}

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
    retainLinkGeneration?: boolean;
  }) {
    return this.http.post<StandardResponse<{ id: string; createdAt: number }>>(
      `${apiPrefix()}/send-message`,
      params,
      params.clientMessageId
        ? { context: new HttpContext().set(REPLAY_SAFE, true) }
        : undefined,
    );
  }

  sendContactCard(params: {
    threadId: number;
    target: ContactCardTarget;
    clientMessageId: string;
  }) {
    return this.http.post<StandardResponse<Message>>(
      `${apiPrefix()}/send-contact-card`,
      params,
      { context: new HttpContext().set(REPLAY_SAFE, true) },
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
    return this.http.get<StandardResponse<ForwardWireBundle>>(
      `${apiPrefix()}/forward-bundles/${encodeURIComponent(bundleId)}`,
    );
  }

  /**
   * Stage a media message BEFORE its upload: the server creates a PendingMedia row keyed by
   * `clientMessageId` (+ the client-probed display meta) — durable intent recorded before the file
   * write, so a crash between staging and upload leaves a reclaimable record, never an orphan. No
   * Message or seq is created yet. The caller follows this with the matching upload() carrying the
   * same clientMessageId, which writes the file and promotes the stage to a real Message (confirmed
   * through the content-head wake and canonical query keyed by clientMessageId).
   */
  sendMedia(params: {
    threadId: number;
    contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
    clientMessageId: string;
    fileCnt?: number;
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
          contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
          content: string;
          status: 'pending' | 'failed';
          failReason: string | null;
          createdAt: number;
          updatedAt: number;
        }>
      >
    >(`${apiPrefix()}/query-media-stages`, { threadId });
  }

  abandonMediaStage(threadId: number, clientMessageId: string) {
    return this.http.post<StandardResponse<{ abandoned: boolean }>>(
      `${apiPrefix()}/abandon-media-stage`,
      { threadId, clientMessageId },
    );
  }

  /** Upload one logical message part. The server derives digest, size and media metadata; the client
   * only declares its stable identity, order and intended card family. Retries must reuse identity. */
  uploadPart<T>(
    file: File,
    identity: UploadPartIdentity,
    onProgress?: UploadProgressHandler,
  ): Observable<StandardResponse<T>> {
    if (this.canStream(file)) {
      return defer(() =>
        this.streamUpload<T>(
          file,
          '/upload',
          this.partFields(identity),
          identity.clientMessageId,
          onProgress,
        ),
      );
    }
    return defer(() => this.resumableUpload<T>(file, identity, onProgress));
  }

  private partFields(identity: UploadPartIdentity): Record<string, string> {
    return {
      partId: identity.partId,
      position: String(identity.position),
      intent: identity.intent,
    };
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
   *  path suffix after /api/v1. `fields` carry the stable upload-part identity. Returns the
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
    identity: UploadPartIdentity,
    onProgress?: UploadProgressHandler,
  ): Promise<StandardResponse<T>> {
    const init = await firstValueFrom(
      this.http.post<StandardResponse<ResumableUploadState>>(
        `${apiPrefix()}/uploads/resumable/init`,
        {
          clientMessageId: identity.clientMessageId,
          partId: identity.partId,
          position: identity.position,
          intent: identity.intent,
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

  /** Raw page contract used by the browser history walker. Cursor recovery, range reduction, commit,
   * and recursion deliberately remain above this transport-only method. */
  queryMessageHistoryPage(request: MessageHistoryBackendRequest) {
    return this.http.post<StandardResponse<MessageHistoryBackendData>>(
      `${apiPrefix()}/query-messages`,
      request,
    );
  }

  queryDeletedMessages(params: {
    threadId: number;
    after: number;
    take?: number;
    through?: number;
    maxMessageSeq?: number;
  }) {
    return this.http.post<StandardResponse<MessageTombstoneQueryPage>>(
      `${apiPrefix()}/deleted-messages/query`,
      {
        threadId: params.threadId,
        after: params.after,
        ...(params.take === undefined ? {} : { take: params.take }),
        ...(params.through === undefined ? {} : { through: params.through }),
        ...(params.maxMessageSeq === undefined
          ? {}
          : { maxMessageSeq: params.maxMessageSeq }),
      },
    );
  }

  withdrawMessage(params: { threadId: number; seq: number }) {
    return this.http.post<
      StandardResponse<{
        deletionSeq: number;
        threadId: number;
        messageSeq: number;
      }>
    >(`${apiPrefix()}/withdraw-message`, params);
  }

  reportMessage(params: { threadId: number; seq: number }) {
    return this.http.post<StandardResponse<Record<string, never>>>(
      `${apiPrefix()}/message-reports`,
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

  /** Block / unblock new-message delivery for a conversation; history is retained. */
  setBlocked(params: { threadId: number; blocked: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/thread/set-blocked`,
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

  /** Set a per-user alias/remark for a conversation — overrides the displayed name for the caller.
   *  An empty string clears it. */
  setAlias(params: { threadId: number; alias?: string }) {
    return defer(() => {
      const epoch = this.lifecycle.accountEpoch;
      const body = { ...params };
      const key = `${epoch}:${body.threadId}`;
      // Serialize edits even when separate mounted editors share one conversation.
      const previous = this.aliasWrites.get(key) ?? Promise.resolve();
      const pending = previous
        .catch(() => undefined)
        .then(() => {
          if (!this.lifecycle.isCurrent(epoch))
            throw new Error('alias edit belongs to an expired session');
          return firstValueFrom(
            this.http.post<StandardResponse<ThreadAliasApplied>>(
              `${apiPrefix()}/thread/set-alias`,
              body,
            ),
          );
        });
      this.aliasWrites.set(key, pending);
      const release = () => {
        if (this.aliasWrites.get(key) === pending) this.aliasWrites.delete(key);
      };
      void pending.then(release, release);
      return pending;
    });
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

  /** Manually re-run federated media localization for one message. */
  relocalizeMedia(threadId: number, seq: number) {
    return this.http.post<
      StandardResponse<{
        status: 'pending' | 'downloading' | 'ready' | 'failed';
      }>
    >(`${apiPrefix()}/relocalize-media`, { threadId, seq });
  }

  /** Read the authoritative federated media status for mounted messages. Used on mount and reconnect. */
  queryMediaStatus(threadId: number, seqs: number[]) {
    return this.http.post<
      StandardResponse<{
        statuses: Array<{
          seq: number;
          status: 'pending' | 'downloading' | 'ready' | 'failed';
        }>;
      }>
    >(`${apiPrefix()}/media-status`, { threadId, seqs });
  }
}

function bodyFileSize(body: FormData): number {
  const value = body.get('file');
  return value instanceof Blob ? value.size : 0;
}
