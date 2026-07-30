import { Injectable, signal } from '@angular/core';

export interface UploadDetailScope {
  threadId?: number;
}

@Injectable({ providedIn: 'root' })
export class UploadDetailDialogService {
  private readonly scopeState = signal<UploadDetailScope | null>(null);
  readonly scope = this.scopeState.asReadonly();

  open(threadId?: number): void {
    this.scopeState.set(threadId === undefined ? {} : { threadId });
  }

  close(): void {
    this.scopeState.set(null);
  }
}
