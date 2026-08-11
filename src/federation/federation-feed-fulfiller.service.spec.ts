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
) {
  const states = new Map(Object.entries(initial));
  const fill = vi.fn(async (peerDomain: string) => {
    states.set(peerDomain, FederationFeedFillState.CAUGHT_UP);
    return FederationFeedFillState.CAUGHT_UP;
  });
  const memoryFeed = {
    state: vi.fn(
      (peerDomain: string) =>
        states.get(peerDomain) ?? FederationFeedFillState.NEEDS_FILL,
    ),
    fill,
  } as unknown as FederationMemoryFeedService;
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
    cursor,
    events,
  );
  return { service, fill, states };
}

describe('FederationFeedFulfiller finite event scheduling', () => {
  it('scans startup peers once and admits only NEEDS_FILL peers', async () => {
    const { service, fill } = setup(
      {
        needs: FederationFeedFillState.NEEDS_FILL,
        full: FederationFeedFillState.FULL,
        caught: FederationFeedFillState.CAUGHT_UP,
      },
      ['needs', 'full', 'caught'],
    );

    await service.onModuleInit();
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
    expect(fill).toHaveBeenCalledWith('needs');
  });

  it('deduplicates a burst and does not recursively requeue a peer', async () => {
    const { service, fill } = setup({
      peer: FederationFeedFillState.NEEDS_FILL,
    });

    service.schedule('peer');
    service.schedule('peer');
    service.schedule('peer');
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('does not spin after a failed fill', async () => {
    const { service, fill, states } = setup({
      peer: FederationFeedFillState.NEEDS_FILL,
    });
    fill.mockImplementationOnce(async () => {
      states.set('peer', FederationFeedFillState.NEEDS_FILL);
      throw new Error('transient');
    });

    service.schedule('peer');
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fill).toHaveBeenCalledTimes(1);
  });
});
