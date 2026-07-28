import { Injectable } from '@angular/core';
import { isAndroidNative } from './runtime';

export type NativeUploadKind = 'image' | 'video' | 'file';

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
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  progress?: (loaded: number, total: number) => void;
}

@Injectable({ providedIn: 'root' })
export class NativeUploadService {
  private pickResolve?: (items: NativeUploadSelection[]) => void;
  private readonly uploads = new Map<string, UploadCallbacks>();

  constructor() {
    if (typeof window === 'undefined') return;
    window.__SOMS_UPLOAD_PICKED__ = ({ items }) => {
      const resolve = this.pickResolve;
      this.pickResolve = undefined;
      resolve?.(items);
    };
    window.__SOMS_UPLOAD_PROGRESS__ = ({ uploadId, loaded, total }) => {
      this.uploads.get(uploadId)?.progress?.(loaded, total);
    };
    window.__SOMS_UPLOAD_COMPLETED__ = ({ uploadId, response }) => {
      const callbacks = this.uploads.get(uploadId);
      this.uploads.delete(uploadId);
      callbacks?.resolve(response);
    };
    window.__SOMS_UPLOAD_FAILED__ = ({ uploadId, message }) => {
      const callbacks = this.uploads.get(uploadId);
      this.uploads.delete(uploadId);
      callbacks?.reject(new Error(message));
    };
  }

  supported(): boolean {
    return isAndroidNative() && !!window.SomsUpload;
  }

  pick(kind: 'image' | 'file'): Promise<NativeUploadSelection[]> {
    if (!this.supported()) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.pickResolve?.([]);
      this.pickResolve = resolve;
      if (kind === 'image') window.SomsUpload!.pickPhotos();
      else window.SomsUpload!.pickFile();
    });
  }

  upload<T>(
    selection: NativeUploadSelection,
    clientMessageId: string,
    fields: Record<string, string>,
    progress?: (loaded: number, total: number) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.uploads.set(selection.uploadId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
      });
      window.SomsUpload!.upload(
        selection.uploadId,
        selection.kind,
        clientMessageId,
        JSON.stringify(fields),
      );
    });
  }

  discard(uploadId: string): void {
    this.uploads.delete(uploadId);
    window.SomsUpload?.discard(uploadId);
  }

  cancel(uploadId: string): void {
    const callbacks = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    callbacks?.reject(new Error('upload cancelled'));
    window.SomsUpload?.cancel(uploadId);
  }
}
