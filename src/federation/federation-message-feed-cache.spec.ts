import { describe, expect, it, vi } from 'vitest';
import type { FederationBufferedChange } from './federation-change-buffer.js';
import type { FederationCursorService } from './federation-cursor.service.js';
import type { FederationFeedFulfiller } from './federation-feed-fulfiller.service.js';
import {
  FederationFeedFillState,
  type FederationMemoryFeedService,
} from './federation-memory-feed.service.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';

process.env.SOMS_DOMAIN ??= 'local.test';

function change(feedId: bigint): FederationBufferedChange {
  return {
    feedId,
    threadId: 1,
    messageId: feedId,
    messageSeq: Number(feedId),
  };
}

function setup(refs: FederationBufferedChange[] = []) {
  const readAfterWhileLocked = vi.fn(() => refs);
  const retireWhileLocked = vi.fn(() => 0);
  const memoryFeed = {
    fillWhileLocked: vi.fn(async () => FederationFeedFillState.CAUGHT_UP),
    readAfterWhileLocked,
    retireWhileLocked,
    state: vi.fn(() => FederationFeedFillState.CAUGHT_UP),
    runExclusive: vi.fn(
      async (_peerDomain: string, callback: () => Promise<unknown>) =>
        callback(),
    ),
  } as unknown as FederationMemoryFeedService;
  const cursor = {
    readAllocatedThrough: vi.fn(async () => 0n),
  } as unknown as FederationCursorService;
  const fulfiller = {
    schedule: vi.fn(),
  } as unknown as FederationFeedFulfiller;
  const service = new FederationMessageFeedService(
    cursor,
    memoryFeed,
    fulfiller,
  );
  const internal = service as unknown as {
    readSnapshot(
      peerDomain: string,
      after: bigint,
      take: number,
      trunc: bigint | undefined,
      excludeSelf: boolean,
      requestEnd: bigint,
    ): FederationBufferedChange[];
    serveWithCursor: ReturnType<typeof vi.fn>;
  };
  return {
    service,
    internal,
    cursor,
    memoryFeed,
    fulfiller,
    readAfterWhileLocked,
    retireWhileLocked,
  };
}

describe('FederationMessageFeedService snapshot cache', () => {
  it('reuses a non-empty matching snapshot and returns shallow copies', () => {
    const { internal, readAfterWhileLocked } = setup([change(1n)]);

    const first = internal.readSnapshot('peer.test', 0n, 100, 9n, true, 9n);
    const second = internal.readSnapshot('peer.test', 0n, 100, 9n, true, 9n);

    expect(readAfterWhileLocked).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  it('does not cache an empty snapshot while the fulfiller may append', () => {
    const { internal, readAfterWhileLocked } = setup([]);

    internal.readSnapshot('peer.test', 0n, 100, undefined, false, 0n);
    internal.readSnapshot('peer.test', 0n, 100, undefined, false, 0n);

    expect(readAfterWhileLocked).toHaveBeenCalledTimes(2);
  });

  it('misses the cache when any request parameter changes', () => {
    const { internal, readAfterWhileLocked } = setup([change(1n)]);

    internal.readSnapshot('peer.test', 0n, 100, 9n, false, 9n);
    internal.readSnapshot('peer.test', 1n, 100, 9n, false, 9n);
    internal.readSnapshot('peer.test', 1n, 50, 9n, false, 9n);
    internal.readSnapshot('peer.test', 1n, 50, 8n, false, 8n);
    internal.readSnapshot('peer.test', 1n, 50, 8n, true, 8n);

    expect(readAfterWhileLocked).toHaveBeenCalledTimes(5);
  });

  it('schedules fill and returns retry advice without awaiting it', async () => {
    const {
      service,
      internal,
      cursor,
      memoryFeed,
      fulfiller,
      retireWhileLocked,
    } = setup();
    retireWhileLocked.mockReturnValueOnce(10);
    vi.mocked(memoryFeed.state).mockReturnValue(
      FederationFeedFillState.NEEDS_FILL,
    );
    vi.mocked(cursor.readAllocatedThrough).mockResolvedValue(10n);
    internal.serveWithCursor = vi.fn(async () => ({
      page: { messages: [], scannedThrough: '10', hasMore: false },
      acknowledgedThrough: 10n,
    }));

    const page = await service.serve('peer.test', 10n);

    expect(fulfiller.schedule).toHaveBeenCalledWith('peer.test');
    expect(page).toEqual({
      messages: [],
      scannedThrough: '10',
      hasMore: true,
      retryAfterMs: 100,
    });
  });
});
