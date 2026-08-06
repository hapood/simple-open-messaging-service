import { describe, it, expect, vi } from 'vitest';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'soms.io';

import { FederationService, S2sResponseError } from './federation.service.js';
import type { FederationBufferService } from './federation-buffer.service.js';
import { message, pendingMedia } from '../database/schema.js';
import { MessageDeleteType } from '../database/enums.js';
import { BusinessCode } from '../common/business-code.js';

const OUR = 'soms.io'; // == SOMS_DOMAIN (config.domain)

/** Build a FederationService wired with hand-rolled fakes (the project's spec style — direct
 *  construction, not the Nest DI container). Only the database fake + `buffer` are exercised by the routing /
 *  debounce logic under test; the rest are inert stubs. */
function makeStubs() {
  const markDirty = vi.fn();
  const flushBatch = vi.fn(() => ({
    entries: [],
    keys: [] as string[],
    hasMore: false,
  }));
  const buffer = {
    markDirty,
    flushBatch,
    deleteKeys: vi.fn(),
    dropDomainIfEmpty: vi.fn(),
  } as unknown as FederationBufferService;
  const store = {
    messageThread: { findUnique: vi.fn() },
    threadParticipant: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    federationDeletedCursor: { findFirst: vi.fn().mockResolvedValue(null) },
    deletedParticipant: { findFirst: vi.fn() },
  };
  const sse = { onDeletedMessageUpdated: vi.fn() };
  const deletedMessages = {
    applyFederated: vi.fn(),
    advanceFederatedCursor: vi.fn(),
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
      },
    },
  };
  const svc = new FederationService(
    database as never,
    {} as never, // signature
    {} as never, // discovery
    {} as never, // upload
    {} as never, // participantService
    {} as never, // message
    {} as never, // invite
    sse as never,
    {} as never, // threadRevisionService
    buffer,
    {} as never, // quota
    {} as never, // linkPreview
    {} as never, // forwardBundles
    {} as never, // messageVisibility
    deletedMessages as never,
    { emitAsync: vi.fn().mockResolvedValue(undefined), emit: vi.fn() } as never, // eventEmitter
  );
  return {
    svc,
    database,
    store,
    markDirty,
    flushBatch,
    sse,
    deletedMessages,
  };
}

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
        trustLevel: 'trusted',
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
    ['reset domain', false, 'reset_in_progress'],
    ['truncated thread', true, 'trusted'],
  ])('does not send for a %s', async (_label, truncated, trustLevel) => {
    const { target, getSigned } = installPreflight({
      federationTruncated: truncated,
      federationVersion: 7,
      trustLevel,
    });

    await expect(
      target.getSignedForThread(10, '/messages', 'peer.test'),
    ).rejects.toThrow('federation thread 10 is unavailable');
    expect(getSigned).not.toHaveBeenCalled();
  });

  it('attaches the captured version to an application error response', async () => {
    const { target, getSigned } = installPreflight({
      federationTruncated: false,
      federationVersion: 7,
      trustLevel: 'trusted',
    });
    getSigned.mockRejectedValueOnce(
      new S2sResponseError('gone', 410, BusinessCode.GROUP_DISSOLVED),
    );

    await expect(
      target.getSignedForThread(10, '/messages', 'peer.test'),
    ).rejects.toMatchObject({
      status: 410,
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
      messages: [],
      scannedThrough: '9',
      allocatedThrough: '9',
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
      '/api/v1/s2s/missed?after=7&take=100',
      'peer.test',
      16 * 1024 * 1024,
    );
  });

  it.each([
    [-1n, 100],
    [0n, 0],
    [0n, 201],
    [0n, 1.5],
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
      trustLevel: 'trusted',
    });

    await expect(
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(innerJoin).toHaveBeenCalledOnce();
  });

  it.each([
    ['changed version', false, 8, 'trusted'],
    ['truncated thread', true, 7, 'trusted'],
    ['reset domain', false, 7, 'reset_in_progress'],
  ])(
    'rejects a stale response for a %s',
    async (_label, truncated, version, trustLevel) => {
      const { target, tx } = installWriteGate({
        federationTruncated: truncated,
        federationVersion: version,
        trustLevel,
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
      trustLevel: 'trusted',
      resetGeneration: 3,
      rootKeyFingerprint: 'sha256:root-a',
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
      trustLevel: 'trusted',
      resetGeneration: generation,
      rootKeyFingerprint: root,
    });

    await expect(target.assertPeerResponseWritable(tx, token)).rejects.toThrow(
      'stale federation response',
    );
  });
});

