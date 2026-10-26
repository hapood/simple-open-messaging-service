import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { S2sResponseError } from './federation-errors.js';

function setup(retries = 2, chunkBytes = 4) {
  const request = vi.fn();
  const degraded = vi.fn();
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
    { markContactSuccess: vi.fn(), isFatalPeerCode: () => false } as never,
  );
  const fetch = (offset = 0) =>
    client.fetch('peer.example', 'digest', 'a', 'peer.example', 'b', 1, offset);
  return { client, request, degraded, fetch };
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
  it('retries connection/header timeout failures at the same offset', async () => {
    const { request, fetch } = setup();
    request
      .mockRejectedValueOnce(new Error('headers timeout'))
      .mockRejectedValueOnce(new Error('connect timeout'))
      .mockResolvedValueOnce(partial('data'));
    expect(await collect(fetch())).toBe('data');
    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) {
      expect(init.headers.range).toBe('bytes=0-3');
      expect(init.signal).toBeUndefined();
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
    expect(await collect(fetch())).toBe('abcdefgh');
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
    expect(await collect(fetch(4))).toBe('efgh');
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
