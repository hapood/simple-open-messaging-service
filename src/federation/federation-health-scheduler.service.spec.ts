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
  it('does not start Health work until local identity initialization completes', async () => {
    let release!: () => void;
    const identityReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitUntilInitialized = vi.fn(() => identityReady);
    const findMany = vi.fn().mockResolvedValue([]);
    const scheduler = new FederationHealthSchedulerService(
      {
        db: {
          update: vi.fn(() => ({
            set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
          })),
          query: { identityNamespace: { findMany } },
        },
      } as never,
      { checkHealth: vi.fn() } as never,
      discoveryMock(),
      { waitUntilInitialized } as never,
    );
    const startup = scheduler.onApplicationBootstrap();
    await Promise.resolve();
    expect(waitUntilInitialized).toHaveBeenCalledOnce();
    expect(findMany).not.toHaveBeenCalled();
    release();
    await startup;
    scheduler.onApplicationShutdown();
  });

  it('invalidates persisted reachability before starting the first Health round', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const findMany = vi.fn().mockResolvedValue([]);
    const scheduler = new FederationHealthSchedulerService(
      {
        db: { update, query: { identityNamespace: { findMany } } },
      } as never,
      { checkHealth: vi.fn() } as never,
      discoveryMock(),
      {
        initialize: vi.fn().mockResolvedValue(undefined),
        waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
      } as never,
    );

    await scheduler.onApplicationBootstrap();
    scheduler.onApplicationShutdown();

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: 'degraded',
        remoteServiceReachable: false,
        degradationReason: 'awaiting Health after process startup',
      }),
    );
    expect(where).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(findMany).toHaveBeenCalled());
  });

  it('bounds pending work and concurrent Health requests', async () => {
    const peers = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      domain: `peer-${String(index).padStart(2, '0')}.example`,
    }));
    const requests = peers.map(() => deferred());
    const findMany = vi.fn().mockResolvedValueOnce(peers).mockResolvedValue([]);
    const checkHealth = vi.fn((domain: string) => {
      const index = peers.findIndex((row) => row.domain === domain);
      return requests[index].promise;
    });
    const scheduler = new FederationHealthSchedulerService(
      { db: { query: { identityNamespace: { findMany } } } } as never,
      { checkHealth } as never,
      discoveryMock(),
      {
        initialize: vi.fn().mockResolvedValue(undefined),
        waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
      } as never,
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
      {
        initialize: vi.fn().mockResolvedValue(undefined),
        waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
      } as never,
    );

    scheduler.startRound();
    await vi.waitFor(() => expect(findMany).toHaveBeenCalledTimes(2));

    expect(checkHealth).toHaveBeenCalledExactlyOnceWith('peer.example');
  });
});
