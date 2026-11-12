import { tauriInvoke } from './runtime';
import type { ProfileRequest } from '../../../../shared/profile-demand';

/** The acknowledgement closes the cancel-before-registration race without
 * retaining unknown UUIDs in Rust. A late acknowledgement after completion is
 * harmless; cancellation is sent at most once while the invocation is live.
 */
export async function nativeProfileRequest<T>(
  userId: number,
  request: ProfileRequest,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) throw new Error('native IPC channel unavailable');
  const requestId = crypto.randomUUID();
  let registered = false;
  let finished = false;
  let cancelled = false;
  const cancel = () => {
    if (!registered || finished || cancelled || !signal?.aborted) return;
    cancelled = true;
    void tauriInvoke('cancel_http_request', { reqId: requestId }).catch(
      (error) => console.warn('[profile] native cancellation failed', error),
    );
  };
  const acknowledgement = new Channel<null>(() => {
    registered = true;
    cancel();
  });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await tauriInvoke<T | { status: 'CANCELLED' }>(
      'native_profile_resolve',
      {
        userId,
        requestId,
        request,
        registered: acknowledgement,
      },
    );
    signal?.throwIfAborted();
    if (
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'CANCELLED'
    ) {
      throw new DOMException('Profile request cancelled', 'AbortError');
    }
    return result as T;
  } finally {
    finished = true;
    signal?.removeEventListener('abort', cancel);
  }
}
