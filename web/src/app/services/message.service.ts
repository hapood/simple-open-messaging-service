import {
  consumeSse,
  SseDecoder,
  type SseFrame,
} from '../../../../shared/sse-client';
import { WebUploadTransport } from './web-upload-transport';
import { NativeUploadTransport } from './native-upload-transport.service';
import { Injectable } from '@angular/core';
import type { StoredNonMediaSendContent } from './send-outbox-storage';
import { HttpClient, HttpContext } from '@angular/common/http';
import {
  defer,
  firstValueFrom,
  Observable,
  switchMap,
} from 'rxjs';
import {
  Message,
  MessageQueryRow,
  StandardResponse,
  type ContactCardSendTarget,
} from './model';
import { apiPrefix } from './constants';
import { isTauri } from './runtime';
import type { UploadPartIdentity, UploadProgressHandler } from './upload-transport';
import type { ThreadAliasApplied } from '../../../../shared/thread-attention';
import {
  SessionLifecycleService,
  type SessionWorkScope,
} from './session-lifecycle.service';
import { REPLAY_SAFE } from '../request-context';
import type { ForwardWireBundle } from '../components/forward-detail/forward-bundle.model';

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
  resolvedAnchorSeq: number | null;
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
  anchorSeq?: number;
  anchorNamespaceId?: number;
  anchorOriginSeq?: number;
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
  private readonly nativeUpload = new NativeUploadTransport();

  private readonly aliasWrites = new WeakMap<
    SessionWorkScope,
    Map<number, Promise<StandardResponse<ThreadAliasApplied>>>
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

  /** Execute the original non-media request without reconstructing it from a display card. */
  sendIntent(task: {
    clientMessageId: string;
    threadId: number;
    item: Extract<
      StoredNonMediaSendContent,
      { type: 'FORWARD' | 'CONTACT_CARD' }
    >;
  }): Observable<StandardResponse<Message>>;
  sendIntent(task: {
    clientMessageId: string;
    threadId: number;
    item: StoredNonMediaSendContent;
  }): Observable<StandardResponse<unknown>>;
  sendIntent(task: {
    clientMessageId: string;
    threadId: number;
    item: StoredNonMediaSendContent;
  }): Observable<StandardResponse<unknown>> {
    const { clientMessageId, threadId, item } = task;
    switch (item.type) {
      case 'PURE_TEXT':
        return this.sendMessage({
          clientMessageId,
          threadId,
          contentType: 'PURE_TEXT',
          content: item.content,
        });
      case 'LINK':
        return this.sendMessage({
          clientMessageId,
          threadId,
          contentType: 'LINK',
          content: item.generationId,
        });
      case 'CONTACT_CARD':
        return this.sendContactCard({
          clientMessageId,
          threadId,
          target: item.target,
        });
      case 'FORWARD':
        return this.sendForward({
          clientMessageId,
          threadId,
          sourceMessages: item.sourceMessages,
          mode: item.mode,
        });
    }
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
    target: ContactCardSendTarget;
    clientMessageId: string;
  }) {
    const { account, namespaceId, profileRev } = params.target;
    return this.http.post<StandardResponse<Message>>(
      `${apiPrefix()}/send-contact-card`,
      {
        threadId: params.threadId,
        target: { account, namespaceId, profileRev },
        clientMessageId: params.clientMessageId,
      },
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
  }) {
    return this.http.post<StandardResponse<{ clientMessageId: string }>>(
      `${apiPrefix()}/send-media`,
      params,
      { context: new HttpContext().set(REPLAY_SAFE, true) },
    );
  }

  cancelUploadBatch(clientMessageId: string) {
    return this.http.post<
      StandardResponse<{ clientMessageId: string; cancelled: number }>
    >(
      `${apiPrefix()}/uploads/resumable/batch/${encodeURIComponent(clientMessageId)}/cancel`,
      {},
      { context: new HttpContext().set(REPLAY_SAFE, true) },
    );
  }

  sendCompletedUploadBatch(clientMessageId: string) {
    return this.http.post<
      StandardResponse<{
        clientMessageId: string;
        sent: boolean;
        completed: number;
      }>
    >(
      `${apiPrefix()}/uploads/resumable/batch/${encodeURIComponent(clientMessageId)}/send-completed`,
      {},
      { context: new HttpContext().set(REPLAY_SAFE, true) },
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
      return this.nativeUpload.upload<T>({
        path: (file as File & { path: string }).path,
        name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
      }, identity, onProgress);
    }
    return new WebUploadTransport(this.http).upload<T>(file, identity, onProgress);
  }

  /** True when the upload can stream from disk: the Tauri DESKTOP shell, where Tauri's `<input type=file>`
   *  handling injects the real on-disk path as `File.path`. Otherwise (browser; Android — no `File.path`)
   *  the File is an in-memory blob with no path, so sequential HttpClient chunks are used. */
  private canStream(file: File): boolean {
    return isTauri() && typeof (file as { path?: string }).path === 'string';
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
      const scope = this.lifecycle.capture();
      const body = { ...params };
      let writes = this.aliasWrites.get(scope);
      if (!writes) {
        writes = new Map();
        this.aliasWrites.set(scope, writes);
      }
      const queue = writes;
      // Serialize edits only within the captured login scope, even across mounted editors.
      const previous = queue.get(body.threadId) ?? Promise.resolve();
      const pending = previous
        .catch(() => undefined)
        .then(() => {
          if (!this.lifecycle.isCurrent(scope))
            throw new Error('alias edit belongs to an expired session');
          return firstValueFrom(
            this.http.post<StandardResponse<ThreadAliasApplied>>(
              `${apiPrefix()}/thread/set-alias`,
              body,
            ),
          );
        });
      queue.set(body.threadId, pending);
      const release = () => {
        if (queue.get(body.threadId) === pending) queue.delete(body.threadId);
        if (queue.size === 0) this.aliasWrites.delete(scope);
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

  mediaDownloadProgress(
    threadId: number,
    seq: number,
  ): Observable<import('./model').MediaStatus> {
    const url = `${apiPrefix()}/message/media-message-progress?threadId=${threadId}&seq=${seq}`;
    return new Observable((subscriber) => {
      let revision = 0;
      const onFrame = (frame: SseFrame) => {
        if (frame.event !== 'MEDIA_MESSAGE_DOWNLOAD_PROGRESS' || !frame.data)
          return;
        const data = JSON.parse(frame.data) as { status?: string };
        if (
          data.status === 'downloading' ||
          data.status === 'ready' ||
          data.status === 'failed'
        ) {
          revision += 1;
          subscriber.next(data.status);
        }
      };
      if (isTauri()) {
        return this.http
          .get(url, {
            responseType: 'text',
            headers: { Accept: 'text/event-stream' },
          })
          .subscribe({
            next: (text) => new SseDecoder().push(text, onFrame),
            error: (error) => subscriber.error(error),
            complete: () => subscriber.complete(),
          });
      }
      const aborter = new AbortController();
      let snapshot: import('rxjs').Subscription | undefined;
      void consumeSse(url, {
        signal: aborter.signal,
        onFrame,
        onOpen: () => {
          // Subscribe before reading the snapshot so completion during stream setup is not lost.
          const before = revision;
          snapshot = this.queryMediaStatus(threadId, [seq]).subscribe({
            next: (response) => {
              const status = response.data?.statuses.find(
                (item) => item.seq === seq,
              )?.status;
              if (
                response.code === 0 &&
                status &&
                revision === before &&
                !subscriber.closed
              ) {
                subscriber.next(status);
              }
            },
            error: () => undefined,
          });
        },
      }).then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (!aborter.signal.aborted) subscriber.error(error);
        },
      );
      return () => {
        aborter.abort();
        snapshot?.unsubscribe();
      };
    });
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
