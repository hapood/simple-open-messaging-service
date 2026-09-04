import { describe, expect, it, vi } from 'vitest';
import { FederationHealthSchedulerService } from './federation-health-scheduler.service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('FederationHealthSchedulerService', () => {
  it('bounds pending work and concurrent Health requests', async () => {
    const domains = Array.from({ length: 12 }, (_, index) => ({
      domain: `peer-${String(index).padStart(2, '0')}.example`,
    }));
    const requests = domains.map(() => deferred());
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(domains)
      .mockResolvedValue([]);
    const checkHealth = vi.fn((domain: string) => {
      const index = domains.findIndex((row) => row.domain === domain);
      return requests[index].promise;
    });
    const scheduler = new FederationHealthSchedulerService(
      { db: { query: { federatedPeer: { findMany } } } } as never,
      { checkHealth } as never,
    );

    scheduler.scheduleRound();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(4));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 32 }),
    );
    scheduler.scheduleRound();
    expect(findMany).toHaveBeenCalledOnce();

    requests[0].resolve();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(5));
  });

  it('does not retry a failed Health request inside the same round', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ domain: 'peer.example' }])
      .mockResolvedValueOnce([]);
    const checkHealth = vi.fn().mockRejectedValue(new Error('timeout'));
    const scheduler = new FederationHealthSchedulerService(
      { db: { query: { federatedPeer: { findMany } } } } as never,
      { checkHealth } as never,
    );

    scheduler.scheduleRound();
    await vi.waitFor(() => expect(findMany).toHaveBeenCalledTimes(2));

    expect(checkHealth).toHaveBeenCalledExactlyOnceWith('peer.example');
  });
});
