import { firstValueFrom, Observable, takeUntil, timeout } from 'rxjs';
import type { TranslocoService } from '@jsverse/transloco';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { MediaTransferService } from '../../services/media-transfer.service';
import { translateBizResult } from '../../services/biz-code';
import type { StandardResponse } from '../../services/model';
import type { PendingSendResource } from '../../services/thread-send-outbox.service';
import {
  NativeUploadError,
  type NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import type { DebugToolsService } from '../../services/debug-tools.service';
import type { ToastService } from '../../services/toast.service';
import { MEDIA_STAGE_TIMEOUT_MS } from './message-send-timeout';

type UploadIntent = 'IMAGE' | 'VIDEO' | 'AUDIO';

// Staging has no file transfer; uploads instead time out only after a period without progress.
export const WEB_UPLOAD_IDLE_TIMEOUT_MS = 120_000;

/** Progress is reported out of band, not as an Observable emission. A response-only timeout
 * would wrongly abort a slow but advancing upload. Unsubscribing also aborts browser HttpClient. */
export function withUploadIdleTimeout<T>(
  start: (progress: (loaded: number, total: number) => void) => Observable<T>,
  progress: (loaded: number, total: number) => void,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    let timer: ReturnType<typeof setTimeout>;
    let lastLoaded = -1;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => subscriber.error(new Error('Upload stalled')),
        WEB_UPLOAD_IDLE_TIMEOUT_MS,
      );
    };
    arm();
    const subscription = start((loaded, total) => {
      if (loaded > lastLoaded) {
        lastLoaded = loaded;
        arm();
      }
      progress(loaded, total);
    }).subscribe(subscriber);
    return () => {
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  });
}

export interface ThreadAttachmentUploadHost {
  threadId(): number | undefined;
  failPending(item: CbItem<ChatItemData>): Promise<void>;
  markAccepted(item: CbItem<ChatItemData>): Promise<void>;
  surfaceQuota(response: StandardResponse<unknown>): void;
}

/** Executes staged browser-file uploads; UI selection and optimistic rendering stay outside. */
export class ThreadAttachmentUploadController {
  constructor(
    private readonly adapter: MessageThreadAdapter,
    private readonly transfers: MediaTransferService,
    private readonly transloco: TranslocoService,
    private readonly nativeUploads: NativeUploadService,
    private readonly debugTools: DebugToolsService,
    private readonly toast: ToastService,
    private readonly host: ThreadAttachmentUploadHost,
  ) {}

  async uploadWebGallery(
    cid: string,
    parts: Extract<PendingSendResource, { type: 'web-gallery' }>['parts'],
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId) return;
    const total = parts.reduce((sum, part) => sum + part.file.size, 0);
    const loaded = new Map<number, number>();
    this.transfers.start({
      clientMessageId: cid,
      threadId,
      kind: 'file',
      file: parts[0].file,
    });
    this.transfers.registerRetry(cid, () => {
      void this.uploadWebGallery(cid, parts, item, true);
    });
    try {
      const staged = await firstValueFrom(
        this.adapter
          .stageMedia({
            threadId,
            contentType: 'GALLERY',
            clientMessageId: cid,
            fileCnt: parts.length,
            retry,
          })
          .pipe(timeout(MEDIA_STAGE_TIMEOUT_MS)),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (staged.code !== 0) throw this.businessError(staged);
      const results = await Promise.all(
        parts.map((part) =>
          firstValueFrom(
            withUploadIdleTimeout(
              (progress) =>
                this.adapter.uploadPart(
                  part.file,
                  {
                    clientMessageId: cid,
                    partId: part.partId,
                    position: part.position,
                    intent: part.intent,
                  },
                  progress,
                ),
              (value) => {
                loaded.set(part.position, value);
                this.transfers.progress(
                  cid,
                  [...loaded.values()].reduce((sum, bytes) => sum + bytes, 0),
                  total,
                );
              },
            ).pipe(takeUntil(this.transfers.cancelled(cid))),
          ),
        ),
      );
      const failed = results.find((result) => result.code !== 0);
      if (!this.transfers.isUploading(cid)) return;
      if (failed) throw this.businessError(failed);
      this.transfers.complete(cid);
      await this.host.markAccepted(item);
    } catch (error) {
      await this.rejectError(cid, item, error);
    }
  }

