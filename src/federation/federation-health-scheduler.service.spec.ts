import { describe, expect, it, vi } from 'vitest';
import { FederationHealthSchedulerService } from './federation-health-scheduler.service.js';

process.env.SOMS_DOMAIN = 'local.example';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function discoveryMock() {
  return {
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    refreshPeerCertificateIfNeeded: vi.fn().mockResolvedValue(false),
  } as never;
}

describe('FederationHealthSchedulerService', () => {
  it('bounds pending work and concurrent Health requests', async () => {
    const peers = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      domain: `peer-${String(index).padStart(2, '0')}.example`,
    }));
    const requests = peers.map(() => deferred());
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(peers)
      .mockResolvedValue([]);
    const checkHealth = vi.fn((domain: string) => {
      const index = peers.findIndex((row) => row.domain === domain);
      return requests[index].promise;
    });
    const scheduler = new FederationHealthSchedulerService(
      { db: { query: { identityNamespace: { findMany } } } } as never,
      { checkHealth } as never,
      discoveryMock(),
    );

    scheduler.startRound();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(4));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 32 }),
    );
    scheduler.startRound();
    expect(findMany).toHaveBeenCalledOnce();

    requests[0].resolve();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(5));
  });

  it('does not retry a failed Health request inside the same round', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, domain: 'peer.example' }])
      .mockResolvedValueOnce([]);
    const checkHealth = vi.fn().mockRejectedValue(new Error('timeout'));
    const scheduler = new FederationHealthSchedulerService(
      { db: { query: { identityNamespace: { findMany } } } } as never,
      { checkHealth } as never,
      discoveryMock(),
    );

    scheduler.startRound();
    await vi.waitFor(() => expect(findMany).toHaveBeenCalledTimes(2));

    expect(checkHealth).toHaveBeenCalledExactlyOnceWith('peer.example');
  });
});
