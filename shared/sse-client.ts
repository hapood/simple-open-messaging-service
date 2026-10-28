import {
  SSE_HEARTBEAT_EVENT,
  SSE_IDLE_TIMEOUT_MS,
  SSE_OPEN_TIMEOUT_MS,
} from './sse-policy.js';

export interface SseFrame {
  event: string;
  data?: string;
}

/** Incremental SSE decoding, including CRLF split across network chunks. */
export class SseDecoder {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private skipLf = false;

  push(text: string, onFrame: (frame: SseFrame) => void): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.skipLf) {
        this.skipLf = false;
        if (c === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (c !== '\r' && c !== '\n') continue;
      const line = this.buffer + text.slice(start, i);
      this.buffer = '';
      this.skipLf = c === '\r';
      start = i + 1;
      this.line(line, onFrame);
    }
    this.buffer += text.slice(start);
  }

  private line(line: string, onFrame: (frame: SseFrame) => void): void {
    if (!line) {
      const frame = {
        event: this.event,
        data: this.data.length ? this.data.join('\n') : undefined,
      };
      this.event = '';
      this.data = [];
      // Transport frames must never reach domain synchronization or logging.
      if (frame.event && frame.event !== SSE_HEARTBEAT_EVENT) onFrame(frame);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** One connection attempt, not a reconnect loop. All timers and cancellation belong
 * to this attempt; callers own authentication, retry policy and domain events. */
export async function consumeSse(
  url: string,
  options: {
    signal: AbortSignal;
    credentials?: 'same-origin' | 'include' | 'omit';
    onResponse?: (response: Response) => void;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
  },
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => {
    void reader?.cancel().catch(() => undefined);
  };
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error(`SSE received no data for ${ms}ms`));
    }, ms);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    if (options.signal.aborted) abort();
    controller.signal.throwIfAborted();
    arm(SSE_OPEN_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: options.credentials ?? 'same-origin',
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
    });
    controller.signal.throwIfAborted();
    options.onResponse?.(response);
    controller.signal.throwIfAborted();
    if (!response.ok || !response.body) {
      throw new Error(`SSE open failed: ${response.status}`);
    }
    reader = response.body.getReader();
    arm(SSE_IDLE_TIMEOUT_MS);
    options.onOpen?.();
    const decoder = new SseDecoder();
    const text = new TextDecoder();
    for (;;) {
      controller.signal.throwIfAborted();
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (!value.byteLength) continue;
      arm(SSE_IDLE_TIMEOUT_MS);
      decoder.push(text.decode(value, { stream: true }), (frame) => {
        if (!controller.signal.aborted) options.onFrame(frame);
      });
    }
    // A trailing unterminated event is incomplete and is deliberately discarded.
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
}
