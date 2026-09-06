import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { S2sController } from './s2s.controller.js';

function target() {
  const federation = {
    ourDomain: 'local.example',
    resolveMediaFile: vi.fn().mockResolvedValue({
      absPath: '/unused',
      bytes: 16,
    }),
    pullStateFromPeer: vi.fn().mockResolvedValue(0n),
    pullTombstonesFromPeer: vi.fn().mockResolvedValue(undefined),
    pullMissedFromPeer: vi.fn().mockResolvedValue(undefined),
    getStoredUserProfile: vi.fn().mockResolvedValue({
      account: 'alice',
      domain: 'member.example',
      profileRev: 4,
      displayName: 'Alice',
      bio: 'Member biography',
      avatar: null,
    }),
  };
  const messageFeedPull = { advertise: vi.fn() };
  const tombstonePull = { advertise: vi.fn() };
  const roundScheduler = { wakeStateFeed: vi.fn() };
  const messageFeed = {
    resolveAuthorProfileReference: vi.fn(),
    query: vi
      .fn()
      .mockResolvedValue({ messages: [], scannedThrough: 1, hasMore: false }),
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
  const groupMetaFeed = {
    serve: vi.fn().mockResolvedValue({}),
    resolveAllocatedMemberProfile: vi
      .fn()
      .mockResolvedValue({ memberNamespaceId: 12 }),
  };
  const controller = new S2sController(
    federation as never,
    messageFeed as never,
    tombstoneFeed as never,
    {} as never,
    peerStateFeed as never,
    roundScheduler as never,
    groupMetaFeed as never,
  );
  return {
    controller,
    federation,
    messageFeed,
    tombstoneFeed,
    peerStateFeed,
    messageFeedPull,
    tombstonePull,
    roundScheduler,
    groupMetaFeed,
  };
}

function mediaRequest(range: string): FastifyRequest {
  return {
    method: 'GET',
    url: `/s2s/v1/media/${'a'.repeat(64)}?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42`,
    rawBody: Buffer.alloc(0),
    headers: { range },
    peer: {
      domain: 'a.example',
      keyId: 'a.example/key-1',
      namespaceId: 7,
    },
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

describe('S2sController reverse thread queries', () => {
  it('passes before as the exclusive reverse message cursor', async () => {
    const { controller, messageFeed } = target();
    const req = {
      query: { account: 'alice', peerAccount: 'bob', before: '3' },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;

    await controller.queryMessages(req, 'alice', 'bob', undefined, '3');
    expect(messageFeed.query).toHaveBeenCalledWith(
      'a.example',
      7,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      undefined,
      undefined,
      undefined,
      true,
      3,
    );
  });

  it('accepts only the one-past-maximum sentinel for an exclusive before cursor', async () => {
    const { controller, messageFeed } = target();
    const accepted = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        before: '9007199254740991',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;

    await controller.queryMessages(
      accepted,
      'alice',
      'bob',
      undefined,
      '9007199254740991',
    );
    expect(messageFeed.query).toHaveBeenLastCalledWith(
      'a.example',
      7,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      undefined,
      undefined,
      undefined,
      true,
      Number.MAX_SAFE_INTEGER,
    );

    const rejected = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        before: '9007199254740992',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;
    await expect(
      controller.queryMessages(
        rejected,
        'alice',
        'bob',
        undefined,
        '9007199254740992',
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });

  it('rejects supplying after and before together', async () => {
    const { controller } = target();
    const req = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        after: '1',
        before: '3',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;

    await expect(
      controller.queryMessages(req, 'alice', 'bob', '1', '3'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });

  it('passes includeSelf to the tombstone query implementation', async () => {
    const { controller, tombstoneFeed } = target();
    const req = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        after: '1',
        includeSelf: 'false',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;

    await controller.queryMessageTombstones(
      req,
      'alice',
      'bob',
      '1',
      undefined,
      undefined,
      'false',
    );
    expect(tombstoneFeed.query).toHaveBeenCalledWith(
      'a.example',
      7,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      1,
      undefined,
      undefined,
      false,
      undefined,
    );
  });

  it('passes maxMessageSeq and rejects the removed reverse direction', async () => {
    const { controller, tombstoneFeed } = target();
    const req = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        after: '1',
        through: '9',
        maxMessageSeq: '42',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;

    await controller.queryMessageTombstones(
      req,
      'alice',
      'bob',
      '1',
      undefined,
      '9',
      undefined,
      '42',
    );
    expect(tombstoneFeed.query).toHaveBeenCalledWith(
      'a.example',
      7,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      1,
      undefined,
      9,
      true,
      42,
    );

    const reverse = {
      query: {
        account: 'alice',
        peerAccount: 'bob',
        before: '3',
        maxMessageSeq: '2',
      },
      peer: {
        domain: 'a.example',
        keyId: 'a.example/key-1',
        namespaceId: 7,
      },
    } as unknown as FastifyRequest;
    await expect(
      controller.queryMessageTombstones(reverse, 'alice', 'bob'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });
});

describe('S2sController group-meta modes', () => {
  it('routes both modes with the common feed pagination parameters', async () => {
    const { controller, groupMetaFeed } = target();
    const fullReq = {
      query: {
        account: '!01arz3ndektsv4rrffq69g5fav',
        mode: 'full',
        after: '0',
        take: '25',
        through: '40',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;
    await controller.getGroupMeta(
      fullReq,
      '!01arz3ndektsv4rrffq69g5fav',
      'full',
      '0',
      '25',
      '40',
    );
    expect(groupMetaFeed.serve).toHaveBeenLastCalledWith(
      'a.example',
      undefined,
      '!01arz3ndektsv4rrffq69g5fav',
      'full',
      0n,
      25,
      40n,
    );

    const deltaReq = {
      query: {
        account: '!01arz3ndektsv4rrffq69g5fav',
        mode: 'delta',
        after: '7',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;
    await controller.getGroupMeta(
      deltaReq,
      '!01arz3ndektsv4rrffq69g5fav',
      'delta',
      '7',
    );
    expect(groupMetaFeed.serve).toHaveBeenLastCalledWith(
      'a.example',
      undefined,
      '!01arz3ndektsv4rrffq69g5fav',
      'delta',
      7n,
      undefined,
      undefined,
    );
  });

  it('routes an omitted cursor for recovery-window discovery', async () => {
    const { controller, groupMetaFeed } = target();
    const req = {
      query: {
        account: '!01arz3ndektsv4rrffq69g5fav',
        mode: 'full',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await controller.getGroupMeta(req, '!01arz3ndektsv4rrffq69g5fav', 'full');
    expect(groupMetaFeed.serve).toHaveBeenLastCalledWith(
      'a.example',
      undefined,
      '!01arz3ndektsv4rrffq69g5fav',
      'full',
      undefined,
      undefined,
      undefined,
    );
  });

  it('rejects another page parameter when after is omitted', async () => {
    const { controller, groupMetaFeed } = target();
    const req = {
      query: {
        account: '!01arz3ndektsv4rrffq69g5fav',
        mode: 'full',
        take: '25',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(
      controller.getGroupMeta(
        req,
        '!01arz3ndektsv4rrffq69g5fav',
        'full',
        undefined,
        '25',
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(groupMetaFeed.serve).not.toHaveBeenCalled();
  });
});

describe('S2sController message author profiles', () => {
  it('keeps requester authorization separate from a third-party author namespace', async () => {
    const { controller, federation, messageFeed } = target();
    messageFeed.resolveAuthorProfileReference.mockResolvedValueOnce({
      account: 'carol',
      domain: 'charlie.test',
      namespaceId: 3,
      profileRev: 7,
    });
    const req = {
      query: { account: '!group', messageSeq: '12' },
      peer: { domain: 'bravo.test', namespaceId: 2 },
    } as unknown as FastifyRequest;
    await controller.getMessageAuthorProfile(req, '!group', undefined, '12');
    expect(messageFeed.resolveAuthorProfileReference).toHaveBeenCalledWith(
      'bravo.test',
      2,
      { type: 'GROUP', account: '!group' },
      12,
    );
    expect(federation.getStoredUserProfile).toHaveBeenCalledWith(
      'carol',
      'charlie.test',
      3,
      7,
    );
  });

  it('does not read profiles when message authorization fails', async () => {
    const { controller, federation, messageFeed } = target();
    const refusal = Object.assign(new Error('forbidden'), {
      bizCode: BusinessCode.FORBIDDEN,
    });
    messageFeed.resolveAuthorProfileReference.mockRejectedValueOnce(refusal);
    const req = {
      query: { account: '!group', messageSeq: '12' },
      peer: { domain: 'bravo.test', namespaceId: 2 },
    } as unknown as FastifyRequest;
    await expect(
      controller.getMessageAuthorProfile(req, '!group', undefined, '12'),
    ).rejects.toBe(refusal);
    expect(federation.getStoredUserProfile).not.toHaveBeenCalled();
  });

  it('reads a locally authored message profile from namespace zero', async () => {
    const { controller, federation, messageFeed } = target();
    messageFeed.resolveAuthorProfileReference.mockResolvedValueOnce({
      account: 'alice',
      domain: 'local.example',
      namespaceId: 0,
      profileRev: 4,
    });
    federation.getStoredUserProfile.mockResolvedValueOnce({
      account: 'alice',
      domain: 'local.example',
      profileRev: 4,
      displayName: 'Alice',
      bio: '',
      avatar: null,
    });
    const req = {
      method: 'GET',
      url: '/s2s/v1/message-author-profile?account=alice&peerAccount=bob&messageSeq=12',
      query: { account: 'alice', peerAccount: 'bob', messageSeq: '12' },
      peer: { domain: 'peer.example', namespaceId: 7 },
    } as unknown as FastifyRequest;

    await controller.getMessageAuthorProfile(req, 'alice', 'bob', '12');

    expect(federation.getStoredUserProfile).toHaveBeenCalledWith(
      'alice',
      'local.example',
      0,
      4,
    );
  });
});

describe('S2sController group member profiles', () => {
  it('uses the exact Group Meta allocation and returns the complete profile', async () => {
    const { controller, federation, groupMetaFeed } = target();
    const req = {
      method: 'GET',
      url: '/s2s/v1/group-member-profile?account=%21group&memberAccount=alice&memberDomain=member.example&rev=4',
      rawBody: Buffer.alloc(0),
      headers: {},
      peer: { domain: 'mirror.example', namespaceId: 7 },
    } as unknown as FastifyRequest;

    await expect(controller.getGroupMemberProfile(req)).resolves.toEqual({
      account: 'alice',
      domain: 'member.example',
      profileRev: 4,
      displayName: 'Alice',
      bio: 'Member biography',
      avatar: null,
    });
    expect(groupMetaFeed.resolveAllocatedMemberProfile).toHaveBeenCalledWith(
      'mirror.example',
      7,
      '!group',
      'alice',
      'member.example',
      4,
    );
    expect(federation.getStoredUserProfile).toHaveBeenCalledWith(
      'alice',
      'member.example',
      12,
      4,
    );
  });

  it('rejects a zero revision before reading an allocation', async () => {
    const { controller, groupMetaFeed } = target();
    const req = {
      method: 'GET',
      url: '/s2s/v1/group-member-profile?account=%21group&memberAccount=alice&memberDomain=member.example&rev=0',
      rawBody: Buffer.alloc(0),
      headers: {},
      peer: { domain: 'mirror.example', namespaceId: 7 },
    } as unknown as FastifyRequest;

    await expect(controller.getGroupMemberProfile(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(groupMetaFeed.resolveAllocatedMemberProfile).not.toHaveBeenCalled();
  });
});

describe('S2sController feed-head recovery', () => {
  it('rejects unknown fields without scheduling work', async () => {
    const { controller, roundScheduler } = target();
    const req = {
      body: { origin: 'a.example', stateFeedEndId: '7' },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await expect(controller.postDiscoveryHwm(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(roundScheduler.wakeStateFeed).not.toHaveBeenCalled();
  });

  it('validates and forwards the publisher target to the global scheduler', async () => {
    const { controller, roundScheduler } = target();
    const req = {
      body: { stateFeedEndId: '11' },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await controller.postDiscoveryHwm(req);

    expect(roundScheduler.wakeStateFeed).toHaveBeenCalledExactlyOnceWith(
      'a.example',
      11n,
    );
  });
});
