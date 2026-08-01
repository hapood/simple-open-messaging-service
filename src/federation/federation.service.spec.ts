import { describe, it, expect, vi } from 'vitest';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'soms.io';

import { FederationService } from './federation.service.js';
import type { FederationBufferService } from './federation-buffer.service.js';
import { message, pendingMedia } from '../database/schema.js';

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
  const prisma = {
    messageThread: { findUnique: vi.fn() },
    threadParticipant: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
  };
  const database = {
    db: {
      query: {
        messageThread: {
          findFirst: async (...args: unknown[]) => {
            const row = await prisma.messageThread.findUnique(...args);
            return row ? { ...row, user: row.groupUser } : row;
          },
        },
        threadParticipant: { findMany: prisma.threadParticipant.findMany },
        message: {
          findMany: async (...args: unknown[]) =>
            (await prisma.message.findMany(...args)).map((row) => ({
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
    {} as never, // sse
    {} as never, // threadRevisionService
    buffer,
    {} as never, // quota
    {} as never, // linkPreview
    { emitAsync: vi.fn().mockResolvedValue(undefined), emit: vi.fn() } as never, // eventEmitter
  );
  return { svc, prisma, markDirty, flushBatch };
}

describe('FederationService quote coordinates', () => {
  it('maps a local quote seq to creator identity + originSeq for the wire', async () => {
    const { svc, prisma } = makeStubs();
    prisma.message.findMany.mockResolvedValue([
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
    const { svc, prisma } = makeStubs();
    prisma.message.findMany.mockResolvedValue([
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
    const { svc, prisma, markDirty } = makeStubs();
    prisma.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    prisma.threadParticipant.findMany.mockResolvedValue([
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
    const { svc, prisma, markDirty } = makeStubs();
    prisma.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    prisma.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(10, 1, 5, 'b.com');

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith('c.com', 'alice', OUR, 'carol', 5);
  });

  it('GROUP origin: signals every foreign member-DOMAIN (deduped) except the fetch source', async () => {
    const { svc, prisma, markDirty } = makeStubs();
    prisma.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'local' },
    });
    // Two members on b.com (bob + dave) + one on c.com → dest set dedupes to {b.com, c.com}.
    prisma.threadParticipant.findMany.mockResolvedValue([
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
    const { svc, prisma, markDirty } = makeStubs();
    prisma.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'origin.com' },
    });
    prisma.threadParticipant.findMany.mockResolvedValue([
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
    const { svc, prisma, markDirty } = makeStubs();

    prisma.messageThread.findUnique.mockResolvedValue(null);
    prisma.threadParticipant.findMany.mockResolvedValue([]);
    await svc.signalOutbound(10, 1, 5, undefined);
    expect(markDirty).not.toHaveBeenCalled();

    prisma.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    prisma.threadParticipant.findMany.mockResolvedValue([
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
      const { svc, prisma, flushBatch } = makeStubs();
      prisma.messageThread.findUnique.mockResolvedValue({
        groupUser: { account: '!grp', domain: 'origin.com' },
      });
      prisma.threadParticipant.findMany.mockResolvedValue([
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
    const prisma = {
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
              const row = await prisma.messageThread.findUnique();
              return row ? { ...row, user: row.groupUser } : row;
            },
          },
          user: { findFirst: prisma.user.findUnique },
        },
        select: (_selection: unknown) => {
          let table: unknown;
          const query = {
            from: (value: unknown) => { table = value; return query; },
            where: async () => {
              const result = table === message
                ? await prisma.message.aggregate()
                : await prisma.pendingMedia.aggregate();
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
