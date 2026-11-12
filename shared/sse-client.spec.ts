import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { consumeSse, SseDecoder } from './sse-client.js';
import {
  SSE_HEARTBEAT_EVENT,
  SSE_IDLE_TIMEOUT_MS,
  SSE_OPEN_TIMEOUT_MS,
} from './sse-policy.js';

function stream() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
    cancel,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  const controller = new AbortController();
  const frames = vi.fn();
  const open = vi.fn();
  const result = consumeSse('/events', {
    signal: controller.signal,
    onFrame: frames,
    onOpen: open,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    output,
    cancel,
    body,
    controller,
    frames,
    open,
    result,
    send: (s: string) => output.enqueue(new TextEncoder().encode(s)),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared SSE transport', () => {
  it('decodes split CRLF and multiline data without emitting heartbeats', () => {
    const decoder = new SseDecoder();
    const frames = vi.fn();
    for (const char of ': comment\r\nevent: heartbeat\r\ndata: {}\r\n\r\nevent: HELLO\r\ndata: a\r\ndata: b\r\n\r\n') {
      decoder.push(char, frames);
    }
    expect(frames).toHaveBeenCalledExactlyOnceWith({
      event: 'HELLO',
      data: 'a\nb',
    });
  });

  it('treats a trailing CR as a line ending without waiting for another chunk', () => {
    const frames = vi.fn();
    new SseDecoder().push('event: HELLO\rdata: {}\r\r', frames);
    expect(frames).toHaveBeenCalledExactlyOnceWith({
      event: 'HELLO',
      data: '{}',
    });
  });

  it('does not open or emit after the response callback cancels authentication', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const open = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    );
    await expect(
      consumeSse('/events', {
        signal: controller.signal,
        onResponse: () => controller.abort(),
        onOpen: open,
        onFrame: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a silent stream at 30s and releases reader and timers', async () => {
    vi.useFakeTimers();
    const s = stream();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.open).toHaveBeenCalledOnce();
    expect(s.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await s.result).toBeInstanceOf(Error);
    expect(s.cancel).toHaveBeenCalledOnce();
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets on bytes including comments and incomplete frames, not only parsed events', async () => {
    vi.useFakeTimers();
    const s = stream();
    for (const chunk of [
      ': keepalive\n\n',
      'event: heartbeat\ndata: {}\n\n',
      'event: HEL',
      'LO\ndata: {}\n\n',
    ]) {
      await vi.advanceTimersByTimeAsync(20_000);
      s.send(chunk);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.cancel).not.toHaveBeenCalled();
    }
    expect(s.frames).toHaveBeenCalledExactlyOnceWith({
      event: 'HELLO',
      data: '{}',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await s.result).toBeInstanceOf(Error);
  });

  it('does not renew liveness for empty chunks', async () => {
    vi.useFakeTimers();
    const s = stream();
    await vi.advanceTimersByTimeAsync(20_000);
    s.output.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await s.result).toBeInstanceOf(Error);
  });

  it('cancels explicitly and does not dispatch subsequent frames from the same chunk', async () => {
    vi.useFakeTimers();
    const s = stream();
    s.frames.mockImplementation(() => s.controller.abort());
    await vi.advanceTimersByTimeAsync(0);
    s.send('event: FORCE_LOGOUT\ndata: {}\n\nevent: HELLO\ndata: {}\n\n');
    await s.result;
    expect(s.frames).toHaveBeenCalledTimes(1);
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up on parser callback errors and leaves the next connection unaffected', async () => {
    vi.useFakeTimers();
    const first = stream();
    first.frames.mockImplementation(() => {
      throw new Error('bad event');
    });
    await vi.advanceTimersByTimeAsync(0);
    first.send('event: log\ndata: {}\n\n');
    expect(await first.result).toEqual(new Error('bad event'));
    expect(vi.getTimerCount()).toBe(0);
    const second = stream();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      second.send('event: heartbeat\ndata: {}\n\n');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(second.cancel).not.toHaveBeenCalled();
    second.controller.abort();
    await second.result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the opening phase and cleans it up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(init.signal.reason),
            );
          }),
      ),
    );
    const result = consumeSse('/events', {
      signal: new AbortController().signal,
      onFrame: vi.fn(),
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SSE_OPEN_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up on EOF without dispatching an incomplete trailing frame', async () => {
    vi.useFakeTimers();
    const s = stream();
    await vi.advanceTimersByTimeAsync(0);
    s.send('event: HELLO\ndata: {}');
    s.output.close();
    expect(await s.result).toBeUndefined();
    expect(s.frames).not.toHaveBeenCalled();
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the native runtime policy identical to the browser policy', () => {
    const rust = readFileSync(
      new URL('../src-tauri/src/sse.rs', import.meta.url),
      'utf8',
    ).replaceAll('_', '');
    expect(rust).toContain(
      `const SSECONNECTTIMEOUT: Duration = Duration::frommillis(${SSE_OPEN_TIMEOUT_MS});`,
    );
    expect(rust).toContain(
      `const SSEIDLETIMEOUT: Duration = Duration::frommillis(${SSE_IDLE_TIMEOUT_MS});`,
    );
    expect(rust).toContain(
      `const SSEHEARTBEATEVENT: &str = "${SSE_HEARTBEAT_EVENT}";`,
    );
  });
});
