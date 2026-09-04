import { BusinessException } from '../common/business.exception.js';
import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedPushSchedulerService } from './federation-state-feed-push-scheduler.service.js';

function harness() {
  const federation = {
    listTrustedPeerDomains: vi.fn().mockResolvedValue([]),
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
  it('schedules each trusted peer once on startup', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, federation, client } = harness();
      federation.listTrustedPeerDomains.mockResolvedValue(['a.test', 'b.test']);

      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.send.mock.calls).toEqual([['a.test'], ['b.test']]);
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces one peer independently and enforces the minimum interval', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, client } = harness();

      scheduler.onPush({ peerDomain: 'a.test' });
      scheduler.onPush({ peerDomain: 'a.test' });
      scheduler.onPush({ peerDomain: 'b.test' });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.send.mock.calls).toEqual([['a.test'], ['b.test']]);

      scheduler.onPush({ peerDomain: 'a.test' });
      scheduler.onPush({ peerDomain: 'a.test' });
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

      scheduler.onPush({ peerDomain: 'a.test' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.send).toHaveBeenCalledTimes(2);

      scheduler.onPush({ peerDomain: 'b.test' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.send).toHaveBeenCalledTimes(3);
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
