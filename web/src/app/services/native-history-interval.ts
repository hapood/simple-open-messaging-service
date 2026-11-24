import { Observable } from 'rxjs';
import { tauriInvoke } from './runtime';
import type { MessageHistoryIntervalPage } from './message-repository.service';

type IntervalEvent =
  | { state: 'page'; page: MessageHistoryIntervalPage }
  | { state: 'failed'; reason: string };

/** IPC ownership adapter only. Rust owns the stream, coalescing, I/O and retries. */
export function nativeHistoryInterval(
  userId: number,
  threadId: number,
  left: number,
  right: number,
): Observable<MessageHistoryIntervalPage> {
  return new Observable((subscriber) => {
    const Channel = window.__TAURI__?.core?.Channel;
    if (!Channel) {
      subscriber.error(new Error('native IPC channel unavailable'));
      return;
    }
    let requestId: string | undefined;
    const cancel = () => {
      if (requestId)
        void tauriInvoke('native_message_history_cancel', { requestId }).catch(
          () => undefined,
        );
    };
    const hide = () => subscriber.complete();
    window.addEventListener('pagehide', hide, { once: true });
    const events = new Channel<IntervalEvent>((event) => {
      if (subscriber.closed) return;
      if (event.state === 'page') subscriber.next(event.page);
      else subscriber.error(new Error(event.reason));
    });
    void tauriInvoke<string>('native_message_history_interval_start', {
      userId,
      threadId,
      left,
      right,
      events,
    }).then(
      (id) => {
        requestId = id;
        if (subscriber.closed) cancel();
      },
      (error) => subscriber.error(error),
    );
    return () => {
      window.removeEventListener('pagehide', hide);
      cancel();
    };
  });
}