  async uploadNativeGallery(
    cid: string,
    parts: Extract<PendingSendResource, { type: 'native-gallery' }>['parts'],
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId) return;
    const total = parts.reduce((sum, part) => sum + part.selection.size, 0);
    const loaded = new Map<number, number>();
    this.transfers.start({
      clientMessageId: cid,
      threadId,
      kind: 'file',
      name: parts[0].selection.name,
      size: total,
      previewUrl: parts[0].selection.preview,
    });
    this.transfers.registerRetry(cid, () => {
      void this.uploadNativeGallery(cid, parts, item, true);
    });
    try {
      const staged = await firstValueFrom(
        this.adapter
          .stageMedia({
            threadId,
            contentType: 'GALLERY',
            clientMessageId: cid,
            fileCnt: parts.length,
            retry,
          })
          .pipe(timeout(MEDIA_STAGE_TIMEOUT_MS)),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (staged.code !== 0) throw this.businessError(staged);
      const results = await Promise.all(
        parts.map((part) =>
          this.nativeUploads.upload<StandardResponse<unknown>>(
            part.selection,
            cid,
            {
              partId: part.partId,
              position: String(part.position),
              intent: nativeIntent(part.selection.kind),
            },
            (value) => {
              loaded.set(part.position, value);
              this.transfers.progress(
                cid,
                [...loaded.values()].reduce((sum, bytes) => sum + bytes, 0),
                total,
              );
            },
          ),
        ),
      );
      const failed = results.find((result) => result.code !== 0);
      if (!this.transfers.isUploading(cid)) return;
      if (failed) throw this.businessError(failed);
      this.transfers.complete(cid);
      await this.host.markAccepted(item);
    } catch (error) {
      for (const part of parts)
        this.nativeUploads.cancel(part.selection.uploadId);
      await this.rejectError(cid, item, error);
    }
  }

