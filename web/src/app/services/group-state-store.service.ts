import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * In-process invalidation bus for group views. Events originate only after a
 * durable state delta has committed to the local database; this is not a
 * network transport and therefore cannot bypass state-feed recovery.
 */
@Injectable({ providedIn: 'root' })
export class GroupStateStore {
  readonly rosterChanged$ = new Subject<number>();

  notifyRosterChanged(threadId: number): void {
    this.rosterChanged$.next(threadId);
  }
}
