import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { FederationInboundFileSync } from './federation-inbound-file-sync.js';
import { FileSizeLimitError } from '../upload/file-size-limit.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { eq } from 'drizzle-orm';
import * as tables from '../database/schema.js';

function setup(failure?: Error) {
  const row = {
    id: 1n,
    digest: 'a'.repeat(64),
    batchId: 'batch',
    messageId: 23n,
    bytesTotal: 4n,
    bytesReceived: 0n,
    publisherNamespaceId: 7,
    originDomain: 'peer.test',
    status: 'PENDING',
    errorKind: null as string | null,
  };
  const database = {
    db: {
      query: {
        fileSyncProgress: {
          findMany: vi.fn().mockResolvedValue([row]),
          findFirst: vi.fn(async () => row),
        },
        pendingMedia: { findFirst: vi.fn().mockResolvedValue(undefined) },
        message: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      select: vi.fn(() => ({
        from: () => ({
          where: async () => [
            {
              totalFiles: 1,
              completedFiles: row.status === 'COMPLETED' ? 1 : 0,
            },
          ],
        }),
      })),
      update: vi.fn(() => ({
        set: (values: object) => ({
          where: () => {
            Object.assign(row, values);
            return Object.assign(Promise.resolve(), {
              returning: async () => [{ id: row.id }],
            });
          },
        }),
      })),
    },
  };
  const physicalController = new AbortController();
  const receive = vi.fn(async (input) => {
    if (failure) throw failure;
    for await (const _piece of input.chunks(0, physicalController.signal)) {
      /* Exercise resource generation checks. */
    }
  });
  const waitForStoppedDigest = vi.fn().mockResolvedValue(undefined);
  const cleanupCompletedDownload = vi.fn().mockResolvedValue(undefined);
  const sse = {
    hasMediaFileProgressSubscriber: vi.fn().mockReturnValue(true),
    hasMediaMessageProgressSubscriber: vi.fn().mockReturnValue(true),
    onMediaFileDownloadProgress: vi.fn(),
    onMediaMessageDownloadProgress: vi.fn(),
    completeMediaFileDownloadProgress: vi.fn(),
  };
  const quota = { isExhausted: vi.fn().mockResolvedValue(false) };
  const sync = new FederationInboundFileSync(
    database as never,
    quota as never,
    { receive, waitForStoppedDigest, cleanupCompletedDownload } as never,
    sse as never,
  );
  const fetch = vi.fn(() =>
    (async function* () {
      yield Buffer.from('data');
    })(),
  );
  const promote = vi.fn();
  const fail = vi.fn();
  return {
    row,
    database,
    quota,
    sse,
    sync,
    physicalController,
    waitForStoppedDigest,
    cleanupCompletedDownload,
    receive,
    fetch,
    promote,
    fail,
    run: () => sync.runBatch('batch', fetch, promote, fail),
  };
}

describe('inbound attachment jobs', () => {
  it('flushes a short failed download prefix before recording failure', async () => {
    const s = setup();
    s.receive.mockImplementationOnce(async (input) => {
      input.onProgress(2);
      throw new Error('disconnected');
    });
    await expect(s.run()).rejects.toThrow('disconnected');
    expect(s.row).toMatchObject({ status: 'FAILED', bytesReceived: 2n });
  });

  it('records integrity and cleanup failures without encoding filesystem state', async () => {
    const s = setup(new Error('CAS digest mismatch'));
    s.row.bytesReceived = 4n;
    await expect(s.run()).rejects.toThrow('CAS digest mismatch');
    expect(s.row).toMatchObject({
      status: 'FAILED',
      bytesReceived: 4n,
      errorKind: 'CAS digest mismatch',
    });
    const failedCleanup = setup(
      new AggregateError(
        [new Error('unlink denied')],
        'invalid artifact cleanup failed',
      ),
    );
    failedCleanup.row.bytesReceived = 4n;
    await expect(failedCleanup.run()).rejects.toThrow(
      'invalid artifact cleanup failed',
    );
    expect(failedCleanup.row).toMatchObject({
      status: 'FAILED',
      bytesReceived: 4n,
    });
  });

  it('cleans only after durable completion and preserves promotion on cleanup failure', async () => {
    const s = setup();
    const failure = new Error('temporary unlink failed');
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    s.cleanupCompletedDownload.mockImplementationOnce(async () => {
      expect(s.row).toMatchObject({ status: 'COMPLETED', errorKind: null });
      throw failure;
    });
    try {
      await s.run();
      expect(s.cleanupCompletedDownload).toHaveBeenCalledWith(s.row.digest);
      expect(s.promote).toHaveBeenCalledWith('batch');
      expect(s.fail).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('temporary cleanup failed'),
        failure,
      );
      expect(s.row.status).toBe('COMPLETED');
    } finally {
      logged.mockRestore();
    }
  });

  it('publishes progress and completion using task ownership without a staging row', async () => {
    const s = setup();
    s.database.db.query.message.findFirst.mockResolvedValue({
      threadId: 8,
      seq: 13,
      content: JSON.stringify({
        url: `/uploads/msg-assets/aa/aa/${s.row.digest}`,
        name: 'file.bin',
        size: 4,
      }),
    });
    await s.run();
    expect(s.database.db.query.pendingMedia.findFirst).not.toHaveBeenCalled();
    expect(s.database.db.query.message.findFirst).toHaveBeenCalledWith({
      where: eq(tables.message.id, s.row.messageId),
      columns: { threadId: true, seq: true, content: true },
    });
    expect(s.sse.onMediaFileDownloadProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 8, seq: 13, status: 'downloading' }),
    );
    expect(s.sse.completeMediaFileDownloadProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 8,
        seq: 13,
        status: 'ready',
        loaded: 4,
        total: 4,
      }),
    );
  });

  it('aborts active execution and drains physical IO on shutdown without changing task outcomes', async () => {
    const s = setup();
    let signal!: AbortSignal;
    let release!: () => void;
    s.receive.mockImplementationOnce((input) => {
      signal = input.signal;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const running = expect(s.run()).rejects.toThrow(
      'inbound file sync shutting down',
    );
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    s.database.db.update.mockClear();
    let closed = false;
    const closing = s.sync.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    try {
      expect(signal.aborted).toBe(true);
      await expect(s.run()).rejects.toThrow('inbound file sync shutting down');
      await expect(s.sync.stopBatch('batch')).rejects.toThrow(
        'inbound file sync shutting down',
      );
      expect(closed).toBe(false);
    } finally {
      release();
      await running;
      await closing;
    }
    expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest);
    expect(s.database.db.update).not.toHaveBeenCalled();
    expect(s.row.status).toBe('PENDING');
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('keeps infrastructure open through execution and physical-writer draining in Nest shutdown', async () => {
    const s = setup();
    let signal!: AbortSignal;
    let releaseExecution!: () => void;
    let releaseWriter!: () => void;
    const writer = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    s.receive.mockImplementationOnce((input) => {
      signal = input.signal;
      return new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
    });
    s.waitForStoppedDigest.mockReturnValueOnce(writer);
    const closeDatabase = vi.fn();
    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: 'database',
          useValue: { onApplicationShutdown: closeDatabase },
        },
        { provide: FederationInboundFileSync, useValue: s.sync },
      ],
    }).compile();
    const running = expect(s.run()).rejects.toThrow(
      'inbound file sync shutting down',
    );
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    s.database.db.update.mockClear();
    const closing = mod.close();
    try {
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(closeDatabase).not.toHaveBeenCalled();
      await expect(s.run()).rejects.toThrow('inbound file sync shutting down');
      releaseExecution();
      await running;
      await vi.waitFor(() =>
        expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest),
      );
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(s.row.status).toBe('PENDING');
      expect(s.database.db.update).not.toHaveBeenCalled();
      expect(s.promote).not.toHaveBeenCalled();
    } finally {
      releaseExecution();
      releaseWriter();
      await running;
      await closing;
    }
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('waits for an existing stop command and propagates its drain failure on shutdown', async () => {
    const s = setup();
    let rejectDrain!: (error: Error) => void;
    s.waitForStoppedDigest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDrain = reject;
        }),
    );
    const stop = expect(s.sync.stopBatch('batch')).rejects.toThrow(
      'download writer drain failed',
    );
    await vi.waitFor(() =>
      expect(s.waitForStoppedDigest).toHaveBeenCalledOnce(),
    );
    let settled = false;
    const closing = s.sync.beforeApplicationShutdown().finally(() => {
      settled = true;
    });
    const rejected = expect(closing).rejects.toThrow(
      'inbound file sync shutdown failed',
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectDrain(new Error('physical writer failed'));
    await stop;
    await rejected;
    expect(s.waitForStoppedDigest).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'shutdown'] as const)(
    'preserves a late transfer cleanup failure during %s',
    async (command) => {
      const s = setup();
      const failure = new AggregateError(
        [new Error('response cleanup failed')],
        'transfer cleanup failed',
      );
      let rejectTransfer!: (error: unknown) => void;
      s.receive.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectTransfer = reject;
          }),
      );
      const running = expect(s.run()).rejects.toBe(failure);
      await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
      s.database.db.update.mockClear();
      const stopping =
        command === 'stop'
          ? expect(s.sync.stopBatch('batch')).rejects.toBe(failure)
          : expect(s.sync.beforeApplicationShutdown()).rejects.toMatchObject({
              message: 'inbound file sync shutdown failed',
              errors: [expect.objectContaining({ errors: [failure] })],
            });
      rejectTransfer(failure);
      await running;
      await stopping;
      expect(s.database.db.update).not.toHaveBeenCalled();
      expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest);
      expect(s.promote).not.toHaveBeenCalled();
      expect(s.fail).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'retains transfer and progress persistence errors together (stopped: %s)',
    async (stopped) => {
      const s = setup();
      const transferError = new Error('transfer cleanup failed');
      const progressError = new Error('progress persistence failed');
      const subject = s.sync as unknown as {
        writeProgress: (
          id: bigint,
          received: number,
          signal: AbortSignal,
        ) => Promise<void>;
      };
      const write = vi
        .spyOn(subject, 'writeProgress')
        .mockRejectedValueOnce(progressError);
      let rejectTransfer!: (error: Error) => void;
      s.receive.mockImplementationOnce((input) => {
        input.onProgress(256 * 1024);
        return new Promise((_resolve, reject) => {
          rejectTransfer = reject;
        });
      });
      const expected = {
        message: 'could not persist inbound download progress',
        errors: [transferError, progressError],
      };
      const running = expect(s.run()).rejects.toMatchObject(expected);
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const stopping = stopped
        ? expect(s.sync.stopBatch('batch')).rejects.toMatchObject(expected)
        : undefined;
      rejectTransfer(transferError);
      await running;
      await stopping;
      expect(s.promote).not.toHaveBeenCalled();
      expect(s.fail).not.toHaveBeenCalled();
      expect(s.row.status).toBe('PENDING');
    },
  );

  it('drains progress after a synchronous transfer throw without losing either error', async () => {
    const s = setup();
    const transferError = new Error('adapter threw synchronously');
    const progressError = new Error('pending progress write failed');
    let rejectProgress!: (error: Error) => void;
    const subject = s.sync as unknown as {
      writeProgress: (
        id: bigint,
        received: number,
        signal: AbortSignal,
      ) => Promise<void>;
    };
    const write = vi.spyOn(subject, 'writeProgress').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProgress = reject;
        }),
    );
    let lateProgress!: (received: number) => void;
    s.receive.mockImplementationOnce((input) => {
      lateProgress = input.onProgress;
      input.onProgress(256 * 1024);
      throw transferError;
    });
    let settled = false;
    const execution = s.run().finally(() => {
      settled = true;
    });
    const rejected = expect(execution).rejects.toMatchObject({
      message: 'could not persist inbound download progress',
      errors: [transferError, progressError],
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    try {
      expect(settled).toBe(false);
      await expect(s.run()).rejects.toThrow('download execution is busy');
    } finally {
      rejectProgress(progressError);
      await rejected;
    }
    lateProgress(512 * 1024);
    expect(write).toHaveBeenCalledOnce();
    expect(s.promote).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
    expect(s.row.status).toBe('PENDING');
  });

  it('keeps the durable outcome pending throughout active transfer', async () => {
    const s = setup();
    let release!: () => void;
    s.receive.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const execution = s.run();
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    expect(s.row.status).toBe('PENDING');
    expect(s.promote).not.toHaveBeenCalled();
    release();
    await execution;
    expect(s.row.status).toBe('COMPLETED');
  });

  it('does not receive bytes when a stopped task rejects execution admission', async () => {
    const s = setup();
    s.database.db.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as never);
    await expect(s.run()).rejects.toThrow('task was terminated');
    expect(s.receive).not.toHaveBeenCalled();
    expect(s.promote).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it.each([undefined, new Error('late transport failure')])(
    'does not overwrite a stop committed before transfer settlement (%s)',
    async (failure) => {
      const s = setup();
      s.receive.mockImplementationOnce(async () => {
        s.row.status = 'FAILED';
        s.row.errorKind = 'USER_STOPPED';
        // Simulate the conditional update rejecting a concurrently stopped durable row.
        s.database.db.update.mockReturnValue({
          set: () => ({ where: () => ({ returning: async () => [] }) }),
        } as never);
        if (failure) throw failure;
      });
      await expect(s.run()).rejects.toThrow(
        failure?.message ?? 'task was terminated',
      );
      expect(s.row).toMatchObject({
        status: 'FAILED',
        errorKind: 'USER_STOPPED',
      });
      expect(s.promote).not.toHaveBeenCalled();
      expect(s.fail).not.toHaveBeenCalled();
    },
  );

  it.each([new FileSizeLimitError(3, 4), new Error('shared transfer failed')])(
    'terminates each message job on a transfer/admission failure',
    async (error) => {
      const s = setup(error);
      await expect(s.run()).rejects.toBe(error);
      expect(s.fetch).not.toHaveBeenCalled();
      expect(s.row.status).toBe('FAILED');
      expect(s.fail).toHaveBeenCalledWith('batch');
      expect(s.promote).not.toHaveBeenCalled();
    },
  );
  it('settles quota pause without failing or promoting the batch', async () => {
    const error = new BusinessException(
      BusinessCode.FEDERATION_QUOTA_EXCEEDED,
      'quota',
    );
    const s = setup(error);
    await expect(s.run()).rejects.toBe(error);
    expect(s.row.status).toBe('PENDING');
    expect(s.fail).not.toHaveBeenCalled();
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('drains domain failure settlement before stop permits a retry', async () => {
    const error = new Error('transport failed');
    const s = setup(error);
    let release!: () => void;
    s.fail.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const execution = s.run();
    const rejected = expect(execution).rejects.toBe(error);
    await vi.waitFor(() => expect(s.fail).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = s.sync.stopBatch('batch').finally(() => {
      stopped = true;
    });
    const stopRejected = expect(stop).rejects.toBe(error);
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopRejected;
    await rejected;
    s.row.status = 'PENDING';
    s.receive.mockResolvedValue(undefined);
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
    expect(s.fail).toHaveBeenCalledOnce();
  });

  it('rejects duplicate executions and retains admission while stop drains settlement', async () => {
    const s = setup();
    let release!: () => void;
    s.promote.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = s.run();
    await vi.waitFor(() => expect(s.promote).toHaveBeenCalledOnce());
    await expect(s.run()).rejects.toThrow('download execution is busy');
    const stopping = s.sync.stopBatch('batch');
    try {
      await expect(s.run()).rejects.toThrow('download execution is busy');
      await expect(s.sync.stopBatch('batch')).rejects.toThrow(
        'download execution is busy',
      );
    } finally {
      release();
      await first;
      await stopping;
    }
    expect(s.receive).toHaveBeenCalledOnce();
    expect(s.promote).toHaveBeenCalledOnce();
  });

  it('aborts before stop persistence and drains resources even when persistence fails', async () => {
    const s = setup();
    let signal!: AbortSignal;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.receive.mockImplementationOnce(async (input) => {
      signal = input.signal;
      await gate;
    });
    const running = expect(s.run()).rejects.toThrow('stopped by administrator');
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    const failure = new Error('stop persistence failed');
    const persist = vi.fn(async () => {
      expect(signal.aborted).toBe(true);
      throw failure;
    });
    let settled = false;
    const stopping = s.sync.stopBatch('batch', persist).finally(() => {
      settled = true;
    });
    const rejected = expect(stopping).rejects.toBe(failure);
    try {
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      await expect(s.run()).rejects.toThrow('download execution is busy');
    } finally {
      release();
      await running;
      await rejected;
    }
    expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest);
    expect(s.row.status).toBe('PENDING');
    expect(s.promote).not.toHaveBeenCalled();
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
  });

  it('reports settlement failure to stop and retains admission through physical drain', async () => {
    const s = setup();
    const failure = new Error('message settlement failed');
    let rejectSettlement!: (error: Error) => void;
    s.promote.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSettlement = reject;
        }),
    );
    let releaseDrain!: () => void;
    s.waitForStoppedDigest.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    const running = expect(s.run()).rejects.toBe(failure);
    await vi.waitFor(() => expect(s.promote).toHaveBeenCalledOnce());
    const stop = expect(s.sync.stopBatch('batch')).rejects.toBe(failure);
    rejectSettlement(failure);
    await running;
    await vi.waitFor(() =>
      expect(s.waitForStoppedDigest).toHaveBeenCalledOnce(),
    );
    try {
      await expect(s.run()).rejects.toThrow('download execution is busy');
    } finally {
      releaseDrain();
      await stop;
    }
    expect(s.row.status).toBe('COMPLETED');
  });

  it('preserves execution errors alongside stop persistence and drain errors', async () => {
    const s = setup();
    const executionError = new Error('row lookup failed');
    const persistence = new Error('stop persistence failed');
    const drain = new Error('writer drain failed');
    let rejectLookup!: (error: Error) => void;
    s.database.db.query.fileSyncProgress.findMany.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    s.waitForStoppedDigest.mockRejectedValueOnce(drain);
    const running = expect(s.run()).rejects.toBe(executionError);
    const stop = expect(
      s.sync.stopBatch('batch', async () => {
        throw persistence;
      }),
    ).rejects.toMatchObject({
      message: 'download stop failed',
      errors: [
        persistence,
        executionError,
        expect.objectContaining({ errors: [drain] }),
      ],
    });
    rejectLookup(executionError);
    await running;
    await stop;
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
  });

  it('preserves both stop persistence and writer drain errors', async () => {
    const s = setup();
    const persistence = new Error('stop persistence failed');
    const drain = new Error('writer drain failed');
    s.waitForStoppedDigest.mockRejectedValueOnce(drain);
    await expect(
      s.sync.stopBatch('batch', async () => {
        throw persistence;
      }),
    ).rejects.toMatchObject({
      message: 'download stop failed',
      errors: [persistence, expect.objectContaining({ errors: [drain] })],
    });
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
  });

  it('retains the stopping slot until every physical drain settles even when one fails', async () => {
    const s = setup();
    s.database.db.query.fileSyncProgress.findMany.mockResolvedValueOnce([
      s.row,
      { ...s.row, id: 2n, digest: 'b'.repeat(64) },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.waitForStoppedDigest
      .mockRejectedValueOnce(new Error('first drain failed'))
      .mockImplementationOnce(() => gate);
    const stopping = s.sync.stopBatch('batch');
    const rejected = expect(stopping).rejects.toThrow(
      'download writer drain failed',
    );
    await vi.waitFor(() =>
      expect(s.waitForStoppedDigest).toHaveBeenCalledTimes(2),
    );
    try {
      await expect(s.run()).rejects.toThrow('download execution is busy');
    } finally {
      release();
      await rejected;
    }
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
  });

  it('waits for every file and preserves multiple execution errors on run and stop', async () => {
    const s = setup();
    s.database.db.query.fileSyncProgress.findMany.mockResolvedValue([
      s.row,
      { ...s.row, id: 2n, digest: 'b'.repeat(64) },
    ]);
    const first = new Error('first task lookup failed');
    const second = new Error('second task lookup failed');
    let rejectSecond!: (error: Error) => void;
    s.database.db.query.fileSyncProgress.findFirst
      .mockRejectedValueOnce(first)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const expected = {
      message: 'inbound file execution failed',
      errors: [first, second],
    };
    let settled = false;
    const execution = s.run().finally(() => {
      settled = true;
    });
    const rejected = expect(execution).rejects.toMatchObject(expected);
    await vi.waitFor(() =>
      expect(
        s.database.db.query.fileSyncProgress.findFirst,
      ).toHaveBeenCalledTimes(2),
    );
    expect(settled).toBe(false);
    const stopped = expect(s.sync.stopBatch('batch')).rejects.toMatchObject(
      expected,
    );
    rejectSecond(second);
    await rejected;
    await stopped;
    expect(s.waitForStoppedDigest).toHaveBeenCalledTimes(2);
    expect(s.promote).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it('does not let an expected abort hide another file execution error', async () => {
    const s = setup();
    s.database.db.query.fileSyncProgress.findMany.mockResolvedValue([
      s.row,
      { ...s.row, id: 2n, digest: 'b'.repeat(64) },
    ]);
    let rejectFirst!: (error: unknown) => void;
    let rejectSecond!: (error: unknown) => void;
    s.database.db.query.fileSyncProgress.findFirst
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const failure = new Error('second task persistence failed');
    const subject = s.sync as unknown as {
      driveFile: (...args: unknown[]) => Promise<unknown>;
    };
    const drive = vi.spyOn(subject, 'driveFile');
    const rejected = expect(s.run()).rejects.toBe(failure);
    await vi.waitFor(() => expect(drive).toHaveBeenCalledTimes(2));
    const signal = drive.mock.calls[0][3] as AbortSignal;
    const stopped = expect(s.sync.stopBatch('batch')).rejects.toBe(failure);
    rejectFirst(signal.reason);
    rejectSecond(failure);
    await rejected;
    await stopped;
    expect(s.promote).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it('drains every stop notification and clears cached targets even when notifications fail', async () => {
    const s = setup();
    const stoppedRow = {
      ...s.row,
      status: 'FAILED',
      errorKind: 'USER_STOPPED',
    };
    s.database.db.query.fileSyncProgress.findMany.mockResolvedValueOnce([
      stoppedRow,
      { ...stoppedRow, id: 2n, digest: 'b'.repeat(64) },
      { ...stoppedRow, id: 3n, status: 'COMPLETED', errorKind: null },
    ]);
    const subject = s.sync as unknown as {
      publishFileTerminal: (
        id: bigint,
        status: 'ready' | 'failed',
      ) => Promise<void>;
      progressTargets: Map<string, unknown>;
    };
    subject.progressTargets.set('1', {});
    subject.progressTargets.set('2', {});
    const first = new Error('first notification failed');
    const second = new Error('second notification failed');
    let rejectSecond!: (error: Error) => void;
    const notify = vi
      .spyOn(subject, 'publishFileTerminal')
      .mockRejectedValueOnce(first)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    let settled = false;
    const stopping = s.sync.stopBatch('batch').finally(() => {
      settled = true;
    });
    const rejected = expect(stopping).rejects.toMatchObject({
      message: 'download stop notification failed',
      errors: [first, second],
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    try {
      expect(settled).toBe(false);
      expect(subject.progressTargets.has('1')).toBe(false);
      await expect(s.run()).rejects.toThrow('download execution is busy');
    } finally {
      rejectSecond(second);
      await rejected;
    }
    expect(subject.progressTargets.size).toBe(0);
    expect(notify).toHaveBeenNthCalledWith(1, 1n, 'failed');
    expect(notify).toHaveBeenNthCalledWith(2, 2n, 'failed');
    notify.mockRestore();
    await s.run();
    expect(s.row.status).toBe('COMPLETED');
  });

  it('propagates failure-state persistence errors instead of treating them as cancellation', async () => {
    const s = setup(new Error('transport failed'));
    const persistence = new Error('database unavailable');
    s.database.db.update
      .mockImplementationOnce(
        () =>
          ({
            set: (values: object) => ({
              where: () => {
                Object.assign(s.row, values);
                return { returning: async () => [{ id: s.row.id }] };
              },
            }),
          }) as never,
      )
      .mockImplementationOnce(() => {
        throw persistence;
      });
    await expect(s.run()).rejects.toBe(persistence);
    expect(s.fail).not.toHaveBeenCalled();
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('promotes only after shared IO succeeds and forwards its descriptor', async () => {
    const s = setup();
    await s.run();
    expect(s.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        namespaceId: 7,
        peerDomain: 'peer.test',
        digest: s.row.digest,
        declaredBytes: 4,
      }),
    );
    expect(s.fetch).toHaveBeenCalledWith(
      s.row.digest,
      0,
      4,
      s.physicalController.signal,
    );
    expect(s.row).toMatchObject({ status: 'COMPLETED', bytesReceived: 4n });
    expect(s.promote).toHaveBeenCalledWith('batch');
  });

  it('does not emit late downloading progress after a stopped row rejects the write', async () => {
    const s = setup();
    s.database.db.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as never);
    const subject = s.sync as unknown as {
      writeProgress: (
        id: bigint,
        received: number,
        signal: AbortSignal,
      ) => Promise<void>;
      publishProgress: (id: bigint, received: number) => Promise<void>;
    };
    const publish = vi
      .spyOn(subject, 'publishProgress')
      .mockResolvedValue(undefined);
    await subject.writeProgress(1n, 100, new AbortController().signal);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['file', 'message'] as const)(
    'suppresses late %s progress after cancellation during target lookup',
    async (kind) => {
      const s = setup();
      const controller = new AbortController();
      const subject = s.sync as unknown as {
        progressTarget: (id: bigint) => Promise<unknown>;
        publishProgress: (
          id: bigint,
          received: number,
          signal: AbortSignal,
        ) => Promise<void>;
        publishMessageProgress: (
          id: bigint,
          active: boolean,
          signal: AbortSignal,
        ) => Promise<void>;
      };
      vi.spyOn(subject, 'progressTarget').mockImplementationOnce(async () => {
        controller.abort();
        return {
          threadId: 8,
          seq: 13,
          batchId: 'batch',
          file: { digest: s.row.digest },
          total: 4,
        };
      });
      if (kind === 'file')
        await subject.publishProgress(1n, 2, controller.signal);
      else await subject.publishMessageProgress(1n, true, controller.signal);
      expect(s.sse.onMediaFileDownloadProgress).not.toHaveBeenCalled();
      expect(s.sse.onMediaMessageDownloadProgress).not.toHaveBeenCalled();
      expect(s.database.db.select).not.toHaveBeenCalled();
    },
  );

  it('suppresses message progress after cancellation during counts lookup', async () => {
    const s = setup();
    const controller = new AbortController();
    const subject = s.sync as unknown as {
      progressTarget: (id: bigint) => Promise<unknown>;
      publishMessageProgress: (
        id: bigint,
        active: boolean,
        signal: AbortSignal,
      ) => Promise<void>;
    };
    vi.spyOn(subject, 'progressTarget').mockResolvedValue({
      threadId: 8,
      seq: 13,
      batchId: 'batch',
      file: { digest: s.row.digest },
      total: 4,
    });
    s.database.db.select.mockImplementationOnce(() => ({
      from: () => ({
        where: async () => {
          controller.abort();
          return [{ totalFiles: 1, completedFiles: 0 }];
        },
      }),
    }));
    await subject.publishMessageProgress(1n, true, controller.signal);
    expect(s.sse.onMediaMessageDownloadProgress).not.toHaveBeenCalled();
  });

  it('ignores a shared physical writer callback after its logical consumer is stopped and retried', async () => {
    const s = setup();
    let lateProgress!: (received: number) => void;
    s.receive.mockImplementation(async (input) => {
      lateProgress = input.onProgress;
      await new Promise((_resolve, reject) =>
        input.signal.addEventListener(
          'abort',
          () => reject(input.signal.reason),
          { once: true },
        ),
      );
    });
    const run = s.run();
    const rejected = expect(run).rejects.toThrow('stopped by administrator');
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    s.row.status = 'FAILED';
    s.row.errorKind = 'USER_STOPPED';
    await s.sync.stopBatch('batch');
    await rejected;
    s.row.status = 'PENDING';
    s.row.errorKind = null;
    s.database.db.update.mockClear();
    lateProgress(512 * 1024);
    await Promise.resolve();
    expect(s.database.db.update).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it('cancels even while the initial durable-row lookup is pending', async () => {
    const s = setup();
    let release!: () => void;
    s.database.db.query.fileSyncProgress.findMany.mockImplementationOnce(
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [s.row];
      },
    );
    const run = s.run();
    const rejected = expect(run).rejects.toThrow('stopped by administrator');
    const stopping = s.sync.stopBatch('batch');
    release();
    await stopping;
    await rejected;
    expect(s.quota.isExhausted).not.toHaveBeenCalled();
    expect(s.receive).not.toHaveBeenCalled();
    expect(s.promote).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'ignores a late quota result after stop (%s)',
    async (exhausted) => {
      const s = setup();
      let release!: (value: boolean) => void;
      s.quota.isExhausted.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      const rejected = expect(s.run()).rejects.toThrow(
        'stopped by administrator',
      );
      await vi.waitFor(() =>
        expect(s.quota.isExhausted).toHaveBeenCalledOnce(),
      );
      const stopping = s.sync.stopBatch('batch');
      release(exhausted);
      await rejected;
      await stopping;
      expect(s.database.db.update).not.toHaveBeenCalled();
      expect(s.receive).not.toHaveBeenCalled();
      expect(s.promote).not.toHaveBeenCalled();
      expect(s.row).toMatchObject({ status: 'PENDING', errorKind: null });
    },
  );

  it('reports a quota lookup failure to stop instead of hiding it as cancellation', async () => {
    const s = setup();
    const failure = new Error('quota lookup failed');
    let reject!: (error: Error) => void;
    s.quota.isExhausted.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const rejected = expect(s.run()).rejects.toBe(failure);
    await vi.waitFor(() => expect(s.quota.isExhausted).toHaveBeenCalledOnce());
    const stopping = expect(s.sync.stopBatch('batch')).rejects.toBe(failure);
    reject(failure);
    await rejected;
    await stopping;
    expect(s.database.db.update).not.toHaveBeenCalled();
    expect(s.receive).not.toHaveBeenCalled();
  });

  it('preserves the durable stop reason and waits only for cancelled physical writers', async () => {
    const s = setup();
    s.receive.mockImplementation(
      async (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
    );
    const run = s.run();
    const rejected = expect(run).rejects.toThrow('stopped by administrator');
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    // The lifecycle owner commits FAILED with a stop reason before detaching this consumer.
    s.row.status = 'FAILED';
    s.row.errorKind = 'USER_STOPPED';
    await s.sync.stopBatch('batch');
    await rejected;
    expect(s.row).toMatchObject({
      status: 'FAILED',
      errorKind: 'USER_STOPPED',
    });
    expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest);
    expect(s.promote).not.toHaveBeenCalled();
  });
});
