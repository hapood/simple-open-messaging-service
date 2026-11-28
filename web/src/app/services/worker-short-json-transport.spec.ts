import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerShortJsonTransport } from './worker-short-json-transport';

function streamingResponse(status = 200) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }),
    { status },
  );
  return {
    response,
    write: (text: string) => stream.enqueue(new TextEncoder().encode(text)),
    finish: (text = '{}') => {
      stream.enqueue(new TextEncoder().encode(text));
      stream.close();
    },
    fail: (reason: unknown) => stream.error(reason),
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('WorkerShortJsonTransport', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let transport: WorkerShortJsonTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    transport = new WorkerShortJsonTransport();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('bounds all endpoint traffic at eight through body consumption and parsing', async () => {
    const bodies = Array.from({ length: 9 }, () => streamingResponse());
    fetchMock.mockImplementation(
      async () => bodies[fetchMock.mock.calls.length - 1].response,
    );
    const requests = bodies.map((_, index) =>
      transport.request(`/endpoint-${index % 5}`, {}, 'endpoint'),
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    // Headers and partial body progress cannot admit another fetch.
    bodies[0].write('{"code":');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    bodies[0].finish('0}');
    await expect(requests[0]).resolves.toEqual({ code: 0 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(9);
    bodies.slice(1).forEach((body) => body.finish());
    await Promise.all(requests);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes queued owner cancellations without dispatching them', async () => {
    const bodies = Array.from({ length: 8 }, () => streamingResponse());
    fetchMock.mockImplementation(
      async () => bodies[fetchMock.mock.calls.length - 1].response,
    );
    const requests = bodies.map(() =>
      transport.request('/active', {}, 'active'),
    );
    const owner = new AbortController();
    const queued = transport.request(
      '/queued',
      { signal: owner.signal },
      'queued',
    );
    const reason = new DOMException('Owner ended', 'AbortError');
    const rejected = expect(queued).rejects.toBe(reason);
    await flush();
    owner.abort(reason);
    await rejected;
    bodies.forEach((body) => body.finish());
    await Promise.all(requests);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an inflight owner but retains its slot until the body read settles', async () => {
    const bodies = Array.from({ length: 9 }, () => streamingResponse());
    fetchMock.mockImplementation(
      async () => bodies[fetchMock.mock.calls.length - 1].response,
    );
    const owner = new AbortController();
    const first = transport.request(
      '/first',
      { signal: owner.signal },
      'first',
    );
    const requests = Array.from({ length: 8 }, () =>
      transport.request('/next', {}, 'next'),
    );
    await flush();
    const rejection = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    owner.abort();
    await rejection;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    // Model asynchronous browser cancellation acknowledgement, not just unsubscribe.
    bodies[0].fail(new DOMException('Fetch aborted', 'AbortError'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(9);
    bodies.slice(1).forEach((body) => body.finish());
    await Promise.all(requests);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not dispatch for an already aborted owner', async () => {
    const owner = new AbortController();
    owner.abort();
    await expect(
      transport.request('/never', { signal: owner.signal }, 'never'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts headers after twelve seconds and cleans up its timer', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const result = transport.request('/headers', {}, 'headers');
    const rejected = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a thirty-second body idle deadline refreshed only by nonempty chunks', async () => {
    const body = streamingResponse();
    fetchMock.mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener(
        'abort',
        () => body.fail(init.signal?.reason),
        { once: true },
      );
      return body.response;
    });
    const result = transport.request('/body', {}, 'body');
    const rejected = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    body.write('{');
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    body.write('');
    await flush();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(body.response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes non-JSON HTTP errors before returning the existing status message', async () => {
    const body = streamingResponse(503);
    fetchMock.mockResolvedValue(body.response);
    const result = transport.request('/failure', {}, 'group-meta');
    const rejected = expect(result).rejects.toThrow('group-meta HTTP 503');
    await flush();
    body.write('<html>');
    await flush();
    expect(body.response.body?.locked).toBe(true);
    body.finish('unavailable</html>');
    await rejected;
    expect(body.response.bodyUsed).toBe(true);
    expect(body.response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid success JSON after consuming it and frees admission', async () => {
    const bodies = Array.from({ length: 8 }, () => streamingResponse());
    fetchMock.mockImplementation(async () => {
      const body = bodies[fetchMock.mock.calls.length - 1];
      return body
        ? body.response
        : Response.json({ code: 0, data: { value: 42 } });
    });
    const result = transport.request('/invalid', {}, 'invalid');
    const rejected = expect(result).rejects.toBeInstanceOf(SyntaxError);
    const requests = Array.from({ length: 8 }, () =>
      transport.request('/next', {}, 'next'),
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    bodies[0].finish('not JSON');
    await rejected;
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(9);
    bodies.slice(1).forEach((body) => body.finish());
    const values = await Promise.all(requests);
    expect(values[7]).toEqual({ code: 0, data: { value: 42 } });
    expect(bodies[0].response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves request options and browser credential defaults', async () => {
    fetchMock.mockImplementation(async () => Response.json({ code: 0 }));
    await transport.request('/default', {}, 'default');
    expect(fetchMock.mock.calls[0][1]?.credentials).toBeUndefined();
    await transport.request(
      '/explicit',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{"take":100}',
      },
      'explicit',
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"take":100}',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
