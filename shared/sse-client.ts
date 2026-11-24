import { SSE_HEARTBEAT_EVENT, SSE_MAX_FRAME_CHARS } from './sse-policy.js';
import type { HttpStreamTransport } from './http-stream.js';

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
  private frameChars = 0;

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
      if (++this.frameChars > SSE_MAX_FRAME_CHARS) {
        throw new Error('SSE frame exceeds maximum size');
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
      this.frameChars = 0;
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
    transport: HttpStreamTransport;
    credentials?: 'same-origin' | 'include' | 'omit';
    onResponse?: (response: Response) => void;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
  },
): Promise<void> {
  const decoder = new SseDecoder();
  const text = new TextDecoder();
  await options.transport(url, {
    signal: options.signal,
    credentials: options.credentials,
    headers: { Accept: 'text/event-stream' },
    onResponse: (response) => {
      options.onResponse?.(response);
      options.signal.throwIfAborted();
      if (!response.ok) throw new Error(`SSE open failed: ${response.status}`);
      options.onOpen?.();
    },
    onChunk: (bytes) =>
      decoder.push(text.decode(bytes, { stream: true }), (frame) => {
        if (!options.signal.aborted) options.onFrame(frame);
      }),
  });
  // A trailing unterminated event is incomplete and deliberately discarded.
}
