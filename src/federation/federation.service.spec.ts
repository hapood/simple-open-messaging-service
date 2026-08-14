import { describe, it, expect, vi } from 'vitest';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'soms.io';

import { FederationService, S2sResponseError } from './federation.service.js';
import { BusinessCode } from '../common/business-code.js';

const OUR = 'soms.io'; // == SOMS_DOMAIN (config.domain)

/** Build a FederationService wired with hand-rolled fakes (the project's spec style — direct
 *  construction, not the Nest DI container). */
function makeStubs() {
  const store = {
    messageThread: { findUnique: vi.fn() },
    threadParticipant: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    federationDeletedCursor: { findFirst: vi.fn().mockResolvedValue(null) },
    deletedParticipant: { findFirst: vi.fn() },
  };
  const sse = { onDeletedMessageUpdated: vi.fn() };
  const deletedMessages = {
    applyFederated: vi.fn(),
    advanceFederatedCursor: vi.fn(),
  };
  const eventEmitter = {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
  };
  const recognition = {
    markReachable: vi.fn(),
    markTransportDegraded: vi.fn(),
  };
  const database = {
    db: {
      query: {
        messageThread: {
          findFirst: async (...args: unknown[]) => {
            const row = await store.messageThread.findUnique(...args);
            return row ? { ...row, user: row.groupUser } : row;
          },
        },
        threadParticipant: {
          findMany: store.threadParticipant.findMany,
          findFirst: store.deletedParticipant.findFirst,
        },
        federationDeletedCursor: {
          findFirst: store.federationDeletedCursor.findFirst,
        },
        message: {
          findMany: async (...args: unknown[]) =>
            (await store.message.findMany(...args)).map((row) => ({
              ...row,
              user: row.creatorItem,
            })),
        },
        mediaAsset: {
          findFirst: store.mediaAsset.findFirst,
        },
      },
    },
  };
  const svc = new FederationService(
    database as never,
    {} as never, // signature
    { request: (...args: Parameters<typeof fetch>) => fetch(...args) } as never, // discovery
    {} as never, // upload
    {} as never, // participantService
    {} as never, // message
    {} as never, // invite
    sse as never,
    {} as never, // threadRevisionService
    {} as never, // quota
    {} as never, // linkPreview
    {} as never, // forwardBundles
    {} as never, // messageVisibility
    deletedMessages as never,
    eventEmitter as never,
    recognition as never,
    { readAllocatedThrough: vi.fn().mockResolvedValue(0n) } as never, // federationCursor
    {} as never, // downloadScheduler
    {} as never, // stateFeedPull
    {} as never, // stateFeed
    {} as never, // groupMembershipState
  );
  return {
    svc,
    database,
    store,
    sse,
    deletedMessages,
    eventEmitter,
    recognition,
  };
}

describe('FederationService inbound call preflight', () => {
  it('short-circuits an incoming retry before resolving either account', async () => {
    const { svc, eventEmitter } = makeStubs();
    eventEmitter.emitAsync.mockResolvedValueOnce([true]);
    const frame = {
      callSid: '550e8400-e29b-41d4-a716-446655440000',
      op: 'incoming' as const,
      callType: 'AUDIO' as const,
      payload: { fromAccount: 'alice', toAccount: 'bob' },
    };

    await svc.handleCallFrame(frame, 'peer.example', 1_700_000_300);

    expect(eventEmitter.emitAsync).toHaveBeenCalledExactlyOnceWith(
      'call.frame.incoming.preflight',
      { peerDomain: 'peer.example', frame },
    );
  });
});

describe('FederationService state-feed drain window', () => {
  it('does not retain a stale through bound in the coalesced pull worker', async () => {
    const { svc } = makeStubs();
    const pullStateFeedPage = vi.fn().mockResolvedValue({
      items: [],
      scannedThrough: '5',
      stateFeedEndId: '5',
      hasMore: false,
    });
    const target = svc as unknown as {
      stateFeedPull: {
        advertise: (domain: string, revision: bigint) => void;
        run: (
          domain: string,
          callbacks: { fetch: (after?: bigint) => Promise<unknown> },
        ) => Promise<void>;
      };
      pullStateFeedPage: typeof pullStateFeedPage;
      sweepFederatedMemberProfiles: (domain: string) => Promise<void>;
      readStatePullCursor: (domain: string) => Promise<bigint>;
    };
    target.stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(async (_domain, callbacks) => {
        await callbacks.fetch(2n);
      }),
    };
    target.pullStateFeedPage = pullStateFeedPage;
    target.sweepFederatedMemberProfiles = vi.fn().mockResolvedValue(undefined);
    target.readStatePullCursor = vi.fn().mockResolvedValue(5n);

    await svc.pullStateFromPeer('peer.test', 5n);

    expect(pullStateFeedPage).toHaveBeenCalledWith(
      'peer.test',
      2n,
      100,
    );
  });
});

