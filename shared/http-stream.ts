import { SSE_IDLE_TIMEOUT_MS, SSE_OPEN_TIMEOUT_MS } from './sse-policy.js';

export interface HttpStreamOptions {
  signal: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  credentials?: 'same-origin' | 'include' | 'omit';
  onResponse?: (response: Response) => void;
  onChunk: (bytes: Uint8Array) => void;
}
export type HttpStreamTransport = (
  url: string,
  options: HttpStreamOptions,
) => Promise<void>;

/** One request attempt. No buffering of the full body and no implicit replay. */
export const consumeHttpStream: HttpStreamTransport = async (url, options) => {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => {
    void reader?.cancel().catch(() => undefined);
  };
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(new Error(`HTTP stream received no data for ${ms}ms`)),
      ms,
    );
  };
  options.signal.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    if (options.signal.aborted) abort();
    controller.signal.throwIfAborted();
    arm(SSE_OPEN_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body?.slice().buffer,
      credentials: options.credentials ?? 'same-origin',
      cache: 'no-store',
    });
    controller.signal.throwIfAborted();
    // Own the reader before exposing headers so rejected responses also release their body.
    reader = response.body?.getReader();
    options.onResponse?.(response);
    controller.signal.throwIfAborted();
    if (!reader) return;
    arm(SSE_IDLE_TIMEOUT_MS);
    for (;;) {
      controller.signal.throwIfAborted();
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (!value.byteLength) continue;
      arm(SSE_IDLE_TIMEOUT_MS);
      options.onChunk(value);
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelReader);
    controller.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* Already aborted or errored. */
      }
      reader.releaseLock();
    }
  }
};
