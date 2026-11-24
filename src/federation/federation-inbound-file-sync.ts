import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { QuotaService } from '../quota/quota.service.js';
import { FederationMediaTransferService } from './federation-media-transfer.service.js';
import {
  SseService,
  type MediaProgressFileRef,
} from '../gateway/sse.service.js';
import { extractDigestFileRefs } from '../upload/file-content.js';

type FileSyncKind =
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'LINK_CARD'
  | 'BUNDLE';

type FileDownloadOutcome =
  | { kind: 'completed' }
  | { kind: 'cancelled'; error: unknown }
  | { kind: 'quota-paused'; error: unknown }
  | { kind: 'failed'; error: unknown };

class FederationDownloadTerminatedError extends Error {
  constructor() {
    super('federation download task was terminated');
  }
}

export function isFederatedMediaContentType(type: ContentType): boolean {
  switch (type) {
    case ContentType.IMAGE:
    case ContentType.FILE:
    case ContentType.VIDEO:
    case ContentType.AUDIO:
    case ContentType.GALLERY:
    case ContentType.LINK:
      return true;
    default:
      return false;
  }
}

export function federationFileSyncKind(type: ContentType): FileSyncKind {
  switch (type) {
    case ContentType.IMAGE:
      return 'IMAGE';
    case ContentType.LINK:
      return 'LINK_CARD';
    case ContentType.VIDEO:
      return 'VIDEO';
    case ContentType.AUDIO:
      return 'AUDIO';
    case ContentType.GALLERY:
      return 'BUNDLE';
    default:
      return 'FILE';
  }
}

/** Drives durable inbound file rows and serializes promotion attempts per batch. */
@Injectable()
export class FederationInboundFileSync implements BeforeApplicationShutdown {
  private readonly logger = new Logger(FederationInboundFileSync.name);
  private readonly shutdown = new AbortController();
  private readonly stops = new Set<Promise<unknown>>();

  // Settlement and physical-writer draining still use the database. Complete both
  // before infrastructure providers enter their application-shutdown hooks.
  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort(new Error('inbound file sync shutting down'));
    const executions = [...this.executions.entries()];
    for (const [, execution] of executions)
      execution.controller.abort(this.shutdown.signal.reason);
    // Abort all consumers before awaiting any one batch, including shared physical writers.
    const results = await Promise.allSettled([
      ...this.stops,
      ...executions
        .filter(([, execution]) => execution.phase === 'running')
        .map(async ([batchId, execution]) => {
          await execution.drained;
          const errors = [...execution.errors];
          try {
            await this.drainStoppedBatch(batchId);
          } catch (error) {
            errors.push(error);
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              `download batch ${batchId} shutdown failed`,
            );
        }),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'inbound file sync shutdown failed');
  }

  private readonly executions = new Map<
    string,
    {
      phase: 'running' | 'stopping';
      controller: AbortController;
      errors: unknown[];
      drained: Promise<void>;
      release: () => void;
    }
  >();