describe('FederationService quote coordinates', () => {
  it('maps a local quote seq to creator identity + originSeq for the wire', async () => {
    const { svc, store } = makeStubs();
    store.message.findMany.mockResolvedValue([
      {
        seq: 7,
        originSeq: 3,
        creatorItem: {
          account: 'alice',
          domain: 'local',
          isForeigner: false,
        },
      },
    ]);
    const quoteTargetsForWire = (
      svc as unknown as {
        quoteTargetsForWire: (
          threadId: number,
          messages: Array<{
            seq: number;
            contentType: 'PURE_TEXT';
            content: string;
          }>,
        ) => Promise<
          Map<
            number,
            {
              creator: { account: string; domain: string };
              originSeq: number;
            }
          >
        >;
      }
    ).quoteTargetsForWire.bind(svc);

    const result = await quoteTargetsForWire(10, [
      {
        seq: 12,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'reply', quote: { seq: 7 } }),
      },
    ]);

    expect(result.get(12)).toEqual({
      creator: { account: 'alice', domain: OUR },
      originSeq: 3,
    });
  });

  it('rejects a quote target without a stable originSeq', async () => {
    const { svc, store } = makeStubs();
    store.message.findMany.mockResolvedValue([
      {
        seq: 7,
        originSeq: null,
        creatorItem: {
          account: 'alice',
          domain: 'local',
          isForeigner: false,
        },
      },
    ]);
    const quoteTargetsForWire = (
      svc as unknown as {
        quoteTargetsForWire: (
          threadId: number,
          messages: Array<{
            seq: number;
            contentType: 'PURE_TEXT';
            content: string;
          }>,
        ) => Promise<Map<number, unknown>>;
      }
    ).quoteTargetsForWire.bind(svc);

    await expect(
      quoteTargetsForWire(10, [
        {
          seq: 12,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'reply', quote: { seq: 7 } }),
        },
      ]),
    ).rejects.toThrow('quoted message has no federated coordinate');
  });

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
    const { svc, store, markDirty } = makeStubs();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 5, undefined);

    expect(markDirty).toHaveBeenCalledTimes(2);
    expect(markDirty).toHaveBeenCalledWith('b.com', 'alice', OUR, 'bob', 5);
    expect(markDirty).toHaveBeenCalledWith('c.com', 'alice', OUR, 'carol', 5);
  });

  it('P2P: excludes fetchedFromDomain (a pulled message does not re-notify its source)', async () => {
    const { svc, store, markDirty } = makeStubs();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 5, 'b.com');

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith('c.com', 'alice', OUR, 'carol', 5);
  });

  it('GROUP origin: signals every foreign member-DOMAIN (deduped) except the fetch source', async () => {
    const { svc, store, markDirty } = makeStubs();
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

    expect(markDirty).toHaveBeenCalledTimes(2);
    expect(markDirty).toHaveBeenCalledWith('b.com', 'alice', OUR, '!grp', 7);
    expect(markDirty).toHaveBeenCalledWith('c.com', 'alice', OUR, '!grp', 7);

    // ...and the fetch source is excluded (the origin re-signals everyone EXCEPT where it pulled from).
    markDirty.mockClear();
    await svc.signalOutbound(10, 1, 7, 'b.com');
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith('c.com', 'alice', OUR, '!grp', 7);
  });

  it('GROUP mirror: signals ONLY {originDomain} — and nothing when that was the fetch source', async () => {
    const { svc, store, markDirty } = makeStubs();
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'origin.com' },
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
    ]);

    // A mirror's sole destination is the origin (the hub it pulls from).
    await svc.signalOutbound(10, 1, 7, undefined);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith(
      'origin.com',
      'alice',
      OUR,
      '!grp',
      7,
    );

    // ...which is exactly the domain it just pulled from → excluded → signals nothing (loop closed).
    markDirty.mockClear();
    await svc.signalOutbound(10, 1, 7, 'origin.com');
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('is a no-op when the thread is missing or the author is not a participant', async () => {
    const { svc, store, markDirty } = makeStubs();

    store.messageThread.findUnique.mockResolvedValue(null);
    store.threadParticipant.findMany.mockResolvedValue([]);
    await svc.signalOutbound(10, 1, 5, undefined);
    expect(markDirty).not.toHaveBeenCalled();

    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      foreignUser(99, 'x', 'b.com'),
    ]);
    await svc.signalOutbound(10, 1, 5, undefined); // author 1 is not in the roster
    expect(markDirty).not.toHaveBeenCalled();
  });
});

