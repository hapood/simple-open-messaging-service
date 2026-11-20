import { Injectable } from '@angular/core';
import { Subject, firstValueFrom, takeUntil } from 'rxjs';
import { isAndroidNative } from './runtime';
import { NativeUploadTransport, type NativeUploadResource } from './native-upload-transport.service';
import type { UploadPartIdentity } from './upload-transport';
import { uuid } from '../lib/uuid';

export interface NativeUploadSelection {
  partId: string;
  path: string;
  kind: 'image' | 'video' | 'file';
  name: string;
  mimeType: string;
  size: number;
  w: number;
  h: number;
  duration: number;
  preview: string | null;
}

export const NATIVE_PICK_INSPECTION_TIMEOUT_MS = 30_000;

/** OS selection metadata and native transport subscriptions, never authoritative task state. */
@Injectable({ providedIn: 'root' })
export class NativeUploadService {
  private pendingPick?: {
    requestId: string;
    resolve: (items: NativeUploadSelection[]) => void;
    reject: (reason: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  private readonly transport = new NativeUploadTransport();
  private readonly active = new Map<string, { partId: string; cancel: Subject<void> }>();

  constructor() {
    window.__SOMS_UPLOAD_PICKED__ = ({ requestId, items }) => {
      const pending = this.pendingPick;
      if (!pending || pending.requestId !== requestId) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingPick = undefined;
      pending.resolve(items);
    };
    window.__SOMS_UPLOAD_INSPECTING__ = ({ requestId }) => {
      const pending = this.pendingPick;
      if (!pending || pending.requestId !== requestId || pending.timer) return;
      pending.timer = setTimeout(() => {
        if (this.pendingPick !== pending) return;
        this.pendingPick = undefined;
        pending.reject(new Error('File inspection timed out'));
      }, NATIVE_PICK_INSPECTION_TIMEOUT_MS);
    };
  }

  supported(): boolean { return isAndroidNative() && !!window.SomsUpload; }

  pick(kind: 'image' | 'file'): Promise<NativeUploadSelection[]> {
    if (!this.supported() || this.pendingPick) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const requestId = uuid();
      this.pendingPick = { requestId, resolve, reject };
      try {
        if (kind === 'image') window.SomsUpload!.pickPhotos(requestId);
        else window.SomsUpload!.pickFile(requestId);
      } catch (error) {
        this.pendingPick = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  upload<T>(resource: NativeUploadResource, identity: UploadPartIdentity, progress?: (loaded: number, total: number) => void): Promise<T> {
    const key = JSON.stringify([identity.clientMessageId, identity.partId]);
    if (this.active.has(key)) return Promise.reject(new Error('upload already in progress'));
    const entry = { partId: identity.partId, cancel: new Subject<void>() };
    this.active.set(key, entry);
    return firstValueFrom(this.transport.upload(resource, identity, progress).pipe(takeUntil(entry.cancel)))
      .then(result => result as T)
      .finally(() => { if (this.active.get(key) === entry) this.active.delete(key); });
  }

  cancel(clientMessageId: string, partId: string): void {
    const entry = this.active.get(JSON.stringify([clientMessageId, partId]));
    entry?.cancel.next();
    entry?.cancel.complete();
  }

  discard(partId: string): void {
    for (const entry of this.active.values()) {
      if (entry.partId !== partId) continue;
      entry.cancel.next();
      entry.cancel.complete();
    }
  }
}
