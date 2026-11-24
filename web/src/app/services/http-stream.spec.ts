import { appHttpStream } from './http-stream';
import { consumeAppSse } from './sse-client';

describe('native HTTP streaming adapter', () => {
  let messages: Array<(event: any) => void>;
  let invoke: ReturnType<
    typeof vi.fn<
      (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    >
  >;
  beforeEach(() => {
    messages = [];
    window.__TAURI_INTERNALS__ = {};
    invoke = vi.fn(() => new Promise(() => {}));
    window.__TAURI__ = {
      core: {
        invoke,
        Channel: class<T> {
          onmessage: (event: T) => void;
          constructor(onmessage: (event: T) => void = () => {}) {
            this.onmessage = onmessage;
            messages.push(onmessage);
          }
        },
      },
    };
  });
  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('delivers incremental UTF-8 SSE before EOF and filters heartbeats', async () => {
    const frame = vi.fn();
    const result = consumeAppSse('/api/v1/events', {
      signal: new AbortController().signal,
      onFrame: frame,
    });
    const send = messages[0];
    send({ type: 'started' });
    send({ type: 'headers', status: 200, headers: {} });
    const bytes = new TextEncoder().encode(
      'event: heartbeat\ndata: {}\n\nevent: HELLO\ndata: {"name":"你好"}\n\n',
    );
    for (const byte of bytes) send({ type: 'chunk', bytes: [byte] });
    expect(frame).toHaveBeenCalledExactlyOnceWith({
      event: 'HELLO',
      data: '{"name":"你好"}',
    });
    send({ type: 'end' });
    await result;
    expect(invoke).toHaveBeenCalledWith(
      'http_stream_request',
      expect.objectContaining({ headers: { accept: 'text/event-stream' } }),
    );
  });

  it('cancels after late registration without affecting a second subscriber', async () => {
    const aborter = new AbortController();
    const first = appHttpStream('/api/v1/events', {
      signal: aborter.signal,
      onChunk: vi.fn(),
    }).catch((error) => error);
    const secondChunk = vi.fn();
    const second = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onChunk: secondChunk,
    });
    const firstId = invoke.mock.calls[0][1]!['reqId'];
    aborter.abort();
    await first;
    messages[0]({ type: 'started' });
    expect(invoke).toHaveBeenCalledWith('cancel_http_request', {
      reqId: firstId,
    });
    messages[1]({ type: 'started' });
    messages[1]({ type: 'headers', status: 200, headers: {} });
    messages[1]({ type: 'chunk', bytes: [1] });
    messages[1]({ type: 'end' });
    await second;
    expect(secondChunk).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1]));
  });

  it('exposes HTTP status and cancels when an SSE response is rejected', async () => {
    const response = vi.fn();
    const frame = vi.fn();
    const result = consumeAppSse('/api/v1/events', {
      signal: new AbortController().signal,
      onResponse: response,
      onFrame: frame,
    });
    const error = result.catch((error) => error);
    messages[0]({ type: 'started' });
    messages[0]({ type: 'headers', status: 401, headers: {} });
    expect(response.mock.calls[0][0].status).toBe(401);
    expect(await error).toBeInstanceOf(Error);
    messages[0]({ type: 'chunk', bytes: [1] });
    expect(frame).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      'cancel_http_request',
      expect.anything(),
    );
  });

  it.each([
    [{ type: 'end' }, 'Stream event before start'],
    [
      { type: 'headers', status: 200, headers: {} },
      'Stream event before start',
    ],
  ])('rejects an event before registration: %j', async (event, message) => {
    const result = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onChunk: vi.fn(),
    }).catch((error) => error);
    messages[0](event);
    expect(await result).toEqual(new Error(message as string));
    messages[0]({ type: 'started' });
    expect(invoke).toHaveBeenCalledWith('cancel_http_request', {
      reqId: invoke.mock.calls[0][1]!['reqId'],
    });
  });

  it.each([
    [{ type: 'started' }, 'Duplicate stream start'],
    [{ type: 'end' }, 'Stream ended before headers'],
    [{ type: 'chunk', bytes: [1] }, 'Stream data before headers'],
  ])('cancels malformed event ordering: %j', async (event, message) => {
    const chunk = vi.fn();
    const result = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onChunk: chunk,
    }).catch((error) => error);
    messages[0]({ type: 'started' });
    messages[0](event);
    expect(await result).toEqual(new Error(message as string));
    expect(invoke).toHaveBeenCalledWith('cancel_http_request', {
      reqId: invoke.mock.calls[0][1]!['reqId'],
    });
    messages[0]({ type: 'headers', status: 200, headers: {} });
    messages[0]({ type: 'chunk', bytes: [1] });
    expect(chunk).not.toHaveBeenCalled();
  });

  it('rejects session termination and ignores queued bytes from that stream', async () => {
    const chunk = vi.fn();
    const result = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onChunk: chunk,
    }).catch((error) => error);
    messages[0]({ type: 'started' });
    messages[0]({ type: 'headers', status: 200, headers: {} });
    messages[0]({ type: 'error', error: { kind: 'session_ended' } });
    messages[0]({ type: 'chunk', bytes: [1] });
    expect(await result).toMatchObject({ kind: 'session_ended' });
    expect(chunk).not.toHaveBeenCalled();
  });

  it('acknowledges headers and chunks only after consumer processing', async () => {
    const processed: string[] = [];
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'http_stream_ack') processed.push('ack');
    });
    const result = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onResponse: () => {
        processed.push('headers');
      },
      onChunk: () => {
        processed.push('chunk');
      },
    });
    messages[0]({ type: 'started' });
    messages[0]({
      type: 'headers',
      status: 200,
      headers: {},
      delivery_id: 'headers-id',
    });
    messages[0]({ type: 'chunk', bytes: [1], delivery_id: 'chunk-id' });
    messages[0]({ type: 'end' });
    await result;
    expect(processed).toEqual(['headers', 'ack', 'chunk', 'ack']);
    expect(invoke).toHaveBeenCalledWith('http_stream_ack', {
      deliveryId: 'chunk-id',
    });
  });

  it('does not acknowledge a chunk when its consumer cancels', async () => {
    const controller = new AbortController();
    const result = appHttpStream('/api/v1/events', {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    }).catch((error) => error);
    messages[0]({ type: 'started' });
    messages[0]({
      type: 'headers',
      status: 200,
      headers: {},
      delivery_id: 'headers-id',
    });
    messages[0]({ type: 'chunk', bytes: [1], delivery_id: 'chunk-id' });
    await result;
    expect(invoke).not.toHaveBeenCalledWith('http_stream_ack', {
      deliveryId: 'chunk-id',
    });
    expect(invoke).toHaveBeenCalledWith(
      'cancel_http_request',
      expect.anything(),
    );
  });

  it('cancels the request when consumption acknowledgement fails', async () => {
    const failure = new Error('IPC unavailable');
    invoke.mockImplementation((cmd) => cmd === 'http_stream_ack'
      ? Promise.reject(failure)
      : new Promise(() => {}));
    const chunk = vi.fn();
    const result = appHttpStream('/api/v1/events', {
      signal: new AbortController().signal,
      onChunk: chunk,
    }).catch((error) => error);
    messages[0]({ type: 'started' });
    messages[0]({ type: 'headers', status: 200, headers: {}, delivery_id: 'headers-id' });
    expect(await result).toBe(failure);
    expect(invoke).toHaveBeenCalledWith('cancel_http_request', expect.anything());
    messages[0]({ type: 'chunk', bytes: [1], delivery_id: 'chunk-id' });
    expect(chunk).not.toHaveBeenCalled();
  });

  it('rejects missing native support rather than falling back to fetch', async () => {
    delete window.__TAURI__;
    const fetch = vi.spyOn(window, 'fetch');
    await expect(
      appHttpStream('/api/v1/events', {
        signal: new AbortController().signal,
        onChunk: vi.fn(),
      }),
    ).rejects.toThrow('Native streaming channel unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
