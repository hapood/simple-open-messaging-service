import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationResetService } from './federation-reset.service.js';

const counts = {
  foreignUserCount: 2,
  participantCount: 3,
  affectedThreadCount: 2,
  authoredMessageCount: 7,
  inviteCount: 1,
  deletionCursorCount: 2,
  keyCacheCount: 1,
  friendOperationCount: 5,
};

function makeService(peer?: Record<string, unknown>) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: peer ? [peer] : [] })
    .mockResolvedValueOnce({ rows: [counts] });
  const tx = { execute };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
  };
  return {
    service: new FederationResetService(database as never, {} as never),
    execute,
  };
}

function makeStartService(results: { rows: unknown[] }[]) {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  const tx = { execute };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
  };
  return {
    service: new FederationResetService(database as never, {} as never),
    execute,
    transaction: database.db.transaction,
  };
}

describe('FederationResetService', () => {
  it('previews only an idle identity-mismatch halted peer under the reset transaction lock', async () => {
    const { service, execute } = makeService({
      trustLevel: 'halted',
      haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      resetInProgress: false,
      haltReason: 'pinned root changed',
    });

    await expect(service.preview('Peer.Example.')).resolves.toMatchObject({
      domain: 'peer.example',
      haltReason: 'pinned root changed',
      ...counts,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('refuses reset preview for a peer that is not halted for identity mismatch', async () => {
    const { service } = makeService({
      trustLevel: 'available',
      haltCode: null,
      resetInProgress: false,
      haltReason: null,
    });

    await expect(service.preview('peer.example')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });

  it('freezes an identity-mismatch halted domain and marks its related threads', async () => {
    const { service, execute } = makeStartService([
      { rows: [] },
      {
        rows: [
          {
            domain: 'peer.example',
            trustLevel: 'halted',
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            resetInProgress: false,
          },
        ],
      },
      { rows: [{ threadId: 11 }, { threadId: 12 }] },
      { rows: [] },
      { rows: [] },
    ]);

    await expect(
      service.start('Peer.Example.', 'peer.example'),
    ).resolves.toEqual({
      domain: 'peer.example',
      status: 'reset_in_progress',
      affectedThreadCount: 2,
    });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('requires the typed confirmation domain to match', async () => {
    const { service, transaction } = makeStartService([]);

    await expect(
      service.start('peer.example', 'different.example'),
    ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a second domain while another reset is active', async () => {
    const { service } = makeStartService([
      { rows: [] },
      {
        rows: [
          {
            domain: 'peer.example',
            trustLevel: 'halted',
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            resetInProgress: false,
          },
          {
            domain: 'other.example',
            trustLevel: 'halted',
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            resetInProgress: true,
          },
        ],
      },
    ]);

    await expect(
      service.start('peer.example', 'peer.example'),
    ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
  });

  it('is idempotent when the same domain reset is already active', async () => {
    const { service, execute } = makeStartService([
      { rows: [] },
      {
        rows: [
          {
            domain: 'peer.example',
            trustLevel: 'halted',
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            resetInProgress: true,
          },
        ],
      },
      { rows: [{ count: 3 }] },
    ]);

    await expect(
      service.start('peer.example', 'peer.example'),
    ).resolves.toEqual({
      domain: 'peer.example',
      status: 'reset_in_progress',
      affectedThreadCount: 3,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('truncates one thread idempotently and flips its version marker last', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ userId: 4, revision: 9 }] })
      .mockResolvedValue({ rows: [] });
    const finalExecute = vi.fn().mockResolvedValue({ rows: [] });
    const database = {
      db: {
        execute,
        transaction: vi.fn(
          async (fn: (tx: { execute: typeof finalExecute }) => unknown) =>
            fn({ execute: finalExecute }),
        ),
      },
    };
    const service = new FederationResetService(
      database as never,
    ) as unknown as {
      truncateThread: (threadId: number) => Promise<void>;
    };

    await service.truncateThread(12);

    expect(database.db.transaction).toHaveBeenCalledOnce();
    expect(finalExecute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(10);
  });

  it('finalizes the domain only after no related thread remains pending', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            trustLevel: 'halted',
            resetInProgress: true,
            resetGeneration: 2,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValue({ rows: [] });
    const database = {
      db: {
        execute: vi.fn(),
        transaction: vi.fn(
          async (fn: (tx: { execute: typeof execute }) => unknown) =>
            fn({ execute }),
        ),
      },
    };
    const service = new FederationResetService(
      database as never,
      {} as never,
    ) as unknown as {
      finalizeDomainReset: (domain: string) => Promise<void>;
    };

    await service.finalizeDomainReset('peer.example');

    expect(database.db.transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(18);
  });

  it('resumes from the first non-truncated thread after a service restart', async () => {
    type ResetInternals = {
      cleanupPendingThreads: () => Promise<void>;
      cleanupWorker: Promise<void> | null;
      findNextPendingThread: (domain: string) => Promise<number | null>;
      truncateThread: (threadId: number) => Promise<void>;
      finalizeDomainReset: (domain: string) => Promise<void>;
    };
    const pendingThreadIds = [11, 12];
    const truncated = new Set<number>();
    const makeDatabase = () => ({
      db: {
        execute: vi
          .fn()
          .mockResolvedValue({ rows: [{ domain: 'peer.example' }] }),
      },
    });
    const findNext = vi.fn(async () => {
      return pendingThreadIds.find((id) => !truncated.has(id)) ?? null;
    });

    const firstProcess = new FederationResetService(
      makeDatabase() as never,
      {} as never,
    ) as unknown as ResetInternals;
    firstProcess.findNextPendingThread = findNext;
    firstProcess.truncateThread = vi.fn(async (threadId: number) => {
      if (threadId === 12) throw new Error('simulated process interruption');
      truncated.add(threadId);
    });
    firstProcess.finalizeDomainReset = vi.fn();

    await expect(firstProcess.cleanupPendingThreads()).rejects.toThrow(
      'simulated process interruption',
    );
    expect(truncated).toEqual(new Set([11]));
    expect(firstProcess.finalizeDomainReset).not.toHaveBeenCalled();

    const restartedProcess = new FederationResetService(
      makeDatabase() as never,
      {} as never,
    ) as unknown as FederationResetService & ResetInternals;
    restartedProcess.findNextPendingThread = findNext;
    restartedProcess.truncateThread = vi.fn(async (threadId: number) => {
      truncated.add(threadId);
    });
    restartedProcess.finalizeDomainReset = vi.fn();

    restartedProcess.onModuleInit();
    await restartedProcess.cleanupWorker;

    expect(restartedProcess.truncateThread).toHaveBeenCalledOnce();
    expect(restartedProcess.truncateThread).toHaveBeenCalledWith(12);
    expect(truncated).toEqual(new Set([11, 12]));
    expect(restartedProcess.finalizeDomainReset).toHaveBeenCalledOnce();
    expect(restartedProcess.finalizeDomainReset).toHaveBeenCalledWith(
      'peer.example',
    );
  });
});
