import { describe, it, expect, vi } from 'vitest';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'soms.io';

import { FederationService } from './federation.service.js';
import type { FederationBufferService } from './federation-buffer.service.js';

const OUR = 'soms.io'; // == SOMS_DOMAIN (config.domain)

/** Build a FederationService wired with hand-rolled fakes (the project's spec style — direct
 *  construction, not the Nest DI container). Only `prisma` + `buffer` are exercised by the routing /
 *  debounce logic under test; the rest are inert stubs. */
function makeStubs() {
  const markDirty = vi.fn();
  const flushBatch = vi.fn(() => ({ entries: [], keys: [] as string[], hasMore: false }));
  const buffer = {
    markDirty,
    flushBatch,
    deleteKeys: vi.fn(),
    dropDomainIfEmpty: vi.fn(),
  } as unknown as FederationBufferService;
  const prisma = {
    messageThread: { findUnique: vi.fn() },
    threadParticipant: { findMany: vi.fn() },
  };
  const svc = new FederationService(
    prisma as never,
    {} as never, // signature
    {} as never, // discovery
    {} as never, // upload
    {} as never, // participantService
    {} as never, // message
    {} as never, // invite
    {} as never, // sse
    buffer,
  );
  return { svc, prisma, markDirty, flushBatch };
}

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
      fedGroupAccount: null,
      originDomain: null,
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
      fedGroupAccount: null,
      originDomain: null,
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
      fedGroupAccount: '!grp',
      originDomain: OUR,
      groupUser: { account: '!grp' },
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
      fedGroupAccount: '!grp',
      originDomain: 'origin.com',
      groupUser: { account: '!grp' },
    });
    prisma.threadParticipant.findMany.mockResolvedValue([localUser(1, 'alice')]);

    // A mirror's sole destination is the origin (the hub it pulls from).
    await svc.signalOutbound(10, 1, 7, undefined);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledWith('origin.com', 'alice', OUR, '!grp', 7);

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
      fedGroupAccount: null,
      originDomain: null,
      groupUser: null,
    });
    prisma.threadParticipant.findMany.mockResolvedValue([foreignUser(99, 'x', 'b.com')]);
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
        fedGroupAccount: '!grp',
        originDomain: 'origin.com',
        groupUser: { account: '!grp' },
      });
      prisma.threadParticipant.findMany.mockResolvedValue([localUser(1, 'alice')]);

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