  async uploadNative(
    cid: string,
    partId: string,
    file: NativeUploadSelection,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId) return;
    const contentType = nativeIntent(file.kind);
    try {
      const staged = await firstValueFrom(
        this.adapter
          .stageMedia({ threadId, contentType, clientMessageId: cid, retry })
          .pipe(
            timeout(MEDIA_STAGE_TIMEOUT_MS),
            takeUntil(this.transfers.cancelled(cid)),
          ),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (staged.code !== 0) throw this.businessError(staged);
      const response = await this.nativeUploads.upload<
        StandardResponse<unknown>
      >(
        file,
        cid,
        { partId, position: '0', intent: contentType },
        (loaded, total) => this.transfers.progress(cid, loaded, total),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (response.code !== 0) throw this.businessError(response);
      this.transfers.complete(cid);
      await this.host.markAccepted(item);
    } catch (error) {
      if (!this.transfers.isUploading(cid)) return;
      this.nativeUploads.cancel(file.uploadId);
      if (error instanceof NativeUploadError && error.code !== undefined)
        this.host.surfaceQuota({
          code: error.code,
          message: error.message,
          data:
            error.retryAfter === undefined
              ? undefined
              : { retryAfter: error.retryAfter },
        });
      if (this.debugTools.enabled())
        console.error('[upload] native send failed', {
          clientMessageId: cid,
          uploadId: file.uploadId,
          kind: file.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      const reason = this.failureReason(error);
      this.transfers.fail(cid, reason);
      this.toast.warn(reason, { duration: 6000 });
      await this.host.failPending(item);
    }
  }

  uploadImage(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry: boolean,
  ): Promise<void> {
    return this.uploadPart(cid, partId, file, item, 'IMAGE', 10, retry);
  }

  uploadVideo(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry: boolean,
  ): Promise<void> {
    return this.uploadPart(cid, partId, file, item, 'VIDEO', 100, retry);
  }

  uploadAudio(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry: boolean,
  ): Promise<void> {
    return this.uploadPart(cid, partId, file, item, 'AUDIO', 50, retry);
  }

  async uploadFile(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry: boolean,
  ): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId || (await this.rejectOversized(cid, item, file, 50))) return;
    try {
      const staged = await firstValueFrom(
        this.adapter
          .stageMedia({
            threadId,
            contentType: 'FILE',
            clientMessageId: cid,
            retry,
          })
          .pipe(
            timeout(MEDIA_STAGE_TIMEOUT_MS),
            takeUntil(this.transfers.cancelled(cid)),
          ),
      );
      if (staged.code !== 0) return this.rejectStage(cid, item, staged);
      const uploaded = await firstValueFrom(
        withUploadIdleTimeout(
          (progress) =>
            this.adapter.uploadPart(
              file,
              {
                clientMessageId: cid,
                partId,
                position: 0,
                intent: 'FILE',
              },
              progress,
            ),
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (uploaded.code !== 0) return this.rejectStage(cid, item, uploaded);
      this.transfers.complete(cid);
      await this.host.markAccepted(item);
    } catch (error) {
      await this.rejectError(cid, item, error);
    }
  }

  private async uploadPart(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    intent: UploadIntent,
    limitMb: number,
    retry: boolean,
  ): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId || (await this.rejectOversized(cid, item, file, limitMb)))
      return;
    try {
      const staged = await firstValueFrom(
        this.adapter
          .stageMedia({
            threadId,
            contentType: intent,
            clientMessageId: cid,
            retry,
          })
          .pipe(
            timeout(MEDIA_STAGE_TIMEOUT_MS),
            takeUntil(this.transfers.cancelled(cid)),
          ),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (staged.code !== 0) return this.rejectStage(cid, item, staged);
      const uploaded = await firstValueFrom(
        withUploadIdleTimeout(
          (progress) =>
            this.adapter.uploadPart(
              file,
              { clientMessageId: cid, partId, position: 0, intent },
              progress,
            ),
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (!this.transfers.isUploading(cid)) return;
      if (uploaded.code !== 0) return this.rejectStage(cid, item, uploaded);
      this.transfers.complete(cid);
      await this.host.markAccepted(item);
    } catch (error) {
      await this.rejectError(cid, item, error);
    }
  }

  private async rejectStage(
    cid: string,
    item: CbItem<ChatItemData>,
    response: StandardResponse<unknown>,
  ): Promise<void> {
    this.host.surfaceQuota(response);
    this.transfers.fail(cid, translateBizResult(response, this.transloco));
    await this.host.failPending(item);
  }

  private async rejectError(
    cid: string,
    item: CbItem<ChatItemData>,
    error: unknown,
  ): Promise<void> {
    // A discarded attempt can finish after the user has cancelled or a retry has begun.
    if (!this.transfers.isUploading(cid)) return;
    const reason = this.failureReason(error);
    // One failed gallery part must abort its siblings; otherwise a late promotion can race the
    // failed bubble and the user's next retry. The original clientMessageId stays retryable.
    this.transfers.cancel(cid);
    this.transfers.fail(cid, String(reason));
    await this.host.failPending(item);
  }

  private businessError(response: StandardResponse<unknown>): Error {
    this.host.surfaceQuota(response);
    return new Error(response.message);
  }

  private failureReason(error: unknown): string {
    return error instanceof Error && error.message
      ? error.message
      : String(this.transloco.translate('transfer.uploadFailed'));
  }

  private async rejectOversized(
    cid: string,
    item: CbItem<ChatItemData>,
    file: File,
    limitMb: number,
  ): Promise<boolean> {
    if (file.size <= limitMb * 1024 * 1024) return false;
    this.transfers.fail(
      cid,
      this.transloco.translate('transfer.fileTooLarge', { limit: limitMb }),
      false,
    );
    await this.host.failPending(item);
    return true;
  }
}

function nativeIntent(kind: NativeUploadSelection['kind']) {
  return kind === 'image' ? 'IMAGE' : kind === 'video' ? 'VIDEO' : 'FILE';
}
