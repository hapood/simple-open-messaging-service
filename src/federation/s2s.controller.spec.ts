import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { S2sController } from './s2s.controller.js';

function target() {
  const federation = {
    resolveMediaFile: vi.fn().mockResolvedValue({
      absPath: '/unused',
      bytes: 16,
    }),
    pullStateFromPeer: vi.fn().mockResolvedValue(0n),
    pullTombstonesFromPeer: vi.fn().mockResolvedValue(undefined),
    pullMissedFromPeer: vi.fn().mockResolvedValue(undefined),
  };
  const messageFeedPull = { advertise: vi.fn() };
  const tombstonePull = { advertise: vi.fn() };
  const peerStateFeedPull = { advertise: vi.fn() };
  const messageFeed = {
    query: vi
      .fn()
      .mockResolvedValue({ messages: [], scannedThrough: '1', hasMore: false }),
    rejectMissingAfter: vi.fn().mockRejectedValue(
      Object.assign(new Error('after is required'), {
        bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        status: 200,
      }),
    ),
  };
  const tombstoneFeed = {
    query: vi.fn().mockResolvedValue({
      tombstones: [],
      scannedThrough: '1',
      hasMore: false,
    }),
    rejectMissingAfter: vi.fn().mockRejectedValue(
      Object.assign(new Error('after is required'), {
        bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        status: 200,
      }),
    ),
  };
  const peerStateFeed = {
    rejectMissingAfter: vi.fn().mockRejectedValue(
      Object.assign(new Error('after is required'), {
        bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        status: 200,
      }),
    ),
  };
  const controller = new S2sController(
    federation as never,
    messageFeed as never,
    messageFeedPull as never,
    tombstoneFeed as never,
    tombstonePull as never,
    {} as never,
    peerStateFeed as never,
    peerStateFeedPull as never,
  );
  return {
    controller,
    federation,
    messageFeed,
    tombstoneFeed,
    peerStateFeed,
    messageFeedPull,
    tombstonePull,
    peerStateFeedPull,
  };
}

function mediaRequest(range: string): FastifyRequest {
  return {
    method: 'GET',
    url: `/s2s/v1/media/${'a'.repeat(64)}?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42`,
    rawBody: Buffer.alloc(0),
    headers: { range },
    peer: { domain: 'a.example', keyId: 'a.example/key-1' },
  } as unknown as FastifyRequest;
}

function replyTarget() {
  const headers = new Map<string, string>();
  let status = 200;
  let body: unknown;
  const reply = {
    code: vi.fn((value: number) => {
      status = value;
      return reply;
    }),
    header: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
      return reply;
    }),
    send: vi.fn((value?: unknown) => {
      body = value;
      return reply;
    }),
  } as unknown as FastifyReply;
  return {
    reply,
    result: () => ({ status, headers, body }),
  };
}

describe('S2sController federation media errors', () => {
  it('returns the registered JSON envelope and Content-Range for 416', async () => {
    const { controller } = target();
    const response = replyTarget();
    await controller.getFile(mediaRequest('bytes=16-20'), response.reply);
    expect(response.result()).toMatchObject({
      status: 416,
      body: {
        code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
        message: 'requested range is not satisfiable',
        data: null,
      },
    });
    expect(response.result().headers.get('content-type')).toBe(
      'application/json',
    );
    expect(response.result().headers.get('content-range')).toBe('bytes */16');
  });

  it('rejects malformed and multi-range instead of serving the full file', async () => {
    const { controller } = target();
    await expect(
      controller.getFile(mediaRequest('bytes=0-1,3-4'), replyTarget().reply),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });

  it('maps an indeterminate resource lookup failure to retryable 503 INTERNAL', async () => {
    const { controller, federation } = target();
    federation.resolveMediaFile.mockRejectedValueOnce(new Error('db offline'));

    await expect(
      controller.getFile(mediaRequest('bytes=0-4'), replyTarget().reply),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.INTERNAL,
      status: 503,
    });
  });
});

describe('S2sController message-feed bootstrap', () => {
  it('returns the cursor business result when after is omitted', async () => {
    const { controller, messageFeed } = target();
    const req = {
      query: {},
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(controller.getMissed(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
    });
    expect(messageFeed.rejectMissingAfter).toHaveBeenCalledWith('a.example');
  });

  it('rejects pagination controls without after', async () => {
    const { controller, messageFeed } = target();
    const req = {
      query: { take: '100' },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(
      controller.getMissed(req, undefined, '100'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(messageFeed.rejectMissingAfter).not.toHaveBeenCalled();
  });
});

describe('S2sController reverse thread queries', () => {
  it('passes before as the exclusive reverse message cursor', async () => {
    const { controller, messageFeed } = target();
    const req = {
      query: { account: 'alice', localAccount: 'bob', before: '3' },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await controller.queryMessages(req, 'alice', 'bob', undefined, '3');
    expect(messageFeed.query).toHaveBeenCalledWith(
      'a.example',
      { type: 'P2P', account: 'alice', localAccount: 'bob' },
      undefined,
      undefined,
      undefined,
      true,
      3,
    );
  });

  it('rejects supplying after and before together', async () => {
    const { controller } = target();
    const req = {
      query: {
        account: 'alice',
        localAccount: 'bob',
        after: '1',
        before: '3',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(
      controller.queryMessages(req, 'alice', 'bob', '1', '3'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });
});

describe('S2sController state and tombstone feed bootstrap', () => {
  it('uses the same no-after positioning contract for both feeds', async () => {
    const { controller, tombstoneFeed, peerStateFeed } = target();
    const req = {
      query: {},
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(controller.getMessageTombstones(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
    });
    await expect(controller.getStateFeed(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
    });
    expect(tombstoneFeed.rejectMissingAfter).toHaveBeenCalledWith('a.example');
    expect(peerStateFeed.rejectMissingAfter).toHaveBeenCalledWith('a.example');
  });
});

describe('S2sController feed-head recovery', () => {
  it('retries a transient drain failure without requiring another feed-head', async () => {
    vi.useFakeTimers();
    try {
      const { controller, federation } = target();
      federation.pullStateFromPeer
        .mockRejectedValueOnce(new Error('temporarily offline'))
        .mockResolvedValueOnce(7n);
      const req = {
        body: {
          origin: 'a.example',
          stateFeedEndId: '7',
          messageFeedEndId: '8',
          tombstoneFeedEndId: '9',
        },
        peer: { domain: 'a.example', keyId: 'a.example/key-1' },
      } as unknown as FastifyRequest;

      await controller.postDiscoveryHwm(req);
      await vi.waitFor(() =>
        expect(federation.pullStateFromPeer).toHaveBeenCalledTimes(1),
      );
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() =>
        expect(federation.pullMissedFromPeer).toHaveBeenCalledOnce(),
      );
      expect(federation.pullTombstonesFromPeer).toHaveBeenCalledWith(
        'a.example',
        7n,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
