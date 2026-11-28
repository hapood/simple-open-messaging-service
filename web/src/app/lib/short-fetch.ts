export interface ShortFetchOptions {
  /** Optional host policy; omitted/null means no buffer limit. */
  maxResponseSize?: number | null;
  /** Optional total deadline, in addition to the transport phase deadlines. */
  timeout?: number;
  onSent?: () => void;
  onResponse?: (response: Response) => void;
  onDownloadProgress?: (loaded: number, total: number | undefined) => void;
}

/** Fetch and consume a short response without imposing JSON or host event semantics.
 * The promise owns the transport through body completion/cancellation acknowledgement:
 * abort requests cancellation, but must never race the fetch/read to release admission.
 */
export async function fetchShortText(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  options: ShortFetchOptions = {},
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = () =>
    controller.abort(
      new DOMException('HTTP transport timed out', 'TimeoutError'),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (milliseconds: number) => {
    clearTimeout(timer);
    timer = setTimeout(timeout, milliseconds);
  };
  const totalTimer = options.timeout
    ? setTimeout(timeout, options.timeout)
    : undefined;
  try {
    controller.signal.throwIfAborted();
    arm(12_000);
    const fetching = fetch(url, { ...init, signal: controller.signal });
    options.onSent?.();
    const response = await fetching;
    options.onResponse?.(response);
    arm(30_000);
    const contentLength = response.headers.get('content-length');
    const total = contentLength === null ? undefined : Number(contentLength);
    const max = options.maxResponseSize;
    const sizeError = () =>
      new Error(
        `Fetch response body exceeded the configured buffer limit (${max} bytes).`,
      );
    if (max != null && total !== undefined && total > max) {
      await response.body?.cancel();
      throw sizeError();
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let loaded = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          loaded += chunk.value.length;
          if (max != null && loaded > max) {
            await reader.cancel();
            throw sizeError();
          }
          text += decoder.decode(chunk.value, { stream: true });
          options.onDownloadProgress?.(
            loaded,
            total !== undefined && Number.isFinite(total) ? total : undefined,
          );
          if (chunk.value.length > 0) arm(30_000);
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    controller.signal.throwIfAborted();
    return { response, text };
  } finally {
    clearTimeout(timer);
    clearTimeout(totalTimer);
    signal.removeEventListener('abort', abort);
  }
}
