import { BusinessException } from '../common/business.exception.js';
import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedPushSchedulerService } from './federation-state-feed-push-scheduler.service.js';

function harness() {
  const federation = {
    listTrustedPeerDomains: vi.fn().mockResolvedValue([]),
    pushStateFeedDomains: vi.fn().mockResolvedValue(undefined),
    activePeerDomainForNamespace: vi.fn(async (namespaceId: number) =>
      namespaceId === 1 ? 'a.test' : namespaceId === 2 ? 'b.test' : null,
    ),
  };
  const client = { send: vi.fn().mockResolvedValue(undefined) };
  return {
    federation,
    client,
    scheduler: new FederationStateFeedPushSchedulerService(
      federation as never,
      client as never,
    ),
  };
}

describe('FederationStateFeedPushSchedulerService', () => {
  it('publishes trusted peer namespaces on startup', async () => {
    const { scheduler, federation } = harness();
    federation.listTrustedPeerDomains.mockResolvedValue(['a.test', 'b.test']);

    await scheduler.onApplicationBootstrap();

    expect(federation.pushStateFeedDomains).toHaveBeenCalledWith([
      'a.test',
      'b.test',
    ]);
  });

  it('coalesces one namespace independently and enforces the minimum interval', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, client } = harness();

      scheduler.onPush({ namespaceId: 1 });
      scheduler.onPush({ namespaceId: 1 });
      scheduler.onPush({ namespaceId: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.send.mock.calls).toEqual([['a.test'], ['b.test']]);

      scheduler.onPush({ namespaceId: 1 });
      scheduler.onPush({ namespaceId: 1 });
      await vi.advanceTimersByTimeAsync(999);
      expect(client.send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.send).toHaveBeenCalledTimes(3);
      expect(client.send).toHaveBeenLastCalledWith('a.test');
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries temporary failures but drops permanent business failures', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, client } = harness();
      client.send
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new BusinessException(1000, 'permanent', 400));

      scheduler.onPush({ namespaceId: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.send).toHaveBeenCalledTimes(2);

      scheduler.onPush({ namespaceId: 2 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.send).toHaveBeenCalledTimes(3);
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