  private admit(batchId: string, phase: 'running' | 'stopping') {
    this.shutdown.signal.throwIfAborted();
    if (this.executions.has(batchId))
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'download execution is busy',
        409,
      );
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execution = {
      phase,
      controller: new AbortController(),
      errors: [] as unknown[],
      drained,
      release,
    };
    this.executions.set(batchId, execution);
    return execution;
  }

  async stopBatch(
    batchId: string,
    persistStop?: () => Promise<void>,
  ): Promise<void> {
    this.shutdown.signal.throwIfAborted();
    const work = this.stopBatchExecution(batchId, persistStop);
    this.stops.add(work);
    try {
      await work;
    } finally {
      this.stops.delete(work);
    }
  }

  private async stopBatchExecution(
    batchId: string,
    persistStop?: () => Promise<void>,
  ): Promise<void> {
    const current = this.executions.get(batchId);
    if (current?.phase === 'stopping')
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'download execution is busy',
        409,
      );
    const execution = current ?? this.admit(batchId, 'stopping');
    execution.phase = 'stopping';
    try {
      execution.controller.abort(new Error('stopped by administrator'));
      const errors: unknown[] = [];
      // Invalidate execution before any durable write can block. Persistence failure
      // must not release admission while the invalidated execution still owns resources.
      try {
        await persistStop?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (current) {
          await current.drained;
          errors.push(...current.errors);
        }
        await this.drainStoppedBatch(batchId);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, 'download stop failed');
    } finally {
      execution.release();
      if (this.executions.get(batchId) === execution)
        this.executions.delete(batchId);
    }
  }

  private async drainStoppedBatch(batchId: string): Promise<void> {
    const rows = await this.database.db.query.fileSyncProgress.findMany({
      where: eq(tables.fileSyncProgress.batchId, batchId),
      columns: { id: true, digest: true, status: true, errorKind: true },
    });
    const drains = await Promise.allSettled(
      rows.map((row) => this.transfers.waitForStoppedDigest(row.digest)),
    );
    const failures = drains.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'download writer drain failed',
      );
    const notifications = await Promise.allSettled(
      rows
        .filter(
          (row) => row.status === 'FAILED' && row.errorKind === 'USER_STOPPED',
        )
        .map(async (row) => {
          try {
            await this.publishFileTerminal(row.id, 'failed');
          } finally {
            this.progressTargets.delete(row.id.toString());
          }
        }),
    );
    const notificationErrors = notifications.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (notificationErrors.length)
      throw new AggregateError(
        notificationErrors,
        'download stop notification failed',
      );
  }
  private readonly progressTargets = new Map<
    string,
    {
      threadId: number;
      seq: number;
      file: MediaProgressFileRef;
      total: number | null;
    }
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly quota: QuotaService,
    private readonly transfers: FederationMediaTransferService,
    private readonly sse: SseService,
  ) {}

  async runBatch(
    batchId: string,
    fetchChunksFor: (
      digest: string,
      offset: number,
      declaredBytes: number,
      signal: AbortSignal,
    ) => AsyncIterable<Buffer>,
    promote: (batchId: string) => Promise<void>,
    fail: (batchId: string) => Promise<void>,
  ): Promise<void> {
    // Synchronous admission: duplicate executions reject instead of waiting for a turn.
    const execution = this.admit(batchId, 'running');
    const { controller } = execution;
    try {
      controller.signal.throwIfAborted();
      const rows = await this.database.db.query.fileSyncProgress.findMany({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      });
      controller.signal.throwIfAborted();
      const publisherNamespaceId = rows[0]?.publisherNamespaceId;
      const quotaExhausted =
        publisherNamespaceId &&
        (await this.quota.isExhausted(publisherNamespaceId, [
          'files',
          'fileBytes',
        ]));
      controller.signal.throwIfAborted();
      if (quotaExhausted) {
        await this.database.db
          .update(tables.fileSyncProgress)
          .set({ errorKind: 'QUOTA_PAUSED', updatedAt: new Date() })
          .where(
            and(
              eq(tables.fileSyncProgress.batchId, batchId),
              eq(tables.fileSyncProgress.status, 'PENDING'),
            ),
          );
        return;
      }
      controller.signal.throwIfAborted();
      const results = await Promise.allSettled(
        rows.map((row) =>
          this.driveFile(
            row.id,
            row.digest,
            (offset, signal) =>
              fetchChunksFor(
                row.digest,
                offset,
                Number(row.bytesTotal),
                signal,
              ),
            controller.signal,
          ),
        ),
      );
      await this.settleBatch(
        batchId,
        results,
        controller.signal,
        promote,
        fail,
      );
    } catch (error) {
      // The drain promise is a completion latch, not a rejected promise: capture errors
      // for a concurrent stop without creating an unobserved rejection during normal runs.
      if (!controller.signal.aborted || error !== controller.signal.reason)
        execution.errors.push(error);
      throw error;
    } finally {
      execution.release();
      // Stop retains the slot through physical-writer and terminal-notification draining.
      if (
        execution.phase === 'running' &&
        this.executions.get(batchId) === execution
      )
        this.executions.delete(batchId);
    }
  }

  /** Held under the execution lock through domain settlement; retry cannot reset rows until it drains. */
  private async settleBatch(
    batchId: string,
    results: PromiseSettledResult<FileDownloadOutcome>[],
    signal: AbortSignal,
    promote: (batchId: string) => Promise<void>,
    fail: (batchId: string) => Promise<void>,
  ): Promise<void> {
    // Rejections are persistence/programming errors, not transport outcomes. Never hide them on stop.
    const executionErrors = results.flatMap((result) =>
      result.status === 'rejected' &&
      !(signal.aborted && result.reason === signal.reason)
        ? [result.reason as unknown]
        : [],
    );
    if (executionErrors.length === 1) throw executionErrors[0];
    if (executionErrors.length > 1)
      throw new AggregateError(
        executionErrors,
        'inbound file execution failed',
      );
    const outcomes = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    signal.throwIfAborted();
    const cancelled = outcomes.find((outcome) => outcome.kind === 'cancelled');
    if (cancelled?.kind === 'cancelled') throw cancelled.error;
    const failure = outcomes.find((outcome) => outcome.kind === 'failed');
    if (failure?.kind === 'failed') {
      // The domain transaction independently authorizes this transition against active durable state.
      // Cancellation can arrive while it awaits a database lock; the signal is not a commit guard.
      await fail(batchId);
      throw failure.error;
    }
    const paused = outcomes.find((outcome) => outcome.kind === 'quota-paused');
    if (paused?.kind === 'quota-paused') throw paused.error;
    await promote(batchId);
  }

  private async driveFile(
    progressId: bigint,
    digest: string,
    fetchChunks: (offset: number, signal: AbortSignal) => AsyncIterable<Buffer>,
    signal: AbortSignal,
  ): Promise<FileDownloadOutcome> {
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: {
        bytesTotal: true,
        originDomain: true,
        publisherNamespaceId: true,
      },
    });
    const declaredBytes = row?.bytesTotal ?? 0n;
    let progressWrite = Promise.resolve();
    let writing = false;
    let acceptingProgress = true;
    const progressErrors: unknown[] = [];
    try {
      signal.throwIfAborted();
      if (!row?.publisherNamespaceId)
        throw new Error('missing media publisher namespace');
      if (!row.originDomain) throw new Error('missing media source peer');
      await this.claim(progressId, declaredBytes);
      signal.throwIfAborted();
      let lastWrite = 0;
      let latestReceived: number | undefined;
      const peerDomain = row.originDomain;
      // Normalize synchronous adapter throws and asynchronous transfer failures into
      // one result, so every admitted progress write reaches the same drain point.
      const transferResult = await Promise.resolve()
        .then(() =>
          this.transfers.receive({
            namespaceId: row.publisherNamespaceId,
            peerDomain,
            digest,
            declaredBytes: Number(declaredBytes),
            // The shared writer is owned by the scheduler's consumer signals, not
            // by this task's row or by the existence of another durable batch.
            chunks: (offset, physicalSignal) =>
              fetchChunks(offset, physicalSignal),
            signal,
            onProgress: (received) => {
              // The physical writer may outlive this consumer; never let its closure update a retry.
              if (!acceptingProgress || signal.aborted) return;
              latestReceived = received;
              if (received - lastWrite >= 256 * 1024 && !writing) {
                lastWrite = received;
                writing = true;
                progressWrite = this.writeProgress(progressId, received, signal)
                  .catch((error: unknown) => {
                    progressErrors.push(error);
                  })
                  .finally(() => {
                    writing = false;
                  });
              }
            },
          }),
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      acceptingProgress = false;
      await progressWrite;
      // Flush the final observed byte count even for short transfers. This is only
      // display progress; disk checkpoints alone determine subsequent resume offsets.
      if (
        !signal.aborted &&
        latestReceived !== undefined &&
        latestReceived !== lastWrite
      ) {
        try {
          await this.writeProgress(progressId, latestReceived, signal);
        } catch (error) {
          progressErrors.push(error);
        }
      }
      if (progressErrors.length > 0) {
        const errors = [...progressErrors];
        if (
          !transferResult.ok &&
          !(signal.aborted && transferResult.error === signal.reason)
        )
          errors.unshift(transferResult.error);
        throw new AggregateError(
          errors,
          'could not persist inbound download progress',
        );
      }
      if (signal.aborted) {
        if (!transferResult.ok && transferResult.error !== signal.reason)
          throw transferResult.error;
        return { kind: 'cancelled', error: signal.reason };
      }
      if (!transferResult.ok)
        return this.handleFailure(progressId, transferResult.error);
      const completed = await this.database.db
        .update(tables.fileSyncProgress)
        .set({
          status: 'COMPLETED',
          errorKind: null,
          bytesReceived: declaredBytes,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tables.fileSyncProgress.id, progressId),
            eq(tables.fileSyncProgress.status, 'PENDING'),
          ),
        )
        .returning({ id: tables.fileSyncProgress.id });
      if (completed.length === 0) throw new FederationDownloadTerminatedError();
      try {
        await this.transfers.cleanupCompletedDownload(digest);
      } catch (error) {
        // The task outcome is committed. Cleanup failure must not prevent message promotion.
        this.logger.error(
          `Completed download ${digest} temporary cleanup failed`,
          error,
        );
      }
      await this.publishFileTerminal(progressId, 'ready');
      return { kind: 'completed' };
    } catch (error) {
      if (error instanceof FederationDownloadTerminatedError)
        return { kind: 'cancelled', error };
      // This boundary only catches orchestration/persistence failures. Transport and admission
      // failures are classified above, so a concurrent stop cannot conceal a database error.
      throw error;
    } finally {
      this.progressTargets.delete(progressId.toString());
    }
  }

  private async claim(
    progressId: bigint,
    declaredBytes: bigint,
  ): Promise<void> {
    const claimed = await this.database.db
      .update(tables.fileSyncProgress)
      .set({
        // Execution ownership is the in-memory batch slot and controller, not another database state.
        bytesTotal: declaredBytes,
        errorKind: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });
    if (claimed.length === 0) throw new FederationDownloadTerminatedError();
  }

  private async writeProgress(
    progressId: bigint,
    received: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    await this.database.db
      .update(tables.fileSyncProgress)
      .set({ bytesReceived: BigInt(received), updatedAt: new Date() })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      );
  }

  private async publishFileTerminal(
    progressId: bigint,
    status: 'ready' | 'failed',
  ): Promise<void> {
    const target = await this.progressTarget(progressId);
    if (!target) return;
    if (
      !this.sse.hasMediaFileProgressSubscriber(
        target.threadId,
        target.seq,
        target.file.digest,
      )
    )
      return;
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: { bytesReceived: true, bytesTotal: true },
    });
    this.sse.completeMediaFileDownloadProgress({
      threadId: target.threadId,
      seq: target.seq,
      file: target.file,
      status,
      loaded: Number(
        row && status === 'ready' && row.bytesTotal > row.bytesReceived
          ? row.bytesTotal
          : (row?.bytesReceived ?? 0n),
      ),
      total: row && row.bytesTotal > 0n ? Number(row.bytesTotal) : target.total,
      bytesPerSecond: null,
    });
  }

  private async progressTarget(progressId: bigint): Promise<{
    threadId: number;
    seq: number;
    file: MediaProgressFileRef;
    total: number | null;
  } | null> {
    const key = progressId.toString();
    const cached = this.progressTargets.get(key);
    if (cached) return cached;
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: {
        messageId: true,
        digest: true,
        bytesTotal: true,
      },
    });
    if (!row) return null;
    // Task ownership survives removal of temporary inbound coordination. Never infer
    // an owner from another message using the same digest or from a staging row.
    const message = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, row.messageId),
      columns: { threadId: true, seq: true, content: true },
    });
    if (!message) return null;
    const file = extractDigestFileRefs(message.content).find(
      (item) => item.digest === row.digest,
    );
    if (!file) return null;
    const target = {
      threadId: message.threadId,
      seq: message.seq,
      file,
      total: row.bytesTotal > 0n ? Number(row.bytesTotal) : null,
    };
    this.progressTargets.set(key, target);
    return target;
  }

  private async handleFailure(
    progressId: bigint,
    error: unknown,
  ): Promise<FileDownloadOutcome> {
    const quotaPaused =
      error instanceof BusinessException &&
      error.bizCode === BusinessCode.FEDERATION_QUOTA_EXCEEDED;
    if (error instanceof FederationDownloadTerminatedError)
      return { kind: 'cancelled', error };
    const transitioned = await this.database.db
      .update(tables.fileSyncProgress)
      .set({
        status: quotaPaused ? 'PENDING' : 'FAILED',
        errorKind: quotaPaused
          ? 'QUOTA_PAUSED'
          : error instanceof Error
            ? error.message.slice(0, 255)
            : 'error',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });
    if (transitioned.length === 0) return { kind: 'cancelled', error };
    if (!quotaPaused) await this.publishFileTerminal(progressId, 'failed');
    this.progressTargets.delete(progressId.toString());
    return { kind: quotaPaused ? 'quota-paused' : 'failed', error };
  }
}