describe('FederationService optional range digest', () => {
  function target() {
    const { svc, recognition } = makeStubs();
    const privateService = svc as unknown as {
      signature: { signOutbound: () => Record<string, string> };
      requestRangeUnit: (
        url: URL,
        domain: string,
        start: number,
        end: number,
      ) => Promise<{ contentDigest?: string }>;
    };
    privateService.signature = { signOutbound: () => ({}) };
    return { privateService, recognition };
  }

  it('accepts a valid 206 range when the peer omits the optional digest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('abc', {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/3' },
      }),
    );
    await expect(
      target().privateService.requestRangeUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).resolves.toMatchObject({ contentDigest: undefined });
    fetchMock.mockRestore();
  });

  it('rejects a supplied malformed range digest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('abc', {
        status: 206,
        headers: {
          'content-range': 'bytes 0-2/3',
          'content-digest': 'not-a-digest',
        },
      }),
    );
    await expect(
      target().privateService.requestRangeUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).rejects.toThrow('invalid Content-Digest');
    fetchMock.mockRestore();
  });

  it('surfaces an HTTP 200 JSON NOT_FOUND as a business error without demoting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.NOT_FOUND,
          message: 'file unavailable',
          data: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { privateService, recognition } = target();
    await expect(
      privateService.requestRangeUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).rejects.toMatchObject({ status: 200, code: BusinessCode.NOT_FOUND });
    expect(recognition.markReachable).toHaveBeenCalledOnce();
    expect(recognition.markTransportDegraded).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('accepts only the registered JSON envelope for a 416 response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
          message: 'requested range is not satisfiable',
          data: null,
        }),
        {
          status: 416,
          headers: {
            'content-type': 'application/json',
            'content-range': 'bytes */3',
          },
        },
      ),
    );
    await expect(
      target().privateService.requestRangeUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        3,
        5,
      ),
    ).rejects.toMatchObject({
      status: 416,
      code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
    });
    fetchMock.mockRestore();
  });
});

describe('FederationService JSON error data', () => {
  it('preserves structured data from an HTTP 200 business error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
          message: 'peer quota exceeded',
          data: { retryAfter: 60 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { svc } = makeStubs();
    const target = svc as unknown as {
      signature: { signOutbound: () => Record<string, string> };
      discovery: {
        resolveBase: (domain: string) => Promise<string>;
        request: typeof fetch;
      };
      getSigned(path: string, domain: string): Promise<unknown>;
    };
    target.signature = { signOutbound: () => ({}) };
    target.discovery = {
      resolveBase: async () => 'https://peer.test',
      request: (...args) => fetch(...args),
    };

    await expect(
      target.getSigned('/resource', 'peer.test'),
    ).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
      data: { retryAfter: 60 },
    });
    fetchMock.mockRestore();
  });
});

describe('FederationService CAS error classification', () => {
  const digest = 'f'.repeat(64);

  function target() {
    const { svc, store } = makeStubs();
    return {
      resolveCasFile: (
        svc as unknown as {
          resolveCasFile(
            value: string,
          ): Promise<{ absPath: string; bytes: number }>;
        }
      ).resolveCasFile.bind(svc),
      store,
    };
  }

  it('reports a missing database record as the NOT_FOUND business outcome', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockResolvedValueOnce(undefined);

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 200,
      bizCode: BusinessCode.NOT_FOUND,
    });
  });

  it('reports a missing CAS file as the NOT_FOUND business outcome', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockResolvedValueOnce({ bytes: 1n });

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 200,
      bizCode: BusinessCode.NOT_FOUND,
    });
  });

  it('reports an indeterminate database failure as a retryable service error', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockRejectedValueOnce(new Error('offline'));

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 503,
      bizCode: BusinessCode.INTERNAL,
    });
  });
});

