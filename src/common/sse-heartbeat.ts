import type { MessageEvent } from '@nestjs/common';
import { Observable, type MonoTypeOperatorFunction } from 'rxjs';
import {
  SSE_HEARTBEAT_EVENT,
  SSE_HEARTBEAT_MS,
} from '../../shared/sse-policy.js';

/** Send an immediate transport frame to commit headers even for an empty source.
 * Heartbeats are independent of filters and never query domain state. Completion,
 * errors and disconnects release the source and timer together. */
export function withSseHeartbeat(): MonoTypeOperatorFunction<MessageEvent> {
  return (source) =>
    new Observable<MessageEvent>((sink) => {
      const beat = () => sink.next({ type: SSE_HEARTBEAT_EVENT, data: {} });
      beat();
      if (sink.closed) return;
      const timer = setInterval(beat, SSE_HEARTBEAT_MS);
      timer.unref();
      sink.add(() => clearInterval(timer));
      return source.subscribe(sink);
    });
}
