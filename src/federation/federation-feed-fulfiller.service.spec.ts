import { describe, expect, it, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FederationCursorService } from './federation-cursor.service.js';
import { FederationFeedFulfiller } from './federation-feed-fulfiller.service.js';
import {
  FederationFeedFillState,
  FederationMemoryFeedService,
} from './federation-memory-feed.service.js';

function setup(
  initial: Record<string, FederationFeedFillState>,
  startupPeers: string[] = [],
  initialTombstones: Record<string, FederationFeedFillState> = {},
) {
  const states = new Map(Object.entries(initial));
  const tombstoneStates = new Map(Object.entries(initialTombstones));
  const fill = vi.fn(async (peerDomain: string) => {
    states.set(peerDomain, FederationFeedFillState.CAUGHT_UP);
    return FederationFeedFillState.CAUGHT_UP;
  });
  const fillQuantum = vi.fn(async (peerDomain: string, maxWork: number) => {
    states.set(peerDomain, FederationFeedFillState.CAUGHT_UP);
    return {
      state: FederationFeedFillState.CAUGHT_UP,
      work: maxWork > 0 ? 1 : 0,
    };
  });
  const memoryFeed = {
    state: vi.fn(
      (peerDomain: string) =>
        states.get(peerDomain) ?? FederationFeedFillState.NEEDS_FILL,
    ),
    fill,
    fillQuantum,
  } as unknown as FederationMemoryFeedService;
  const tombstoneFeed = {
    state: vi.fn(
      (peerDomain: string) =>
        tombstoneStates.get(peerDomain) ?? FederationFeedFillState.CAUGHT_UP,
    ),
    fill: vi.fn(async () => FederationFeedFillState.CAUGHT_UP),
    fillQuantum: vi.fn(async (peerDomain: string, maxWork: number) => {
      if (maxWork === 0) {
        return {
          state:
            tombstoneStates.get(peerDomain) ??
            FederationFeedFillState.CAUGHT_UP,
          work: 0,
        };
      }
      tombstoneStates.set(peerDomain, FederationFeedFillState.CAUGHT_UP);
      return { state: FederationFeedFillState.CAUGHT_UP, work: 1 };
    }),
  };
  const orderBy = vi.fn(async () => startupPeers.map((domain) => ({ domain })));
  const from = vi.fn(() => ({ orderBy }));
  const database = {
    db: { select: vi.fn(() => ({ from })) },
  };
  const cursor = {
    readAllocatedThrough: vi.fn(async () => 0n),
  } as unknown as FederationCursorService;
  const events = new EventEmitter2();
  const service = new FederationFeedFulfiller(
    database as never,
    memoryFeed,
    tombstoneFeed as never,
    cursor,
    events,
  );
  return {
    service,
    fill,
    fillQuantum,
    states,
    tombstoneFillQuantum: tombstoneFeed.fillQuantum,
    tombstoneStates,
  };
}

describe('FederationFeedFulfiller finite event scheduling', () => {
  it('scans startup peers once and admits only NEEDS_FILL peers', async () => {
    const { service, fillQuantum } = setup(
      {
        needs: FederationFeedFillState.NEEDS_FILL,
        full: FederationFeedFillState.FULL,
        caught: FederationFeedFillState.CAUGHT_UP,
      },
      ['needs', 'full', 'caught'],
    );

    await service.onModuleInit();
    await vi.waitFor(() => expect(fillQuantum).toHaveBeenCalledTimes(1));
    expect(fillQuantum).toHaveBeenCalledWith('needs', 500);
  });

  it('deduplicates a burst and does not recursively requeue a peer', async () => {
    const { service, fillQuantum } = setup({
      peer: FederationFeedFillState.NEEDS_FILL,
    });

    service.schedule('peer');
    service.schedule('peer');
    service.schedule('peer');
    await vi.waitFor(() => expect(fillQuantum).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fillQuantum).toHaveBeenCalledTimes(1);
  });

  it('does not spin after a failed fill', async () => {
    const { service, fillQuantum, states } = setup({
      peer: FederationFeedFillState.NEEDS_FILL,
    });
    fillQuantum.mockImplementationOnce(async () => {
      states.set('peer', FederationFeedFillState.NEEDS_FILL);
      throw new Error('transient');
    });

    service.schedule('peer');
    await vi.waitFor(() => expect(fillQuantum).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fillQuantum).toHaveBeenCalledTimes(1);
  });

  it('moves an unfinished peer behind peers already waiting', async () => {
    const peers = ['a', 'b', 'c', 'd', 'e'];
    const { service, fillQuantum, states } = setup(
      Object.fromEntries(
        peers.map((peer) => [peer, FederationFeedFillState.NEEDS_FILL]),
      ),
    );
    const visits = new Map<string, number>();
    fillQuantum.mockImplementation(
      async (peerDomain: string, maxWork: number) => {
        const visit = (visits.get(peerDomain) ?? 0) + 1;
        visits.set(peerDomain, visit);
        const state =
          peerDomain === 'a' && visit === 1
            ? FederationFeedFillState.NEEDS_FILL
            : FederationFeedFillState.CAUGHT_UP;
        states.set(peerDomain, state);
        return {
          state,
          work: state === FederationFeedFillState.NEEDS_FILL ? maxWork : 1,
        };
      },
    );

    peers.forEach((peer) => service.schedule(peer));
    await vi.waitFor(() => expect(fillQuantum).toHaveBeenCalledTimes(6));

    expect(fillQuantum.mock.calls.map(([peer]) => peer)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'a',
    ]);
  });

  it('shares one quantum and alternates message/tombstone priority', async () => {
    const {
      service,
      fillQuantum,
      states,
      tombstoneFillQuantum,
      tombstoneStates,
    } = setup({ peer: FederationFeedFillState.NEEDS_FILL }, [], {
      peer: FederationFeedFillState.NEEDS_FILL,
    });
    let messageTurns = 0;
    fillQuantum.mockImplementation(async (_peerDomain, maxWork) => {
      if (maxWork === 0) {
        return { state: FederationFeedFillState.NEEDS_FILL, work: 0 };
      }
      messageTurns++;
      const state =
        messageTurns === 1
          ? FederationFeedFillState.NEEDS_FILL
          : FederationFeedFillState.CAUGHT_UP;
      states.set('peer', state);
      return { state, work: maxWork };
    });
    tombstoneFillQuantum.mockImplementation(async (_peerDomain, maxWork) => {
      if (maxWork === 0) {
        return { state: FederationFeedFillState.NEEDS_FILL, work: 0 };
      }
      tombstoneStates.set('peer', FederationFeedFillState.CAUGHT_UP);
      return { state: FederationFeedFillState.CAUGHT_UP, work: maxWork };
    });

    service.schedule('peer');
    await vi.waitFor(() => expect(fillQuantum).toHaveBeenCalledTimes(3));

    expect(fillQuantum.mock.calls.map(([, work]) => work)).toEqual([
      500, 0, 500,
    ]);
    expect(tombstoneFillQuantum.mock.calls.map(([, work]) => work)).toEqual([
      0, 500,
    ]);
  });
});