describe('FederationService thread-bound S2S preflight', () => {
  function installPreflight(state: {
    federationTruncated: boolean;
    federationVersion: number;
    trustLevel: string;
  }) {
    const { svc, database } = makeStubs();
    const limit = vi.fn().mockResolvedValue([state]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute, select }),
    );
    (database.db as { transaction?: typeof transaction }).transaction =
      transaction;
    const getSigned = vi.fn().mockResolvedValue({ messages: [] });
    const target = svc as unknown as {
      getSigned: typeof getSigned;
      withTrustedPeer: <T>(
        domain: string,
        action: () => Promise<T>,
      ) => Promise<T>;
      getSignedForThread: <T>(
        threadId: number,
        path: string,
        domain: string,
      ) => Promise<{ data: T; federationVersion: number }>;
    };
    target.getSigned = getSigned;
    target.withTrustedPeer = (_domain, action) => action();
    return { target, getSigned, execute, select, innerJoin, transaction };
  }

  it('takes the shared reset lock, performs one joined state read, and carries the captured version', async () => {
    const { target, getSigned, execute, select, innerJoin, transaction } =
      installPreflight({
        federationTruncated: false,
        federationVersion: 7,
        trustLevel: 'available',
      });

    await expect(
      target.getSignedForThread<{ messages: unknown[] }>(
        10,
        '/messages',
        'peer.test',
      ),
    ).resolves.toEqual({ data: { messages: [] }, federationVersion: 7 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(innerJoin).toHaveBeenCalledOnce();
    expect(getSigned).toHaveBeenCalledWith('/messages', 'peer.test', undefined);
  });

  it.each([
    ['reset domain', false, 'halted', true],
    ['truncated thread', true, 'available', false],
  ])(
    'does not send for a %s',
    async (_label, truncated, trustLevel, resetInProgress) => {
      const { target, getSigned } = installPreflight({
        federationTruncated: truncated,
        federationVersion: 7,
        trustLevel,
        resetInProgress,
      });

      await expect(
        target.getSignedForThread(10, '/messages', 'peer.test'),
      ).rejects.toThrow('federation thread 10 is unavailable');
      expect(getSigned).not.toHaveBeenCalled();
    },
  );

  it('attaches the captured version to an application error response', async () => {
    const { target, getSigned } = installPreflight({
      federationTruncated: false,
      federationVersion: 7,
      trustLevel: 'available',
    });
    getSigned.mockRejectedValueOnce(
      new S2sResponseError('gone', 200, BusinessCode.GROUP_DISSOLVED),
    );

    await expect(
      target.getSignedForThread(10, '/messages', 'peer.test'),
    ).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.GROUP_DISSOLVED,
      federationVersion: 7,
    });
  });
});

describe('FederationService global missed transport', () => {
  it('captures the peer generation before issuing the signed page request', async () => {
    const { svc } = makeStubs();
    const token = {
      domain: 'peer.test',
      resetGeneration: 3,
      rootKeyFingerprint: 'sha256:test',
    };
    const page = {
      items: [],
      scannedThrough: '9',
      messageFeedEndId: '9',
      hasMore: false,
    };
    const order: string[] = [];
    const target = svc as unknown as {
      capturePeerResponseToken: (domain: string) => Promise<typeof token>;
      withTrustedPeer: <T>(
        domain: string,
        action: () => Promise<T>,
      ) => Promise<T>;
      getSigned: <T>(
        path: string,
        domain: string,
        maxResponseBytes?: number,
      ) => Promise<T>;
      pullMissedPage: (
        domain: string,
        after: bigint,
        take?: number,
      ) => Promise<{ page: typeof page; token: typeof token }>;
    };
    target.capturePeerResponseToken = vi.fn(async () => {
      order.push('token');
      return token;
    });
    target.withTrustedPeer = vi.fn(async (_domain, action) => action());
    target.getSigned = vi.fn(async () => {
      order.push('request');
      return page;
    });

    await expect(target.pullMissedPage('peer.test', 7n, 100)).resolves.toEqual({
      page,
      token,
    });
    expect(order).toEqual(['token', 'request']);
    expect(target.getSigned).toHaveBeenCalledWith(
      '/s2s/v1/message-feed?after=7&take=100',
      'peer.test',
      16 * 1024 * 1024,
    );
  });

  it.each([
    [0n, 0],
    [0n, 1.5],
    [0n, Number.MAX_SAFE_INTEGER + 1],
  ])(
    'rejects invalid cursor/page input before network I/O',
    async (after, take) => {
      const { svc } = makeStubs();
      const target = svc as unknown as {
        capturePeerResponseToken: ReturnType<typeof vi.fn>;
        pullMissedPage: (
          domain: string,
          after: bigint,
          take?: number,
        ) => Promise<unknown>;
      };
      target.capturePeerResponseToken = vi.fn();
      await expect(
        target.pullMissedPage('peer.test', after, take),
      ).rejects.toThrow();
      expect(target.capturePeerResponseToken).not.toHaveBeenCalled();
    },
  );
});

