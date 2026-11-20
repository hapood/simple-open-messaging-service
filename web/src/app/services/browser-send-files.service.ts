import { Injectable, inject } from '@angular/core';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { StoredSendFile } from './send-outbox-storage';

export class SendAttachmentUnavailableError extends Error {
  readonly translationKey = 'transfer.attachmentUnavailable';
  constructor() {
    super('Attachment unavailable. Please cancel and upload again.');
  }
}

/** Owns browser File references for this runtime only. No file bytes are persisted. */
@Injectable({ providedIn: 'root' })
export class BrowserSendFiles {
  private readonly files = new Map<string, File>();

  constructor() {
    inject(SessionLifecycleService).invalidated$.subscribe(() => this.files.clear());
  }

  retain(file: File, partId: string): StoredSendFile {
    const path = crypto.randomUUID();
    this.files.set(path, file);
    return { path, partId, name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' };
  }

  resolve(descriptor: StoredSendFile): File {
    const file = this.files.get(descriptor.path);
    if (!file) throw new SendAttachmentUnavailableError();
    return file;
  }

  release(path: string): void {
    this.files.delete(path);
  }

  bytes(): number {
    return [...this.files.values()].reduce((sum, file) => sum + file.size, 0);
  }
}
