import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { S2sResponseError } from './federation-errors.js';

function setup(retries = 2, chunkBytes = 4) {
  const request = vi.fn();
  const degraded = vi.fn();
  const markContactSuccess = vi.fn();
  const client = new FederationMediaRangeClient(
    { signOutbound: vi.fn().mockResolvedValue({}) } as never,
    {
      resolveBase: vi.fn().mockResolvedValue('https://peer.example'),
      request,
    } as never,
    { markTransportDegraded: degraded } as never,
    {
      get: () => ({
        mediaChunkBytes: chunkBytes,
        mediaMaxChunkRetries: retries,
      }),
    } as never,
    { markContactSuccess, isFatalPeerCode: () => false } as never,
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const fetch = (offset = 0, bytes = 4) =>
    client.fetch(
      'peer.example',
      'digest',
      'a',
      'peer.example',
      'b',
      1,
      offset,
      bytes,
      signal,
    );
  return {
    client,
    request,
    degraded,
    fetch,
    signal,
    controller,
    markContactSuccess,
  };
}

function partial(
  body: string | ReadableStream<Uint8Array>,
  start = 0,
  end = 3,
  total = 4,
) {
  return new Response(body, {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
  });
}

async function collect(stream: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe('federation media range retries', () => {
  it('releases late response headers without interpreting peer health', async () => {
    const s = setup();
    const cancel = vi.fn();
    s.request.mockImplementationOnce(async () => {
      s.controller.abort(new Error('stopped before headers'));
      return partial(new ReadableStream({ cancel }));
    });
    await expect(collect(s.fetch())).rejects.toThrow('stopped before headers');
    expect(cancel).toHaveBeenCalledOnce();
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.markContactSuccess).not.toHaveBeenCalled();
    expect(s.degraded).not.toHaveBeenCalled();
  });

  it('cancels a stalled body without waiting for another data chunk', async () => {
    const s = setup();
    const cancel = vi.fn();
    const response = partial(new ReadableStream({ cancel }));
    s.request.mockResolvedValueOnce(response);
    const next = s.fetch().next();
    const rejected = expect(next).rejects.toThrow('stopped during body');
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    s.controller.abort(new Error('stopped during body'));
    await rejected;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(s.signal.reason);
    expect(response.body!.locked).toBe(false);
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.degraded).not.toHaveBeenCalled();
  });

  it('keeps the reader locked until asynchronous cancellation finishes', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => gate);
    const response = partial(new ReadableStream({ cancel }));
    s.request.mockResolvedValueOnce(response);
    let settled = false;
    const next = s
      .fetch()
      .next()
      .finally(() => {
        settled = true;
      });
    const rejected = expect(next).rejects.toThrow('stopped during body');
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    s.controller.abort(new Error('stopped during body'));
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(response.body!.locked).toBe(true);
    } finally {
      release();
      await rejected;
    }
    expect(response.body!.locked).toBe(false);
    expect(s.request).toHaveBeenCalledOnce();
  });

  it('logs failed body cancellation and releases the reader without retrying', async () => {
    const s = setup();
    const failure = new Error('body cancellation failed');
    const cancel = vi.fn().mockRejectedValue(failure);
    const response = partial(new ReadableStream({ cancel }));
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    s.request.mockResolvedValueOnce(response);
    try {
      const rejected = expect(s.fetch().next()).rejects.toThrow(
        'media response body cleanup failed',
      );
      await vi.waitFor(() => expect(response.body!.locked).toBe(true));
      s.controller.abort(new Error('stopped during body'));
      await rejected;
      expect(log).toHaveBeenCalledWith(
        'Could not cancel media response body',
        expect.objectContaining({
          errors: expect.arrayContaining([failure, s.signal.reason]),
        }),
      );
      expect(response.body!.locked).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
      expect(s.request).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('does not yield the verified last unit after cancellation during health persistence', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce(partial('data'));
    s.markContactSuccess.mockImplementationOnce(async () => {
      s.controller.abort(new Error('stopped during health update'));
    });
    await expect(s.fetch().next()).rejects.toThrow(
      'stopped during health update',
    );
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.degraded).not.toHaveBeenCalled();
  });

  it('cancels a stalled JSON error response without retrying or degrading the peer', async () => {
    const s = setup();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    s.request.mockResolvedValueOnce(response);
    const rejected = expect(s.fetch().next()).rejects.toThrow(
      'error body stopped',
    );
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    s.controller.abort(new Error('error body stopped'));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.degraded).not.toHaveBeenCalled();
  });

  it('stops reading an oversized JSON error before EOF and drains cancellation', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => gate);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(64 * 1024 + 1, 32));
        },
        cancel,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    s.request.mockResolvedValueOnce(response);
    let settled = false;
    const next = s
      .fetch()
      .next()
      .finally(() => {
        settled = true;
      });
    const rejected = expect(next).rejects.toBeInstanceOf(S2sResponseError);
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(response.body!.locked).toBe(true);
    } finally {
      release();
      await rejected;
    }
    expect(response.body!.locked).toBe(false);
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.degraded).not.toHaveBeenCalled();
  });

  it.each(['descriptor', 'range', 'non-json'] as const)(
    'reports %s response cleanup failure without retrying',
    async (kind) => {
      const s = setup();
      const failure = new Error('cleanup failed');
      const cancel = vi.fn().mockRejectedValue(failure);
      const body = new ReadableStream({ cancel });
      const response =
        kind === 'non-json'
          ? new Response(body, { status: 400 })
          : partial(body, kind === 'range' ? 1 : 0, 3, 8);
      s.request.mockResolvedValueOnce(response);
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      try {
        await expect(s.fetch().next()).rejects.toMatchObject({
          message: 'media response body cleanup failed',
          errors: expect.arrayContaining([failure]),
        });
        expect(log).toHaveBeenCalledOnce();
        if (kind !== 'non-json') {
          expect(log.mock.calls[0][1]).toMatchObject({
            errors: expect.arrayContaining([
              expect.objectContaining({
                message: expect.stringContaining(
                  kind === 'range'
                    ? 'unexpected Content-Range'
                    : 'declared size',
                ),
              }),
            ]),
          });
        }
        expect(cancel).toHaveBeenCalledOnce();
        expect(s.request).toHaveBeenCalledOnce();
        expect(s.degraded).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it('aborts an in-flight request without retrying or degrading the peer', async () => {
    const { request, client, degraded } = setup();
    const controller = new AbortController();
    request.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          expect(init.signal).toBe(controller.signal);
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    const transfer = collect(
      client.fetch(
        'peer.example',
        'digest',
        'a',
        'peer.example',
        'b',
        1,
        0,
        4,
        controller.signal,
      ),
    );
    const rejected = expect(transfer).rejects.toThrow('operator stopped');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort(new Error('operator stopped'));
    await rejected;
    expect(request).toHaveBeenCalledOnce();
    expect(degraded).not.toHaveBeenCalled();
  });

  it('rejects a header total different from the admitted descriptor without reading its body', async () => {
    const { request, client, degraded } = setup(0);
    const cancel = vi.fn();
    request.mockResolvedValue(partial(new ReadableStream({ cancel }), 0, 3, 8));
    await expect(
      collect(
        client.fetch(
          'peer.example',
          'digest',
          'a',
          'peer.example',
          'b',
          1,
          0,
          4,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow('declared size');
    expect(cancel).toHaveBeenCalled();
    expect(degraded).not.toHaveBeenCalled();
  });

  it('stops reading an oversized range immediately and does not retry or degrade the peer', async () => {
    const { request, fetch, degraded } = setup();
    const cancel = vi.fn();
    request.mockResolvedValue(
      partial(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('oversized'));
          },
          cancel,
        }),
      ),
    );
    await expect(collect(fetch())).rejects.toMatchObject({ extraBytes: 5n });
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(degraded).not.toHaveBeenCalled();
  });

  it('retries connection/header timeout failures at the same offset', async () => {
    const { request, fetch, signal } = setup();
    request
      .mockRejectedValueOnce(new Error('headers timeout'))
      .mockRejectedValueOnce(new Error('connect timeout'))
      .mockResolvedValueOnce(partial('data'));
    expect(await collect(fetch())).toBe('data');
    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) {
      expect(init.headers.range).toBe('bytes=0-3');
      expect(init.signal).toBe(signal);
    }
  });

  it('retries a body timeout without restarting completed chunks', async () => {
    const { request, fetch } = setup();
    request
      .mockResolvedValueOnce(partial('abcd', 0, 3, 8))
      .mockResolvedValueOnce(
        partial(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('body idle timeout'));
            },
          }),
          4,
          7,
          8,
        ),
      )
      .mockResolvedValueOnce(partial('efgh', 4, 7, 8));
    expect(await collect(fetch(0, 8))).toBe('abcdefgh');
    expect(request.mock.calls.map(([, init]) => init.headers.range)).toEqual([
      'bytes=0-3',
      'bytes=4-7',
      'bytes=4-7',
    ]);
  });

  it('retries an incomplete chunk', async () => {
    const { request, fetch } = setup();
    request
      .mockResolvedValueOnce(partial('a'))
      .mockResolvedValueOnce(partial('abcd'));
    expect(await collect(fetch())).toBe('abcd');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([0, 2])('bounds failed attempts with %s retries', async (retries) => {
    const { request, fetch } = setup(retries);
    request.mockRejectedValue(new Error('headers timeout'));
    await expect(collect(fetch())).rejects.toThrow(
      'retries exhausted at offset 0',
    );
    expect(request).toHaveBeenCalledTimes(retries + 1);
  });

  it('does not retry permanent peer rejection', async () => {
    const { request, fetch } = setup();
    request.mockResolvedValue(
      new Response(
        JSON.stringify({ code: BusinessCode.NOT_FOUND, message: 'missing' }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    await expect(collect(fetch())).rejects.toBeInstanceOf(S2sResponseError);
    expect(request).toHaveBeenCalledOnce();
  });

  it('resumes using a full chunk range from the persisted offset', async () => {
    const { request, fetch } = setup();
    request.mockResolvedValueOnce(partial('efgh', 4, 7, 8));
    expect(await collect(fetch(4, 8))).toBe('efgh');
    expect(request.mock.calls[0][1].headers.range).toBe('bytes=4-7');
  });

  it('cancels malformed partial responses without retrying them', async () => {
    const { request, fetch } = setup();
    const cancel = vi.fn();
    request.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 206 }),
    );
    await expect(collect(fetch())).rejects.toThrow('Content-Range');
    expect(cancel).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });
});
