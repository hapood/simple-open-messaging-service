import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type { StandardMessage } from './realtime-transport';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { LoginSessionId } from './session/session-identity';

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
  loginSessionId: LoginSessionId;
};

function isCommitEvent(event: string): event is NativeCommitEvent['event'] {
  return COMMIT_EVENTS.has(event);
}

/** Native executor completion port, independent of connection/authentication orchestration.
 * UUID admission at delivery prevents a queued old completion from entering a successor login. */
@Injectable({ providedIn: 'root' })
export class NativeCommitEventsService {
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly committed = new Subject<NativeCommitEvent>();
  readonly committed$ = this.committed.asObservable();

  publish(message: StandardMessage): void {
    const { event } = message;
    const sessionId = this.lifecycle.capture().sessionId;
    if (
      isCommitEvent(event) &&
      sessionId !== null &&
      message.loginSessionId === sessionId
    ) {
      this.committed.next({ ...message, event, loginSessionId: sessionId });
    }
  }
}
