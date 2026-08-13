import { describe, expect, it, vi } from 'vitest';
import { FederationService } from './federation.service.js';

function serviceWithStateCursor(committedThrough: bigint): FederationService {
  const service = Object.create(
    FederationService.prototype,
  ) as FederationService;
  Object.assign(service, {
    database: {
      db: {
        query: {
          peerStateFeedPullCursor: {
            findFirst: vi.fn().mockResolvedValue({ committedThrough }),
          },
        },
      },
    },
  });
  return service;
}

describe('federation state/message drain barrier', () => {
  it('does not start message pull before the durable state cursor reaches the hinted revision', async () => {
    const service = serviceWithStateCursor(4n);
    const run = vi.fn();

    await expect(
      service.pullMissedFromPeer({ run } as never, 'peer.test', 5n),
    ).rejects.toThrow('state cursor reaches 5');

    expect(run).not.toHaveBeenCalled();
  });

  it('allows message pull once the durable state cursor satisfies the barrier', async () => {
    const service = serviceWithStateCursor(5n);
    const run = vi.fn().mockResolvedValue(undefined);

    await service.pullMissedFromPeer({ run } as never, 'peer.test', 5n);

    expect(run).toHaveBeenCalledOnce();
  });
});