describe('FederationService thread-bound response write gate', () => {
  function installWriteGate(state: {
    federationTruncated: boolean;
    federationVersion: number;
    trustLevel: string;
  }) {
    const { svc } = makeStubs();
    const limit = vi.fn().mockResolvedValue([state]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const execute = vi.fn().mockResolvedValue(undefined);
    const target = svc as unknown as {
      assertThreadResponseWritable: (
        tx: unknown,
        threadId: number,
        domain: string,
        version: number,
      ) => Promise<void>;
    };
    return {
      target,
      tx: { execute, select },
      execute,
      select,
      innerJoin,
    };
  }

  it('accepts the response only while the joined reset state and version still match', async () => {
    const { target, tx, execute, select, innerJoin } = installWriteGate({
      federationTruncated: false,
      federationVersion: 7,
      trustLevel: 'available',
    });

    await expect(
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(innerJoin).toHaveBeenCalledOnce();
  });

  it.each([
    ['changed version', false, 8, 'available', false],
    ['truncated thread', true, 7, 'available', false],
    ['reset domain', false, 7, 'halted', true],
  ])(
    'rejects a stale response for a %s',
    async (_label, truncated, version, trustLevel, resetInProgress) => {
      const { target, tx } = installWriteGate({
        federationTruncated: truncated,
        federationVersion: version,
        trustLevel,
        resetInProgress,
      });

      await expect(
        target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
      ).rejects.toThrow('stale federation response');
    },
  );
});

describe('FederationService peer-bound response write gate', () => {
  const token = {
    domain: 'peer.test',
    resetGeneration: 3,
    rootKeyFingerprint: 'sha256:root-a',
  };

  function installPeerGate(state: {
    trustLevel: string;
    resetGeneration: number;
    rootKeyFingerprint: string | null;
    recognizesPeer?: boolean;
    outboundRecognitionConfirmed?: boolean;
    inboundRecognitionConfirmed?: boolean;
    localServiceAvailable?: boolean;
  }) {
    const { svc } = makeStubs();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [state] });
    const target = svc as unknown as {
      assertPeerResponseWritable: (
        tx: { execute: typeof execute },
        value: typeof token,
      ) => Promise<void>;
    };
    return { target, tx: { execute } };
  }

  it('accepts a response while generation and root identity still match', async () => {
    const { target, tx } = installPeerGate({
      trustLevel: 'available',
      resetGeneration: 3,
      rootKeyFingerprint: 'sha256:root-a',
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
    });

    await expect(
      target.assertPeerResponseWritable(tx, token),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['reset generation changed', 4, 'sha256:root-a'],
    ['root identity changed', 3, 'sha256:root-b'],
  ])('rejects a stale response when %s', async (_label, generation, root) => {
    const { target, tx } = installPeerGate({
      trustLevel: 'available',
      resetGeneration: generation,
      rootKeyFingerprint: root,
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
    });

    await expect(target.assertPeerResponseWritable(tx, token)).rejects.toThrow(
      'stale federation response',
    );
  });
});

describe('FederationService quote coordinates', () => {
  it('maps a wire creator + originSeq back to the receiver local seq', async () => {
    const { svc } = makeStubs();
    const legacy = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 22, domain: 'peer.example', isForeigner: true },
          ]),
      },
      message: { findUnique: vi.fn().mockResolvedValue({ seq: 41 }) },
    };
    const tx = {
      query: {
        user: { findMany: legacy.user.findMany },
        message: { findFirst: legacy.message.findUnique },
      },
    };
    const resolveLocalQuoteSeq = (
      svc as unknown as {
        resolveLocalQuoteSeq: (
          tx: unknown,
          threadId: number,
          target: {
            creator: { account: string; domain: string };
            originSeq: number;
          },
        ) => Promise<number>;
      }
    ).resolveLocalQuoteSeq.bind(svc);

    await expect(
      resolveLocalQuoteSeq(tx, 10, {
        creator: { account: 'alice', domain: 'peer.example' },
        originSeq: 7,
      }),
    ).resolves.toBe(41);
    expect(legacy.message.findUnique).toHaveBeenCalled();
  });
});

