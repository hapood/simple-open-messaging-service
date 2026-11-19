import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Test } from '@nestjs/testing';
import { FederationDownloadRecoveryService } from './federation-download-recovery.service.js';

function setup(batchIds: string[]) {
  const where = vi
    .fn()
    .mockResolvedValue(batchIds.map((batchId) => ({ batchId })));
  const innerJoin = vi.fn().mockReturnValue({ where });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin, leftJoin, where });
  const selectDistinct = vi.fn().mockReturnValue({ from });
  const recoverInboundBatch = vi.fn().mockResolvedValue({
    batchId: batchIds[0] ?? '',
    resetFiles: 0,
  });
  const keypair = {
    waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
  };
  const quota = { isExhausted: vi.fn().mockResolvedValue(false) };
  const recoverCompletedDownloads = vi.fn().mockResolvedValue(undefined);
  const service = new FederationDownloadRecoveryService(
    { db: { selectDistinct } } as never,
    { recoverInboundBatch } as never,
    keypair as never,
    quota as never,
    { recoverCompletedDownloads } as never,
  );
  return {
    service,
    recoverInboundBatch,
    recoverCompletedDownloads,
    where,
    keypair,
    quota,
    selectDistinct,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FederationDownloadRecoveryService', () => {
  it('recovers completed-task cleanup without temporary coordination and drains it on shutdown', async () => {
    const s = setup([]);
    const gate = deferred<void>();
    s.recoverCompletedDownloads.mockReturnValueOnce(gate.promise);
    const startup = s.service.onApplicationBootstrap();
    await vi.waitFor(() =>
      expect(s.recoverCompletedDownloads).toHaveBeenCalledOnce(),
    );
    const signal = s.recoverCompletedDownloads.mock.calls[0][0] as AbortSignal;
    let closed = false;
    const shutdown = s.service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    gate.resolve();
    await Promise.all([startup, shutdown]);
    expect(closed).toBe(true);
  });

  it('rejects explicit wake requests and skips automatic scans after shutdown', async () => {
    const s = setup([]);
    await s.service.beforeApplicationShutdown();
    await expect(s.service.wakeQuotaPaused(42)).rejects.toThrow(
      'download recovery shutting down',
    );
    await s.service.onApplicationBootstrap();
    await s.service.resumeQuotaPaused();
    expect(s.keypair.waitUntilInitialized).not.toHaveBeenCalled();
    expect(s.selectDistinct).not.toHaveBeenCalled();
  });

  it('waits for key initialization without starting a late startup scan', async () => {
    const s = setup(['batch-a']);
    const gate = deferred<void>();
    s.keypair.waitUntilInitialized.mockReturnValueOnce(gate.promise);
    const startup = s.service.onApplicationBootstrap();
    await vi.waitFor(() =>
      expect(s.keypair.waitUntilInitialized).toHaveBeenCalledOnce(),
    );
    let closed = false;
    const shutdown = s.service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    gate.resolve();
    await Promise.all([startup, shutdown]);
    expect(s.selectDistinct).not.toHaveBeenCalled();
  });

  it.each(['startup', 'wake'] as const)(
    'discards a late %s scan result and drains its query',
    async (mode) => {
      const s = setup([]);
      const gate = deferred<Array<{ batchId: string }>>();
      s.where.mockReturnValueOnce(gate.promise);
      const work =
        mode === 'startup'
          ? s.service.onApplicationBootstrap()
          : s.service.wakeQuotaPaused(42);
      const result =
        mode === 'startup'
          ? expect(work).resolves.toBeUndefined()
          : expect(work).rejects.toThrow('download recovery shutting down');
      await vi.waitFor(() => expect(s.where).toHaveBeenCalledOnce());
      let closed = false;
      const shutdown = s.service.beforeApplicationShutdown().then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      gate.resolve([{ batchId: 'late' }]);
      await result;
      await shutdown;
      expect(s.recoverInboundBatch).not.toHaveBeenCalled();
    },
  );

  it('does not wake quota-paused batches after a late quota lookup', async () => {
    const s = setup([]);
    s.where.mockResolvedValueOnce([{ nsid: 42 }] as never);
    const gate = deferred<boolean>();
    s.quota.isExhausted.mockReturnValueOnce(gate.promise);
    const scan = s.service.resumeQuotaPaused();
    await vi.waitFor(() => expect(s.quota.isExhausted).toHaveBeenCalledOnce());
    const shutdown = s.service.beforeApplicationShutdown();
    gate.resolve(false);
    await Promise.all([scan, shutdown]);
    expect(s.selectDistinct).toHaveBeenCalledOnce();
    expect(s.recoverInboundBatch).not.toHaveBeenCalled();
  });

  it.each(['startup', 'wake'] as const)(
    'drains admitted %s recovery without starting the next batch',
    async (mode) => {
      const s = setup(['first', 'second']);
      const gate = deferred<{ batchId: string; resetFiles: number }>();
      s.recoverInboundBatch.mockReturnValueOnce(gate.promise);
      const work =
        mode === 'startup'
          ? s.service.onApplicationBootstrap()
          : s.service.wakeQuotaPaused(42);
      const result =
        mode === 'startup'
          ? expect(work).resolves.toBeUndefined()
          : expect(work).rejects.toThrow('download recovery shutting down');
      await vi.waitFor(() =>
        expect(s.recoverInboundBatch).toHaveBeenCalledOnce(),
      );
      let closed = false;
      const shutdown = s.service.beforeApplicationShutdown().then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      gate.resolve({ batchId: 'first', resetFiles: 0 });
      await result;
      await shutdown;
      expect(s.recoverInboundBatch).toHaveBeenCalledExactlyOnceWith('first');
    },
  );

  it('preserves every real recovery error while shutdown drains all callers', async () => {
    const s = setup(['batch']);
    const first = deferred<{ batchId: string; resetFiles: number }>();
    const second = deferred<{ batchId: string; resetFiles: number }>();
    const failures = [
      new Error('first database failure'),
      new Error('second database failure'),
    ];
    s.recoverInboundBatch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const calls = [
      expect(s.service.wakeQuotaPaused(42)).rejects.toBe(failures[0]),
      expect(s.service.wakeQuotaPaused(43)).rejects.toBe(failures[1]),
    ];
    await vi.waitFor(() =>
      expect(s.recoverInboundBatch).toHaveBeenCalledTimes(2),
    );
    let closed = false;
    const closing = s.service.beforeApplicationShutdown().finally(() => {
      closed = true;
    });
    const shutdown = expect(closing).rejects.toMatchObject({
      message: 'download recovery shutdown failed',
      errors: failures,
    });
    first.reject(failures[0]);
    await calls[0];
    expect(closed).toBe(false);
    second.reject(failures[1]);
    await calls[1];
    await shutdown;
  });

  it.each(['startup', 'interval'] as const)(
    'reports a late %s query failure to shutdown instead of treating it as an abort',
    async (mode) => {
      const s = setup([]);
      const gate = deferred<Array<{ batchId: string }>>();
      const failure = new Error('recovery query failed');
      s.where.mockReturnValueOnce(gate.promise);
      const work =
        mode === 'startup'
          ? s.service.onApplicationBootstrap()
          : s.service.resumeQuotaPaused();
      await vi.waitFor(() => expect(s.where).toHaveBeenCalledOnce());
      const shutdown = expect(
        s.service.beforeApplicationShutdown(),
      ).rejects.toMatchObject({
        message: 'download recovery shutdown failed',
        errors: [failure],
      });
      gate.reject(failure);
      await work;
      await shutdown;
      expect(s.recoverInboundBatch).not.toHaveBeenCalled();
    },
  );

  it('drains recovery before Nest closes application infrastructure', async () => {
    const s = setup(['batch-a']);
    const gate = deferred<{ batchId: string; resetFiles: number }>();
    s.recoverInboundBatch.mockReturnValueOnce(gate.promise);
    const closeInfrastructure = vi.fn();
    const mod = await Test.createTestingModule({
      providers: [
        { provide: FederationDownloadRecoveryService, useValue: s.service },
        {
          provide: 'infrastructure',
          useValue: { onApplicationShutdown: closeInfrastructure },
        },
      ],
    }).compile();
    const work = expect(s.service.wakeQuotaPaused(42)).rejects.toThrow(
      'download recovery shutting down',
    );
    await vi.waitFor(() =>
      expect(s.recoverInboundBatch).toHaveBeenCalledOnce(),
    );
    const hook = vi.spyOn(s.service, 'beforeApplicationShutdown');
    const closing = mod.close();
    try {
      await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
      expect(closeInfrastructure).not.toHaveBeenCalled();
      await expect(s.service.wakeQuotaPaused(43)).rejects.toThrow(
        'download recovery shutting down',
      );
    } finally {
      gate.resolve({ batchId: 'batch-a', resetFiles: 0 });
      await work;
      await closing;
    }
    expect(closeInfrastructure).toHaveBeenCalledOnce();
  });

  it('scans every file outcome for unfinished message settlement without resetting it', async () => {
    const { service, where } = setup([]);
    await service.onApplicationBootstrap();
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain('"FileSyncProgress"."id" is not null');
    expect(query.sql).not.toContain('"FileSyncProgress"."status"');
    expect(query.params).not.toContain('FAILED');
    expect(query.params).not.toContain('DOWNLOADING');
    expect(query.params).not.toContain('SUCCEEDED');
    expect(query.params).not.toContain('STOPPED');
  });

  it('rebuilds the volatile queue for every persisted active inbound batch', async () => {
    const { service, recoverInboundBatch } = setup(['batch-a', 'batch-b']);

    await service.onApplicationBootstrap();

    expect(recoverInboundBatch).toHaveBeenNthCalledWith(1, 'batch-a');
    expect(recoverInboundBatch).toHaveBeenNthCalledWith(2, 'batch-b');
  });

  it('continues scanning when one batch cannot be resumed', async () => {
    const { service, recoverInboundBatch } = setup(['broken', 'healthy']);
    recoverInboundBatch.mockRejectedValueOnce(new Error('bad persisted row'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(recoverInboundBatch).toHaveBeenCalledTimes(2);
    expect(recoverInboundBatch).toHaveBeenLastCalledWith('healthy');
  });

  it('wakes every quota-paused batch for one peer', async () => {
    const { service, recoverInboundBatch } = setup(['paused-a', 'paused-b']);

    await expect(service.wakeQuotaPaused(42)).resolves.toBe(2);

    expect(recoverInboundBatch).toHaveBeenNthCalledWith(1, 'paused-a');
    expect(recoverInboundBatch).toHaveBeenNthCalledWith(2, 'paused-b');
  });
});
