import { tauriInvoke } from './runtime';
import type {
  NativeMessageHistoryDemand,
  NativeMessageHistoryResult,
} from './message-repository.service';

type HistoryEvent =
  | { state: 'ready'; result: NativeMessageHistoryResult }
  | { state: 'failed'; reason: string };

/** Thin transport for a Rust-owned history task. Cancellation before registration
 * completes is remembered and sent as soon as Rust returns its opaque handle. */
export function nativeHistoryRequest(
  userId: number,
  threadId: number,
  demand: NativeMessageHistoryDemand,
  signal?: AbortSignal,
): Promise<NativeMessageHistoryResult> {
  signal?.throwIfAborted();
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel)
    return Promise.reject(new Error('native IPC channel unavailable'));
  return new Promise((resolve, reject) => {
    let id: string | undefined;
    let settled = false;
    let cancelled = false;
    const cancel = (requestId: string) => {
      void tauriInvoke('native_message_history_cancel', { requestId }).catch(
        (error) => console.warn('[native-history] cancellation failed', error),
      );
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      window.removeEventListener('pagehide', abort);
    };
    const abort = () => {
      if (settled) return;
      cancelled = true;
      settled = true;
      cleanup();
      if (id) cancel(id);
      reject(
        signal?.reason ??
          new DOMException('History consumer closed', 'AbortError'),
      );
    };
    const events = new Channel<HistoryEvent>((event) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (event.state === 'ready') resolve(event.result);
      else reject(new Error(event.reason));
    });
    signal?.addEventListener('abort', abort, { once: true });
    window.addEventListener('pagehide', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void tauriInvoke<string>('native_message_history_start', {
      userId,
      threadId,
      demand,
      events,
    }).then(
      (requestId) => {
        id = requestId;
        if (cancelled) cancel(id);
      },
      (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      },
    );
  });
}