describe('FederationService sender debounce (scheduleFlush / flushDomain)', () => {
  it('collapses a same-domain burst into ONE flush (one timer per dest domain)', async () => {
    vi.useFakeTimers();
    try {
      const { svc, store, flushBatch } = makeStubs();
      store.messageThread.findUnique.mockResolvedValue({
        groupUser: { account: '!grp', domain: 'origin.com' },
      });
      store.threadParticipant.findMany.mockResolvedValue([
        localUser(1, 'alice'),
      ]);

      // A burst of three sends to the same dest domain (origin.com).
      await svc.signalOutbound(10, 1, 1, undefined);
      await svc.signalOutbound(10, 1, 2, undefined);
      await svc.signalOutbound(10, 1, 3, undefined);

      // Not flushed until the 500ms debounce window elapses.
      expect(flushBatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);

      // The whole burst collapsed to a single flush (one timer fired → one flushDomain → one flushBatch).
      expect(flushBatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FederationService.notifyGroupLeave — mirror-leave → origin per-author hint', () => {
  // The leave producer: a MIRROR member's leave nudges the ORIGIN with a normal per-author hint whose
  // latestSeq beats the origin's derived cursor (MAX(Message ∪ PendingMedia) for the leaver) so the pull —
  // and the FEDERATION_GROUP_AUTHOR_LEFT dissolution — always fires. No-op when we are the origin or the
  // group is non-federated (the origin's own leave is already on the canonical roster; mirrors catch up via
  // the lazy roster meta-pull).

  function makeSvc(opts: {
    thread: { groupUser: { account: string; domain: string } | null } | null;
    leaver: { account: string; domain: string; isForeigner: boolean } | null;
    maxMsg?: number | null;
    maxPending?: number | null;
  }) {
    const markDirty = vi.fn();
    const buffer = {
      markDirty,
      flushBatch: vi.fn(() => ({
        entries: [],
        keys: [] as string[],
        hasMore: false,
      })),
      deleteKeys: vi.fn(),
      dropDomainIfEmpty: vi.fn(),
    } as unknown as FederationBufferService;
    const store = {
      messageThread: { findUnique: vi.fn(async () => opts.thread) },
      user: { findUnique: vi.fn(async () => opts.leaver) },
      message: {
        aggregate: vi.fn(async () => ({
          _max: { originSeq: opts.maxMsg ?? null },
        })),
      },
      pendingMedia: {
        aggregate: vi.fn(async () => ({
          _max: { originSeq: opts.maxPending ?? null },
        })),
      },
    };
    const database = {
      db: {
        query: {
          messageThread: {
            findFirst: async () => {
              const row = await store.messageThread.findUnique();
              return row ? { ...row, user: row.groupUser } : row;
            },
          },
          user: { findFirst: store.user.findUnique },
        },
        select: (_selection: unknown) => {
          let table: unknown;
          const query = {
            from: (value: unknown) => {
              table = value;
              return query;
            },
            where: async () => {
              const result =
                table === message
                  ? await store.message.aggregate()
                  : await store.pendingMedia.aggregate();
              return [{ originSeq: result._max.originSeq }];
            },
          };
          return query;
        },
      },
    };
    const svc = new FederationService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      buffer,
      {} as never, // quota
      {} as never, // linkPreview
      {
        emitAsync: vi.fn().mockResolvedValue(undefined),
        emit: vi.fn(),
      } as never, // eventEmitter
    );
    return { svc, markDirty };
  }

  it('MIRROR thread: pushes a per-author hint to the origin, latestSeq = cursor+1 (local leaver w/ history)', async () => {
    const { svc, markDirty } = makeSvc({
      thread: { groupUser: { account: '!grp', domain: 'origin.com' } },
      leaver: { account: 'bob', domain: 'local', isForeigner: false },
      maxMsg: 5, // bob authored up to originSeq 5 on the mirror
    });
    await svc.notifyGroupLeave(10, 42);
    // cursor = MAX(5, -1) = 5 → latestSeq 6 (beats the origin's per-author cursor so the probe fires).
    // The leaver is local → its wire domain is OUR.
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith('origin.com', 'bob', OUR, '!grp', 6);
  });

  it('MIRROR thread, leaver authored nothing: latestSeq floors at 0 (cursor -1 → 0 still beats -1)', async () => {
    const { svc, markDirty } = makeSvc({
      thread: { groupUser: { account: '!grp', domain: 'origin.com' } },
      leaver: { account: 'bob', domain: 'local', isForeigner: false },
      // no maxMsg/maxPending → both null → cursor -1 → latestSeq 0
    });
    await svc.notifyGroupLeave(10, 42);
    expect(markDirty).toHaveBeenCalledWith('origin.com', 'bob', OUR, '!grp', 0);
  });

  it('PendingMedia is included in the cursor (a staged-but-uncommitted media bumps latestSeq past it)', async () => {
    const { svc, markDirty } = makeSvc({
      thread: { groupUser: { account: '!grp', domain: 'origin.com' } },
      leaver: { account: 'bob', domain: 'local', isForeigner: false },
      maxMsg: 3,
      maxPending: 7, // a staged media at originSeq 7 → cursor 7 → latestSeq 8
    });
    await svc.notifyGroupLeave(10, 42);
    expect(markDirty).toHaveBeenCalledWith('origin.com', 'bob', OUR, '!grp', 8);
  });

  it('ORIGIN thread (we are the origin — groupUser.domain is the "local" sentinel): no hint pushed', async () => {
    const { svc, markDirty } = makeSvc({
      thread: { groupUser: { account: '!grp', domain: 'local' } },
      leaver: { account: 'bob', domain: 'local', isForeigner: false },
    });
    await svc.notifyGroupLeave(10, 42);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('non-federated group (no groupUser): no hint pushed', async () => {
    const { svc, markDirty } = makeSvc({
      thread: { groupUser: null },
      leaver: { account: 'bob', domain: 'local', isForeigner: false },
    });
    await svc.notifyGroupLeave(10, 42);
    expect(markDirty).not.toHaveBeenCalled();
  });
});

describe('FederationService federated friend-invite revoke', () => {
  it('sends the required shared invite id to the recipient server', async () => {
    const { svc } = makeStubs();
    vi.spyOn(svc as never, 'requireLocalUser' as never).mockResolvedValue({
      account: 'alice',
    } as never);
    const postSigned = vi
      .spyOn(svc as never, 'postSigned' as never)
      .mockResolvedValue(undefined as never);

    await svc.sendInviteRevoke({
      fromLocalUserId: 1,
      to: { account: 'bob', domain: 'peer.test' },
      inviteOriginId: 'shared-op-id',
    });

    expect(postSigned).toHaveBeenCalledOnce();
    const [path, rawBody, domain] = postSigned.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(path).toBe('/api/v1/s2s/invite-revoke');
    expect(domain).toBe('peer.test');
    expect(JSON.parse(rawBody)).toMatchObject({
      origin: OUR,
      kind: 'FRIEND',
      from: { account: 'alice', domain: OUR },
      to: { account: 'bob', domain: 'peer.test' },
      inviteOriginId: 'shared-op-id',
    });
  });

  it('applies an inbound signed revoke once and ignores an operation replay', async () => {
    const { svc } = makeStubs();
    const peek = vi.fn().mockResolvedValue(undefined);
    const revokeInboundFriendInvite = vi.fn().mockResolvedValue(undefined);
    (svc as unknown as { quota: unknown }).quota = { peek };
    (svc as unknown as { invite: unknown }).invite = {
      revokeInboundFriendInvite,
    };
    vi.spyOn(svc as never, 'ensureForeignUser' as never).mockResolvedValue(
      2 as never,
    );
    vi.spyOn(
      svc as never,
      'findLocalUserIdByAddress' as never,
    ).mockResolvedValue(1 as never);
    const seen = vi.spyOn(svc as never, 'isOpSeen' as never);
    seen
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);
    const body = {
      id: 'revoke-op',
      origin: 'peer.test',
      ts: Date.now(),
      kind: 'FRIEND' as const,
      from: { account: 'bob', domain: 'peer.test' },
      to: { account: 'alice', domain: OUR },
      inviteOriginId: 'shared-op-id',
    };

    await svc.handleInviteRevoke(body);
    await svc.handleInviteRevoke(body);

    expect(peek).toHaveBeenCalledTimes(2);
    expect(revokeInboundFriendInvite).toHaveBeenCalledOnce();
    expect(revokeInboundFriendInvite).toHaveBeenCalledWith({
      fromUserId: 2,
      toUserId: 1,
      origin: 'peer.test',
      originId: 'shared-op-id',
    });
  });
});

describe('FederationService durable deletion pull', () => {
  const deletion = (overrides: Record<string, unknown> = {}) => ({
    id: '8',
    type: MessageDeleteType.WITHDRAW,
    target: {
      creator: { account: 'bob', domain: 'peer.test' },
      originSeq: 17,
    },
    deletedAt: Date.now(),
    ...overrides,
  });

  async function pull(
    svc: FederationService,
    pages: Array<{ deletions: unknown[]; hasMore: boolean }>,
    streamKind: 'p2p-author' | 'group-origin' | 'group-author' = 'p2p-author',
  ) {
    const getSigned = vi.fn();
    for (const page of pages)
      getSigned.mockResolvedValueOnce({
        data: page,
        federationVersion: 4,
      });
    const target = svc as unknown as {
      getSignedForThread: typeof getSigned;
      pullDeletedStream: (params: unknown) => Promise<void>;
    };
    target.getSignedForThread = getSigned;
    await target.pullDeletedStream({
      threadId: 10,
      sourceDomain: 'peer.test',
      streamAccount: 'bob',
      streamKind,
      path: (afterId: bigint) => `/deleted?afterId=${afterId}`,
      expectedCreator:
        streamKind === 'p2p-author'
          ? { account: 'bob', domain: 'peer.test' }
          : undefined,
      recipients: [1, 3],
    });
    return getSigned;
  }

  it('applies an authoritative tombstone, advances from the durable cursor, and wakes recipients', async () => {
    const { svc, store, deletedMessages, sse } = makeStubs();
    store.federationDeletedCursor.findFirst.mockResolvedValue({
      deletedHwm: 7n,
    });
    store.deletedParticipant.findFirst.mockResolvedValue({ userId: 22 });
    deletedMessages.applyFederated.mockResolvedValue({ id: '31', seq: 4 });
    const signalOutbound = vi
      .spyOn(svc, 'signalOutbound')
      .mockResolvedValue(undefined);

    const getSigned = await pull(svc, [
      { deletions: [deletion()], hasMore: false },
    ]);

    expect(getSigned.mock.calls[0]).toEqual([
      10,
      '/deleted?afterId=7',
      'peer.test',
    ]);
    expect(deletedMessages.applyFederated).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 10,
        creatorId: 22,
        originSeq: 17,
        authorityDomain: 'peer.test',
        sourceDomain: 'peer.test',
        remoteDeletedId: 8n,
        expectedFederationVersion: 4,
      }),
    );
    expect(sse.onDeletedMessageUpdated.mock.calls).toEqual([
      [1, 10, '31'],
      [3, 10, '31'],
    ]);
    expect(signalOutbound).toHaveBeenCalledWith(10, 22, 17, 'peer.test');
  });

  it('rejects a peer attempting to delete a message owned by this server', async () => {
    const { svc, deletedMessages } = makeStubs();

    await expect(
      pull(svc, [
        {
          deletions: [
            deletion({
              target: {
                creator: { account: 'alice', domain: OUR },
                originSeq: 17,
              },
            }),
          ],
          hasMore: false,
        },
      ]),
    ).rejects.toThrow('peer is not authoritative for deletion target');
    expect(deletedMessages.applyFederated).not.toHaveBeenCalled();
  });

  it('consumes a group-origin relay of our own tombstone without changing local message state', async () => {
    const { svc, deletedMessages, sse } = makeStubs();

    await pull(
      svc,
      [
        {
          deletions: [
            deletion({
              target: {
                creator: { account: 'alice', domain: OUR },
                originSeq: 17,
              },
            }),
          ],
          hasMore: false,
        },
      ],
      'group-origin',
    );

    expect(deletedMessages.advanceFederatedCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteDeletedId: 8n,
        threadId: 10,
        expectedFederationVersion: 4,
      }),
    );
    expect(deletedMessages.applyFederated).not.toHaveBeenCalled();
    expect(sse.onDeletedMessageUpdated).not.toHaveBeenCalled();
  });

  it('rejects replayed or out-of-order deletion ids before applying them', async () => {
    const { svc, store, deletedMessages } = makeStubs();
    store.federationDeletedCursor.findFirst.mockResolvedValue({
      deletedHwm: 8n,
    });

    await expect(
      pull(svc, [{ deletions: [deletion()], hasMore: false }]),
    ).rejects.toThrow('federated deletion stream is not ordered');
    expect(deletedMessages.applyFederated).not.toHaveBeenCalled();
  });

  it('rejects an empty page that claims another page exists', async () => {
    const { svc } = makeStubs();

    await expect(pull(svc, [{ deletions: [], hasMore: true }])).rejects.toThrow(
      'empty federated deletion page has more pages',
    );
  });
});
