import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { FederationInboundMessageEffectsService } from './federation-inbound-message-effects.service.js';
import type { FederationMessagePageEffect } from './federation-inbound-message-page.service.js';

function setup() {
  const batches = { runFileSyncBatch: vi.fn().mockResolvedValue(undefined) };
  const localization = {
    resolveForwardAssetAuth: vi
      .fn()
      .mockResolvedValue({
        fromAccount: 'alice',
        fromDomain: 'peer.test',
        toAccount: 'bob',
        sourceSeq: 7,
      }),
    localizeForwardAssets: vi.fn().mockResolvedValue(true),
  };
  const forward = {
    rebuildUntrustedCards: vi.fn().mockResolvedValue(undefined),
  };
  const profiles = { resolveDemand: vi.fn().mockResolvedValue(undefined) };
  const projections = { resolve: vi.fn().mockResolvedValue(undefined) };
  const service = new FederationInboundMessageEffectsService(
    {} as never,
    batches as never,
    localization as never,
    forward as never,
    {} as never,
    profiles as never,
    projections as never,
  );
  const effect: FederationMessagePageEffect = {
    kind: 'pending',
    batchId: 'batch-a',
    seq: 1,
    originSeq: 7,
    historical: false,
    threadId: 3,
    recipients: [],
    toAccount: 'bob',
    author: { account: 'alice', namespaceId: 1 },
  };
  const forwardEffect: FederationMessagePageEffect = {
    ...effect,
    kind: 'message',
    message: { id: 1n, seq: 1, isDeleted: false } as never,
    forwardClosure: {} as never,
    remoteForwardBundleId: 'remote',
  };
  return {
    service,
    batches,
    effect,
    localization,
    forward,
    profiles,
    projections,
    forwardEffect,
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

describe('inbound message effects lifecycle', () => {
  it.each(['authorization', 'rebuild', 'localization'] as const)(
    'waits for admitted %s work and rejects late results after shutdown',
    async (stage) => {
      const s = setup();
      const gate = deferred<never>();
      const operation =
        stage === 'authorization'
          ? s.localization.resolveForwardAssetAuth
          : stage === 'rebuild'
            ? s.forward.rebuildUntrustedCards
            : s.localization.localizeForwardAssets;
      operation.mockReturnValueOnce(gate.promise);
      if (stage === 'rebuild')
        Object.assign(s.service, {
          config: { forwardedResourcePolicy: 'rebuild' },
        });
      const work = expect(
        s.service.publish('peer.test', [
          { ...s.forwardEffect, localForwardBundleId: 1n },
        ]),
      ).rejects.toThrow('inbound message effects shutting down');
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      let closed = false;
      const closing = s.service.beforeApplicationShutdown().then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      gate.resolve(undefined as never);
      await work;
      await closing;
      if (stage !== 'localization')
        expect(s.localization.localizeForwardAssets).not.toHaveBeenCalled();
    },
  );

  it('preserves a late foreground failure for both the caller and shutdown', async () => {
    const s = setup();
    const gate = deferred<never>();
    const failure = new Error('authorization database failed');
    s.localization.resolveForwardAssetAuth.mockReturnValueOnce(gate.promise);
    const work = expect(
      s.service.publish('peer.test', [s.forwardEffect]),
    ).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(s.localization.resolveForwardAssetAuth).toHaveBeenCalledOnce(),
    );
    const closing = expect(
      s.service.beforeApplicationShutdown(),
    ).rejects.toMatchObject({
      message: 'inbound message effects shutdown failed',
      errors: [failure],
    });
    gate.reject(failure);
    await work;
    await closing;
  });

  it('drains all background work and reports failures before Nest closes infrastructure', async () => {
    const s = setup();
    const batch = deferred<void>();
    const profile = deferred<void>();
    const projection = deferred<void>();
    const failure = new Error('background cleanup failed');
    s.batches.runFileSyncBatch.mockReturnValueOnce(batch.promise);
    s.profiles.resolveDemand.mockReturnValueOnce(profile.promise);
    s.projections.resolve.mockReturnValueOnce(projection.promise);
    const closeDatabase = vi.fn();
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: 'database',
          useValue: { onApplicationShutdown: closeDatabase },
        },
        {
          provide: FederationInboundMessageEffectsService,
          useValue: s.service,
        },
      ],
    }).compile();
    await s.service.publish('peer.test', [
      {
        ...s.effect,
        profileDemand: {} as never,
        profileEvidenceProjection: {} as never,
      },
    ]);
    expect(s.batches.runFileSyncBatch).toHaveBeenCalledOnce();
    expect(s.profiles.resolveDemand).toHaveBeenCalledOnce();
    expect(s.projections.resolve).toHaveBeenCalledOnce();
    const hook = vi.spyOn(s.service, 'beforeApplicationShutdown');
    const closing = mod.close();
    try {
      await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
      expect(closeDatabase).not.toHaveBeenCalled();
      batch.reject(failure);
      profile.resolve();
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          'Inbound download batch batch-a failed',
          failure,
        ),
      );
      expect(closeDatabase).not.toHaveBeenCalled();
    } finally {
      batch.resolve();
      profile.resolve();
      projection.resolve();
      await closing;
      log.mockRestore();
    }
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('logs the original background batch error with its identity', async () => {
    const s = setup();
    const failure = new AggregateError(
      [new Error('writer cleanup failed')],
      'download stop failed',
    );
    s.batches.runFileSyncBatch.mockRejectedValueOnce(failure);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      await s.service.publish('peer.test', [s.effect]);
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledExactlyOnceWith(
          'Inbound download batch batch-a failed',
          failure,
        ),
      );
      expect(s.batches.runFileSyncBatch).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('rejects new effects after shutdown without starting download work', async () => {
    const s = setup();
    await s.service.beforeApplicationShutdown();
    await expect(s.service.publish('peer.test', [s.effect])).rejects.toThrow(
      'inbound message effects shutting down',
    );
    expect(s.batches.runFileSyncBatch).not.toHaveBeenCalled();
  });

  it('does not admit another batch when shutdown occurs during page dispatch', async () => {
    const s = setup();
    let closing!: Promise<void>;
    s.batches.runFileSyncBatch.mockImplementationOnce(async () => {
      closing = s.service.beforeApplicationShutdown();
    });
    await s.service.publish('peer.test', [
      s.effect,
      { ...s.effect, batchId: 'batch-b' },
    ]);
    await closing;
    expect(s.batches.runFileSyncBatch).toHaveBeenCalledOnce();
  });
});
