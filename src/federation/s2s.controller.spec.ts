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
    getLocalAccountProfile: vi.fn().mockResolvedValue({
      namespaceId: 0,
      account: 'alice',
      domain: 'local.example',
      profileRev: 5,
      displayName: 'Alice',
      bio: '',
      avatar: null,
    }),
    getAuthorizedAccountProfile: vi.fn().mockResolvedValue({
      account: 'alice',
      domain: 'local.example',
      profileRev: 4,
      displayName: 'Alice',
      bio: '',
      avatar: null,
    }),
    getAuthorizedGroupMemberProfile: vi.fn().mockResolvedValue({
      account: 'alice',
      domain: 'member.example',
      profileRev: 4,
      displayName: 'Alice',
      bio: '',
      avatar: null,
    }),
    getAuthorizedIntentProfile: vi.fn().mockResolvedValue({
      account: '!team',
      domain: 'local.example',
      profileRev: 7,
      displayName: 'Team',
      bio: '',
      avatar: null,
    }),
  };
  const messageFeedPull = { advertise: vi.fn() };
  const tombstonePull = { advertise: vi.fn() };
  const roundScheduler = { wakeStateFeed: vi.fn() };
  const messageFeed = {
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
  const groupMeta = {
    serve: vi.fn().mockResolvedValue({}),
  };
  const controller = new S2sController(
    federation as never,
    messageFeed as never,
    tombstoneFeed as never,
    {} as never,
    peerStateFeed as never,
    roundScheduler as never,
    groupMeta as never,
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
    groupMeta,
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

describe('S2sController public account profiles', () => {
  it('uses only the account path and omits the internal namespace from the response', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/accounts/alice';
    await expect(controller.getAccountProfile(req)).resolves.toEqual({
      account: 'alice',
      domain: 'local.example',
      displayName: 'Alice',
      bio: '',
      avatar: null,
      profileRev: 5,
    });
    expect(federation.getLocalAccountProfile).toHaveBeenCalledWith({
      account: 'alice',
      domain: 'local.example',
    });
  });

  it('rejects an old namespace-bearing path', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/accounts/0/alice';
    await expect(controller.getAccountProfile(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(federation.getLocalAccountProfile).not.toHaveBeenCalled();
  });
});

describe('S2sController intent profiles', () => {
  it('passes only the authenticated signer and exact path identity to intent authorization', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/intent-profiles/0/%21team/alice/7';
    expect(await controller.getIntentProfile(req)).toEqual({
      account: '!team',
      domain: 'local.example',
      displayName: 'Team',
      bio: '',
      avatar: null,
    });
    expect(federation.getAuthorizedIntentProfile).toHaveBeenCalledWith(
      '!team',
      'alice',
      0,
      7,
      'a.example',
      7,
    );
  });

  it('rejects zero and queries without consulting stored evidence', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/intent-profiles/0/%21team/alice/0';
    await expect(controller.getIntentProfile(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    req.url = '/s2s/v1/intent-profiles/0/%21team/alice/7?rev=7';
    await expect(controller.getIntentProfile(req)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(federation.getAuthorizedIntentProfile).not.toHaveBeenCalled();
  });
});

describe('S2sController account profiles', () => {
  it('passes only the exact account/revision and authenticated signer', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/account-profiles/0/alice/4';
    expect(await controller.getExactAccountProfile(req)).toMatchObject({
      account: 'alice',
      domain: 'local.example',
      displayName: 'Alice',
    });
    expect(federation.getAuthorizedAccountProfile).toHaveBeenCalledWith(
      'alice',
      0,
      4,
      'a.example',
      7,
    );
  });

  it('rejects non-canonical paths, query and zero rev', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    for (const url of [
      '/s2s/v1/account-profiles/0/alice/0',
      '/s2s/v1/account-profiles/0/%61lice/4',
      '/s2s/v1/account-profiles/0/alice/4?seq=1',
      '/s2s/v1/account-profiles/0/alice/4/extra',
    ]) {
      req.url = url;
      await expect(
        controller.getExactAccountProfile(req),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
      });
    }
    expect(federation.getAuthorizedAccountProfile).not.toHaveBeenCalled();
  });
});

describe('S2sController group member profiles', () => {
  it('passes canonical independent path variables and authenticated signer', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    req.url = '/s2s/v1/group-member-profiles/%21team/0/alice/member.example/4';
    expect(await controller.getGroupMemberProfile(req)).toEqual({
      account: 'alice',
      domain: 'member.example',
      displayName: 'Alice',
      bio: '',
      avatar: null,
    });
    expect(federation.getAuthorizedGroupMemberProfile).toHaveBeenCalledWith(
      '!team',
      'member.example',
      'alice',
      0,
      4,
      'a.example',
      7,
    );
  });

  it('rejects bad account, non-canonical encoding, zero revision and query', async () => {
    const { controller, federation } = target();
    const req = mediaRequest('');
    for (const url of [
      '/s2s/v1/group-member-profiles/alice/0/bob/member.example/4',
      '/s2s/v1/group-member-profiles/%21team/0/%61lice/member.example/4',
      '/s2s/v1/group-member-profiles/%21team/0/alice/member.example/0',
      '/s2s/v1/group-member-profiles/%21team/0/alice/member.example/4?seq=1',
    ]) {
      req.url = url;
      await expect(controller.getGroupMemberProfile(req)).rejects.toMatchObject(
        {
          bizCode: BusinessCode.FEDERATION_MALFORMED,
        },
      );
    }
    expect(federation.getAuthorizedGroupMemberProfile).not.toHaveBeenCalled();
  });
});

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
    const { controller, groupMeta } = target();
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
    expect(groupMeta.serve).toHaveBeenLastCalledWith(
      'a.example',
      undefined,
      '!01arz3ndektsv4rrffq69g5fav',
      'full',
      0,
      25,
      40,
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
    expect(groupMeta.serve).toHaveBeenLastCalledWith(
      'a.example',
      undefined,
      '!01arz3ndektsv4rrffq69g5fav',
      'delta',
      7,
      undefined,
      undefined,
    );
  });

  it('routes an omitted cursor for recovery-window discovery', async () => {
    const { controller, groupMeta } = target();
    const req = {
      query: {
        account: '!01arz3ndektsv4rrffq69g5fav',
        mode: 'full',
      },
      peer: { domain: 'a.example', keyId: 'a.example/key-1' },
    } as unknown as FastifyRequest;

    await controller.getGroupMeta(req, '!01arz3ndektsv4rrffq69g5fav', 'full');
    expect(groupMeta.serve).toHaveBeenLastCalledWith(
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
    const { controller, groupMeta } = target();
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
    expect(groupMeta.serve).not.toHaveBeenCalled();
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
