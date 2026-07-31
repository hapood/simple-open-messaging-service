import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Per-thread destructive-operation lock consulted by SSE consumers. */
@Injectable({ providedIn: 'root' })
export class ThreadDeletionLockService {
  private readonly locked = new Set<number>();
  readonly released$ = new Subject<number>();

  begin(threadId: number): boolean {
    if (this.locked.has(threadId)) return false;
    this.locked.add(threadId);
    return true;
  }

  end(threadId: number): void {
    if (this.locked.delete(threadId)) this.released$.next(threadId);
  }
  has(threadId: number): boolean {
    return this.locked.has(threadId);
  }
  get any(): boolean {
    return this.locked.size > 0;
  }
}
