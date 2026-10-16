import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type { StandardMessage } from './realtime-transport';

const COMMIT_EVENT_NAMES = [
  'LOCAL_MESSAGE_DB_COMMITTED',
  'LOCAL_THREAD_FEED_COMMITTED',
  'LOCAL_STATE_FEED_COMMITTED',
  'LOCAL_GROUP_META_COMMITTED',
  'LOCAL_TOMBSTONE_COMMITTED',
] as const;
const COMMIT_EVENTS = new Set<string>(COMMIT_EVENT_NAMES);

export type NativeCommitEvent = StandardMessage & {
  event: (typeof COMMIT_EVENT_NAMES)[number];
};

/** Native executor completion port, independent of connection/authentication orchestration.
 * The epoch-guarded native ingress publishes here; storage consumes without owning a transport. */
@Injectable({ providedIn: 'root' })
export class NativeCommitEventsService {
  private readonly committed = new Subject<NativeCommitEvent>();
  readonly committed$ = this.committed.asObservable();

  publish(message: StandardMessage): void {
    if (COMMIT_EVENTS.has(message.event))
      this.committed.next(message as NativeCommitEvent);
  }
}