const localUser = (userId: number, account: string) => ({
  userId,
  user: { account, domain: 'local', isForeigner: false },
});
const foreignUser = (userId: number, account: string, domain: string) => ({
  userId,
  user: { account, domain, isForeigner: true },
});

describe('FederationService.signalOutbound — the loop-safety routing rule', () => {
  // The ONE rule that closes both back-notify paths: dest domains MINUS fetchedFromDomain. A mirror
  // pulling from origin signals nothing (its only dest IS its fetch source); the origin re-signals
  // every foreign domain EXCEPT the source. P2P: each foreign peer except the author + the source.

  it('P2P: signals every foreign peer except the author', async () => {
    const { svc, store } = makeStubs();
    const push = vi.spyOn(svc, 'pushDiscoveryHwm').mockResolvedValue();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 5, undefined);

    expect(push.mock.calls).toEqual([['b.com'], ['c.com']]);
  });

  it('P2P: excludes fetchedFromDomain (a pulled message does not re-notify its source)', async () => {
    const { svc, store } = makeStubs();
    const push = vi.spyOn(svc, 'pushDiscoveryHwm').mockResolvedValue();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 5, 'b.com');

    expect(push).toHaveBeenCalledExactlyOnceWith('c.com');
  });

  it('GROUP origin: signals every foreign member-DOMAIN (deduped) except the fetch source', async () => {
    const { svc, store } = makeStubs();
    const push = vi.spyOn(svc, 'pushDiscoveryHwm').mockResolvedValue();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'local' },
    });
    // Two members on b.com (bob + dave) + one on c.com → dest set dedupes to {b.com, c.com}.
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(4, 'dave', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 7, undefined);

    expect(push.mock.calls).toEqual([['b.com'], ['c.com']]);

    // ...and the fetch source is excluded (the origin re-signals everyone EXCEPT where it pulled from).
    push.mockClear();
    await svc.signalOutbound(10, 1, 7, 'b.com');
    expect(push).toHaveBeenCalledExactlyOnceWith('c.com');
  });

  it('GROUP mirror: signals ONLY {originDomain} — and nothing when that was the fetch source', async () => {
    const { svc, store } = makeStubs();
    const push = vi.spyOn(svc, 'pushDiscoveryHwm').mockResolvedValue();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'origin.com' },
    });
    store.threadParticipant.findMany.mockResolvedValue([localUser(1, 'alice')]);

    // A mirror's sole destination is the origin (the hub it pulls from).
    await svc.signalOutbound(10, 1, 7, undefined);
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com');

    // ...which is exactly the domain it just pulled from → excluded → signals nothing (loop closed).
    push.mockClear();
    await svc.signalOutbound(10, 1, 7, 'origin.com');
    expect(push).not.toHaveBeenCalled();
  });

  it('is a no-op when the thread is missing or the author is not a participant', async () => {
    const { svc, store } = makeStubs();
    const push = vi.spyOn(svc, 'pushDiscoveryHwm').mockResolvedValue();

    store.messageThread.findUnique.mockResolvedValue(null);
    store.threadParticipant.findMany.mockResolvedValue([]);
    await svc.signalOutbound(10, 1, 5, undefined);
    expect(push).not.toHaveBeenCalled();

    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      foreignUser(99, 'x', 'b.com'),
    ]);
    await svc.signalOutbound(10, 1, 5, undefined); // author 1 is not in the roster
    expect(push).not.toHaveBeenCalled();
  });
});
