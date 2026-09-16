import { Injectable } from '@angular/core';
import { isAndroidNative, listenEvent } from './runtime';
import { uuid } from '../lib/uuid';

type NativeUploadKind = 'image' | 'video' | 'file';
export type NativeUploadErrorCategory =
  | 'network'
  | 'http'
  | 'api'
  | 'selection'
  | 'session'
  | 'unsupported'
  | 'busy'
  | 'cancelled'
  | 'discarded';

export class NativeUploadError extends Error {
  constructor(
    message: string,
    readonly category: NativeUploadErrorCategory,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'NativeUploadError';
  }
}

export interface NativeUploadSelection {
  uploadId: string;
  kind: NativeUploadKind;
  name: string;
  mimeType: string;
  size: number;
  w: number;
  h: number;
  duration: number;
  preview: string | null;
}

interface UploadCallbacks {
  uploadId: string;
  attemptId: string;
  clientMessageId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  progress?: (loaded: number, total: number) => void;
}

/** Rust's `ok` means the HTTP exchange completed, while the API envelope can still describe a business
 * failure. Release the native selection only for an actual successful upload so failure remains retryable. */
export function isSuccessfulUploadResponse(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    'code' in response &&
    (response as { code?: unknown }).code === 0
  );
}

@Injectable({ providedIn: 'root' })
export class NativeUploadService {
  private pendingPick?: {
    requestId: string;
    resolve: (items: NativeUploadSelection[]) => void;
  };
  private readonly uploads = new Map<string, UploadCallbacks>();
  private readonly attemptByUpload = new Map<string, string>();

  constructor() {
    if (typeof window === 'undefined') return;
    window.__SOMS_UPLOAD_PICKED__ = ({ requestId, items }) => {
      const pending = this.pendingPick;
      if (!pending || pending.requestId !== requestId) return;
      this.pendingPick = undefined;
      pending.resolve(items);
    };
    window.__SOMS_UPLOAD_PROGRESS__ = ({
      uploadId,
      attemptId,
      loaded,
      total,
    }) => {
      this.uploads.get(attemptId)?.progress?.(loaded, total);
    };
    window.__SOMS_UPLOAD_COMPLETED__ = ({ uploadId, attemptId, response }) => {
      const callbacks = this.takeAttempt(uploadId, attemptId);
      callbacks?.resolve(response);
    };
    window.__SOMS_UPLOAD_FAILED__ = ({
      uploadId,
      attemptId,
      category,
      message,
      retryable,
      status,
      code,
      retryAfter,
    }) => {
      const callbacks = this.takeAttempt(uploadId, attemptId);
      callbacks?.reject(
        new NativeUploadError(
          message,
          category,
          retryable,
          status,
          code,
          retryAfter,
        ),
      );
    };
    void listenEvent<{
      clientMessageId: string;
      loaded: number;
      total: number;
    }>('upload-progress', ({ payload }) => {
      for (const callbacks of this.uploads.values()) {
        if (callbacks.clientMessageId === payload.clientMessageId) {
          callbacks.progress?.(payload.loaded, payload.total);
          break;
        }
      }
    });
    void listenEvent<{
      uploadId: string;
      attemptId: string;
      ok: boolean;
      response?: unknown;
      message?: string;
    }>('native-upload-result', ({ payload }) => {
      const callbacks = this.takeAttempt(payload.uploadId, payload.attemptId);
      if (!callbacks) return;
      window.SomsUpload?.finish?.(
        payload.uploadId,
        payload.attemptId,
        payload.ok && isSuccessfulUploadResponse(payload.response),
      );
      if (payload.ok) callbacks.resolve(payload.response);
      else {
        callbacks.reject(
          new NativeUploadError(
            payload.message || 'upload failed',
            'network',
            true,
          ),
        );
      }
    });
  }

  supported(): boolean {
    return isAndroidNative() && !!window.SomsUpload;
  }

  pick(kind: 'image' | 'file'): Promise<NativeUploadSelection[]> {
    if (!this.supported()) return Promise.resolve([]);
    if (this.pendingPick) return Promise.resolve([]);
    return new Promise((resolve) => {
      const requestId = uuid();
      this.pendingPick = { requestId, resolve };
      if (kind === 'image') window.SomsUpload!.pickPhotos(requestId);
      else window.SomsUpload!.pickFile(requestId);
    });
  }

  upload<T>(
    selection: NativeUploadSelection,
    clientMessageId: string,
    fields: Record<string, string>,
    progress?: (loaded: number, total: number) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.attemptByUpload.has(selection.uploadId)) {
        reject(new Error('upload already in progress'));
        return;
      }
      const attemptId = uuid();
      this.attemptByUpload.set(selection.uploadId, attemptId);
      this.uploads.set(attemptId, {
        uploadId: selection.uploadId,
        attemptId,
        clientMessageId,
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
      });
      window.SomsUpload!.upload(
        selection.uploadId,
        attemptId,
        selection.kind,
        clientMessageId,
        JSON.stringify(fields),
      );
    });
  }

  discard(uploadId: string): void {
    this.rejectActive(uploadId, 'upload discarded', 'discarded');
    window.SomsUpload?.discard(uploadId);
  }

  release(uploadId: string): void {
    window.SomsUpload?.release(uploadId);
  }

  cancel(uploadId: string): void {
    const attemptId = this.attemptByUpload.get(uploadId);
    this.rejectActive(uploadId, 'upload cancelled', 'cancelled');
    if (attemptId) window.SomsUpload?.cancel(uploadId, attemptId);
  }

  state(uploadId: string): 'selected' | 'uploading' | 'missing' {
    const state = window.SomsUpload?.getState(uploadId);
    return state === 'selected' || state === 'uploading' ? state : 'missing';
  }

  private takeAttempt(
    uploadId: string,
    attemptId: string,
  ): UploadCallbacks | undefined {
    if (this.attemptByUpload.get(uploadId) !== attemptId) return undefined;
    const callbacks = this.uploads.get(attemptId);
    this.uploads.delete(attemptId);
    this.attemptByUpload.delete(uploadId);
    return callbacks;
  }

  private rejectActive(
    uploadId: string,
    message: string,
    category: 'cancelled' | 'discarded',
  ): void {
    const attemptId = this.attemptByUpload.get(uploadId);
    if (!attemptId) return;
    const callbacks = this.takeAttempt(uploadId, attemptId);
    callbacks?.reject(
      new NativeUploadError(message, category, category === 'cancelled'),
    );
  }
}
