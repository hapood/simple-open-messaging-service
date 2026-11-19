import { Injectable, Logger } from '@nestjs/common';
import { removeStagingFiles } from './staging-cleanup.js';
import { writeCheckpoint } from './write-checkpoint.js';
import { parseUploadTaskId } from './upload-task-id.js';
import { UploadExecutionState } from './upload-execution-state.js';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { message, pendingMedia, uploadSession } from '../database/schema.js';
import type { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import type { PublicMessage } from '../message/message.service.js';
import { MessageService } from '../message/message.service.js';
import { requireOutboundPendingMedia } from '../message/pending-media-row.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { MAX_FILE_NAME_LEN, type OutboundFilePayload } from './file-content.js';
import { ContentType } from '../database/enums.js';
import { dataDirectory } from '../common/data-directory.js';
import { InvalidMediaDataError } from './media-tool.js';
import { InvalidUploadMediaError, UploadService } from './upload.service.js';

import { MEDIA_UPLOAD_CHUNK_BYTES } from '../../shared/media-upload-limits.js';
import {
  UploadActivityService,
  type UploadActivityHandle,
  type UploadActivityTimeout,
} from './upload-activity.service.js';
import { uploadBodyActivity } from './upload-activity.transport.js';

export const RESUMABLE_CHUNK_SIZE = MEDIA_UPLOAD_CHUNK_BYTES;

export interface UploadSessionView {
  id: string;
  partId: string;
  position: number;
  originalName: string;
  mimeType: string;
  totalBytes: number;
  offset: number | null;
  chunkSize: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  phase?: 'UPLOADING' | 'COMPLETING';
  errorReason?: string;
  result?: OutboundFilePayload;
}

/**
 * Resumable client uploads under the batch-commit model.
 *
 * Transport state (the byte offset) lives in a sidecar file next to the staged `.part` — the
 * database row owns identity, quota, terminal state and the computed digest/result, never
 * in-flight progress. Per-file `complete` only records the digest + payload (record-first); the
 * CAS shard tree is touched exclusively by the idempotent batch commit that fires when the LAST
 * file of a staged message completes. Failure and explicit stop retain staging and identity.
 *
 * Durable outcomes are PENDING, COMPLETED and FAILED. Pending execution resumes from
 * the disk checkpoint and stored processing result, not a persisted processing phase.
 * The transport view reports a separate derived phase only for pending tasks.
 * Explicit stopping records FAILED + USER_STOPPED and retains its checkpoint for retry.
 *
 * In-memory execution state admits operations or rejects conflicts immediately.
 * Cancellation invalidates the current execution before draining its resource operations.
 * This coordination assumes one API process owns the staging directory.
 */
@Injectable()
export class ResumableUploadService {
  private readonly logger = new Logger(ResumableUploadService.name);
  private readonly tmpDir = dataDirectory('resumable');
  private readonly execution = new UploadExecutionState();
  private readonly generations = new Map<string, number>();
  private readonly activityHandles = new Map<string, UploadActivityHandle>();

  private invalidateAttempt(taskId: string) {
    this.generations.set(taskId, (this.generations.get(taskId) ?? 0) + 1);
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly messages: MessageService,
    private readonly quota: UserQuotaService,
    private readonly activity: UploadActivityService,
  ) {}

  private watchWaiting(
    session: typeof uploadSession.$inferSelect,
  ): UploadActivityHandle {
    const handle = this.activity.watch(
      {
        taskId: session.id.toString(),
        userId: session.creatorId,
      },
      (timeout) => this.failIdleAttempt(timeout),
    );
    this.activityHandles.set(session.id.toString(), handle);
    return handle;
  }

  private stopActivity(taskId: string) {
    const handle = this.activityHandles.get(taskId);
    if (handle) this.activity.stop(handle);
    this.activityHandles.delete(taskId);
    this.invalidateAttempt(taskId);
  }

  private async failIdleAttempt(timeout: UploadActivityTimeout): Promise<void> {
    await this.runTaskExecution(timeout.task.taskId, async () => {
      const session = await this.owned(
        timeout.task.userId,
        timeout.task.taskId,
      );
      if (!timeout.isCurrent() || session.status !== 'PENDING') return;
      await this.failSession(session.id, 'upload receive timed out');
    });
  }

  /** Startup scans validate execution ownership; observing a waiting attempt never renews its deadline. */
  async recoverWaiting(userId: number, taskId: string): Promise<void> {
    await this.runTaskExecution(taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (session.status !== 'PENDING') return;
      const offset = await this.readSidecarOffset(session);
      const handle = this.watchWaiting(session);
      if (offset === session.totalBytes) this.activity.suspend(handle);
    });
  }

  async recoverPending(userId: number, taskId: string): Promise<void> {
    await this.runTaskExecution(taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (session.status !== 'PENDING') return;
      const offset = await this.readSidecarOffset(session);
      if (offset === session.totalBytes)
        await this.completeLocked(userId, taskId);
      else this.watchWaiting(session);
    });
  }

  /** Transport admission must keep this exact handle, not reacquire an execution after await. */
  async activityForReceive(
    userId: number,
    taskId: string,
  ): Promise<UploadActivityHandle> {
    return this.runTaskExecution(taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (
        session.status !== 'PENDING' ||
        (await this.readSidecarOffset(session)) === session.totalBytes
      )
        return this.invalid('upload is not waiting for a chunk');
      const handle = this.watchWaiting(session);
      if (!this.activity.isCurrent(handle))
        return this.invalid('upload attempt expired');
      return handle;
    });
  }

  async init(
    userId: number,
    dto: InitResumableUploadDto,
  ): Promise<UploadSessionView> {
    return this.runBatchExecution(dto.clientMessageId, (pendingMediaId) =>
      this.initLocked(userId, dto, pendingMediaId),
    );
  }

  private async initLocked(
    userId: number,
    dto: InitResumableUploadDto,
    pendingMediaId: bigint | null,
  ): Promise<UploadSessionView> {
    // The client key identifies the send; the captured stage identifies this attempt.
    if (pendingMediaId === null)
      return this.invalid('media send is not pending');
    const stage = await this.requireStageForPart(userId, {
      pendingMediaId,
      position: dto.position,
      intent: dto.intent,
    });
    await this.quota.assertFileSize(userId, dto.totalBytes);
    const originalName = basename(dto.originalName).slice(0, MAX_FILE_NAME_LEN);
    if (!originalName) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid filename',
      );
    }
    const existing = await this.database.db.query.uploadSession.findFirst({
      where: and(
        eq(uploadSession.pendingMediaId, stage.id),
        eq(uploadSession.partId, dto.partId),
      ),
    });
    if (existing) {
      if (
        existing.creatorId !== userId ||
        existing.contentType !== stage.contentType ||
        existing.position !== dto.position ||
        existing.partIntent !== dto.intent ||
        existing.originalName !== originalName ||
        existing.mimeType !== dto.mimeType ||
        existing.totalBytes !== BigInt(dto.totalBytes)
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'upload metadata does not match the existing session',
        );
      }
      if (
        existing.status === 'PENDING' &&
        (await this.readSidecarOffset(existing)) < existing.totalBytes
      )
        this.watchWaiting(existing);
      return this.viewOf(existing);
    }
    // Session creation is the quota claim point. Only the transaction that inserts this logical part
    // charges it; an init retry observes the existing row above and is free. The position unique key
    // also prevents two partIds from claiming the same gallery slot.
    await this.quota.assertCanSend(userId);
    const created = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(uploadSession)
        .values({
          pendingMediaId: stage.id,
          partId: dto.partId,
          position: dto.position,
          partIntent: dto.intent,
          creatorId: userId,
          contentType: stage.contentType,
          originalName,
          mimeType: dto.mimeType || 'application/octet-stream',
          totalBytes: BigInt(dto.totalBytes),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await this.quota.claimFile(userId, 1, BigInt(dto.totalBytes), tx);
      return row;
    });
    if (!created) {
      const winner = await this.database.db.query.uploadSession.findFirst({
        where: and(
          eq(uploadSession.pendingMediaId, stage.id),
          eq(uploadSession.position, dto.position),
        ),
      });
      if (winner?.partId !== dto.partId) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'upload position is already assigned to another part',
        );
      }
      return this.initLocked(userId, dto, pendingMediaId);
    }
    // Only the transaction's newly inserted row may create a zero checkpoint. An existing
    // row without its sidecar is ambiguous (including a crash here), never implicitly new.
    try {
      await mkdir(this.tmpDir, { recursive: true });
      await writeFile(this.partPath(created.tmpKey), Buffer.alloc(0), {
        flag: 'wx',
      });
      await this.writeSidecar(created.tmpKey, 0n);
    } catch (error) {
      await this.failSession(created.id, this.errorMessage(error));
      throw error;
    }
    this.watchWaiting(created);
    return this.viewOf(created);
  }

  /** Stage validation for one sequential upload part: the staged send must be pending,
   *  authored by the caller, and the part must match the staged message's shape — single-file types
   *  take position 0 with the message type equal to the intent; GALLERY takes any position below
   *  fileCnt. */
  private async requireStageForPart(
    userId: number,
    part: {
      pendingMediaId: bigint;
      position: number;
      intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
    },
  ) {
    const stageRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.id, part.pendingMediaId),
    });
    const stage = stageRow ? requireOutboundPendingMedia(stageRow) : undefined;
    if (
      !stage ||
      stage.status !== 'pending' ||
      !(await this.messages.isAuthoredBy(
        {
          account: stage.creatorAccount,
          namespaceId: stage.publisherNamespaceId,
        },
        userId,
      ))
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'media send is not pending',
      );
    }
    const expectedMessageType =
      stage.fileCnt === 1 ? part.intent : ContentType.GALLERY;
    if (
      stage.contentType !== expectedMessageType ||
      part.position >= stage.fileCnt ||
      (stage.fileCnt === 1 && part.position !== 0)
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'upload part does not match the staged message',
      );
    }
    return stage;
  }

  async status(userId: number, taskId: string) {
    return this.viewOf(await this.owned(userId, taskId));
  }

  async append(
    userId: number,
    taskId: string,
    contentRange: string | undefined,
    body: Buffer,
  ) {
    return this.runAttemptExecution(taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (session.status === 'FAILED') {
        return this.invalid('upload requires explicit retry');
      }
      if (session.status !== 'PENDING') return this.viewOf(session);
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
      if (!match) return this.invalid('invalid Content-Range');
      const start = BigInt(match[1]);
      const end = BigInt(match[2]);
      const total = BigInt(match[3]);
      if (
        total !== session.totalBytes ||
        end < start ||
        end - start + 1n !== BigInt(body.length) ||
        body.length === 0 ||
        body.length > RESUMABLE_CHUNK_SIZE ||
        end >= total
      ) {
        return this.invalid('invalid upload range');
      }
      const bodyReceive = uploadBodyActivity(body);
      // Direct callers already have their whole body. Give them the same explicit receive ->
      // processing -> waiting lifecycle as the HTTP parser, rather than leaving IO on an idle timer.
      const receive =
        bodyReceive ??
        this.activity.beginReceiving(
          this.watchWaiting(session),
          () => undefined,
        );
      if (!receive) return this.invalid('upload is not waiting for a chunk');
      if (!bodyReceive) {
        this.activity.activity(receive, body.length);
        this.activity.endReceiving(receive);
      }
      try {
        const validateReceive = () => {
          this.execution.assertCurrent();
          if (
            receive &&
            (receive.upload.task.taskId !== taskId ||
              receive.upload.task.userId !== userId ||
              !this.activity.isCurrent(receive.upload))
          ) {
            return this.invalid('upload attempt changed');
          }
        };
        validateReceive();
        const offset = await this.alignPart(session);
        if (start < offset && end < offset) {
          return this.viewOf(session);
        }
        if (start !== offset) {
          throw new BusinessException(
            BusinessCode.ALREADY_EXISTS,
            'upload offset mismatch',
            409,
            { offset: Number(offset) },
          );
        }
        // Bytes land before the atomic checkpoint rewrite. A crash between them leaves surplus
        // bytes that alignPart truncates. The database records activity time, never transport offset.
        validateReceive();
        await appendFile(this.partPath(session.tmpKey), body, { flag: 'a' });
        validateReceive();
        const nextOffset = offset + BigInt(body.length);
        await this.writeSidecar(session.tmpKey, nextOffset);
        validateReceive();
        // Once every byte is durable, only server processing remains. Response cleanup
        // must not re-arm a network-idle deadline for this task.
        if (nextOffset === session.totalBytes)
          this.activity.suspend(receive.upload);
        await this.database.db
          .update(uploadSession)
          .set({ updatedAt: new Date() })
          .where(
            and(
              eq(uploadSession.id, session.id),
              eq(uploadSession.status, 'PENDING'),
            ),
          );
        return this.viewOf(session);
      } finally {
        // HTTP response/disconnect owns release for transport-admitted bodies.
        if (!bodyReceive) this.activity.releaseReceiving(receive);
      }
    });
  }

  async complete(userId: number, taskId: string) {
    return this.runAttemptExecution(taskId, () =>
      this.completeLocked(userId, taskId),
    );
  }

  private async completeLocked(
    userId: number,
    taskId: string,
  ): Promise<UploadSessionView> {
    // Reject premature requests before entering server-owned processing. A bad request
    // must not turn an otherwise resumable receiving task into a durable failure.
    const admitted = await this.owned(userId, taskId);
    if (
      admitted.status === 'PENDING' &&
      !(admitted.digest && admitted.result) &&
      (await this.readSidecarOffset(admitted)) < admitted.totalBytes
    )
      return this.invalid('upload is incomplete');
    try {
      return await this.processCompleteLocked(userId, taskId);
    } catch (error) {
      this.execution.assertCurrent();
      const session = await this.owned(userId, taskId);
      this.execution.assertCurrent();
      if (session.status === 'PENDING') {
        await this.failSession(session.id, this.errorMessage(error));
      }
      throw error;
    }
  }

  private async processCompleteLocked(userId: number, taskId: string) {
    let session = await this.owned(userId, taskId);
    if (session.status === 'COMPLETED') {
      await this.cleanupCompletedStaging(session.tmpKey);
      return this.viewOf(session);
    }
    if (session.status === 'FAILED') {
      return this.invalid('upload requires explicit retry');
    }
    if (session.status === 'PENDING' && session.digest && session.result) {
      const handle = this.activityHandles.get(taskId);
      if (handle) this.activity.suspend(handle);
      await this.tryCommitBatch(session, userId);
      return this.viewOf(await this.owned(userId, taskId));
    }
    const offset = await this.alignPart(session);
    this.execution.assertCurrent();
    if (offset !== session.totalBytes) {
      return this.invalid('upload is incomplete');
    }
    const checkpoint = await this.readSidecar(session);
    const path = this.partPath(session.tmpKey);
    const handle = this.activityHandles.get(taskId);
    if (handle) {
      if (!this.activity.isCurrent(handle))
        return this.invalid('upload attempt expired');
      this.activity.suspend(handle);
    }
    // The complete disk checkpoint owns continuation; processing is not a durable outcome.
    let stored = session.result as {
      payload?: OutboundFilePayload;
      overrideContentType?: ContentType;
    } | null;
    if (!stored || !stored.payload) {
      // Record-first: hash + resolve the staged bytes and durably record digest/result. The CAS
      // shard tree is NOT touched here — landing happens at the batch barrier.
      const resolved = await this.upload
        .resolveStagedPart(
          path,
          session.partIntent as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
          session.originalName,
          session.mimeType,
          this.execution.signal(),
        )
        .catch(async (error: unknown) => {
          this.execution.assertCurrent();
          if (
            !(error instanceof InvalidUploadMediaError) &&
            !(error instanceof InvalidMediaDataError)
          )
            throw error;
          await this.failSession(session.id, error.message, {
            outcome: 'invalid-media',
            reason: error.message.slice(0, 255),
          });
          // Only positively invalid final media may discard its staging bytes.
          await this.discardStaging(session.tmpKey);
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            error.message,
          );
        });
      this.execution.assertCurrent();
      if (
        checkpoint.digest !== undefined &&
        checkpoint.digest !== resolved.digest
      ) {
        throw new Error(
          'staged upload digest does not match its final checkpoint',
        );
      }
      // Preserve the UUID -> digest association before database result persistence or CAS
      // publication. A crash after this checkpoint leaves the full source identifiable.
      await this.writeSidecar(
        session.tmpKey,
        session.totalBytes,
        resolved.digest,
      );
      this.execution.assertCurrent();
      if (resolved.overrideContentType !== undefined) {
        if (session.pendingMediaId === null)
          return this.invalid('upload task has no pending stage');
        await this.messages.updateStagedContentType(
          session.pendingMediaId,
          userId,
          resolved.overrideContentType,
        );
      }
      stored = {
        payload: resolved.payload,
        ...(resolved.overrideContentType
          ? { overrideContentType: resolved.overrideContentType }
          : {}),
      };
      const [updated] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'PENDING',
          digest: resolved.digest,
          result: stored,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, session.id),
            eq(uploadSession.status, 'PENDING'),
          ),
        )
        .returning();
      if (!updated) {
        // Honor a terminal transition instead of trusting the stale row.
        session = await this.owned(userId, taskId);
        if (session.status !== 'PENDING' && session.status !== 'COMPLETED') {
          return this.invalid('upload state changed');
        }
      } else {
        session = updated;
      }
    }
    // The last completed file carries the batch over the barrier: idempotent CAS landing +
    // the single commit transaction (message, assets, MediaAsset claims, fan-out).
    await this.tryCommitBatch(session, userId);
    return this.viewOf(await this.owned(userId, taskId));
  }

  /**
   * Batch barrier + idempotent commit, guarded by the current execution identity.
   * Phases: (1) barrier — every unfinished session must be PENDING with a recorded
   * digest+result; (2) move — land every staged part into the CAS shard tree, idempotently, and
   * REQUIRE the shard to exist on disk (a part whose bytes vanished fails that part instead of
   * committing a database claim for bytes that are not on disk); (3) the single database
   * transaction via MessageService.commitOutboundBatch; (4) finalize sessions + drop staging.
   * Every phase is a no-op when already done, so a crash anywhere re-converges on re-entry.
   */
  private async tryCommitBatch(
    trigger: typeof uploadSession.$inferSelect,
    userId: number,
  ): Promise<
    | { kind: 'not-ready' }
    | { kind: 'committed'; message: PublicMessage; newlyPromoted: boolean }
    | { kind: 'already-committed' }
  > {
    if (trigger.creatorId !== userId)
      return this.invalid('upload task owner mismatch');
    if (trigger.status === 'COMPLETED' && trigger.messageId !== null) {
      await this.cleanupCommittedSessions([trigger.id]);
      return { kind: 'already-committed' };
    }
    if (trigger.pendingMediaId === null) {
      return this.invalid('upload task has no pending stage');
    }
    const stageRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.id, trigger.pendingMediaId),
    });
    if (!stageRow)
      return this.invalid(
        'upload stage disappeared without a committed message',
      );
    const sessions = await this.database.db
      .select()
      .from(uploadSession)
      .where(eq(uploadSession.pendingMediaId, trigger.pendingMediaId))
      .orderBy(asc(uploadSession.position));
    if (sessions.some((session) => session.creatorId !== userId)) {
      return this.invalid('upload stage contains tasks from another owner');
    }
    const stage = requireOutboundPendingMedia(stageRow);
    if (stage.status !== 'pending') return { kind: 'not-ready' };
    if (
      sessions.length === 0 ||
      sessions.some(
        (s) => s.status !== 'PENDING' && s.status !== 'COMPLETED',
      ) ||
      sessions.length !== stage.fileCnt
    ) {
      return { kind: 'not-ready' };
    }
    const items = sessions.map((session) => {
      const stored = session.result as {
        payload?: OutboundFilePayload;
      } | null;
      return {
        session,
        digest: session.digest as string,
        payload: stored?.payload as OutboundFilePayload,
      };
    });
    if (items.some((item) => !item.digest || !item.payload))
      return { kind: 'not-ready' };
    for (const item of items) {
      this.execution.assertCurrent();
      try {
        item.payload.localMeta = await this.upload.prepareStagedMetadata(
          this.partPath(item.session.tmpKey),
          item.digest,
          item.payload.localMeta,
          this.execution.signal(),
        );
        this.execution.assertCurrent();
        await this.upload.landStagedPart(
          this.partPath(item.session.tmpKey),
          item.digest,
        );
      } catch (error) {
        // IO failures are not evidence of invalid media. Preserve bytes and the pending
        // stage so an explicit retry can re-drive this part and the batch barrier.
        await this.failSession(item.session.id, this.errorMessage(error));
        throw error;
      }
    }
    this.execution.beginCommit();
    const committed = await this.messages.commitOutboundBatch(
      stage.id,
      userId,
      items.map((item) => ({
        sessionId: item.session.id,
        digest: item.digest,
        payload: item.payload,
      })),
    );
    await this.cleanupCommittedSessions(sessions.map((session) => session.id));
    return { kind: 'committed', ...committed };
  }

  /** Filesystem cleanup only; task outcomes were committed with the message. */
  private async cleanupCommittedSessions(sessionIds: bigint[]) {
    if (sessionIds.length === 0) return;
    const rows = await this.database.db.query.uploadSession.findMany({
      where: and(
        inArray(uploadSession.id, sessionIds),
        eq(uploadSession.status, 'COMPLETED'),
      ),
      columns: { tmpKey: true, id: true },
    });
    for (const row of rows) {
      this.stopActivity(row.id.toString());
      await this.cleanupCompletedStaging(row.tmpKey);
    }
  }

  /** Cleanup failure cannot undo an already committed task or message. */
  private async cleanupCompletedStaging(tmpKey: string): Promise<void> {
    try {
      await this.discardStaging(tmpKey);
    } catch (error) {
      this.logger.error(
        `Completed upload ${tmpKey} retains staging after cleanup failure`,
        error,
      );
    }
  }

  /** Terminal errors never reset identity or remove potentially recoverable bytes. */
  private async failSession(
    id: bigint,
    reason: string,
    invalidMedia?: { outcome: 'invalid-media'; reason: string },
  ) {
    const rows = await this.database.db
      .update(uploadSession)
      .set({
        status: 'FAILED',
        errorReason: reason.slice(0, 255),
        ...(invalidMedia ? { result: invalidMedia, digest: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(uploadSession.id, id), eq(uploadSession.status, 'PENDING')))
      .returning({ id: uploadSession.id });
    for (const row of rows) this.stopActivity(row.id.toString());
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'upload operation failed';
  }

  /** Explicit retry preserves identity and resumes only from a validated disk checkpoint. */
  async retry(userId: number, taskId: string): Promise<UploadSessionView> {
    return this.runTaskExecution(taskId, async () => {
      const session = await this.owned(userId, taskId);
      const cancelled = session.errorReason === 'USER_CANCELLED';
      if (session.status !== 'FAILED') {
        return this.viewOf(session);
      }
      const outcome = session.result as {
        outcome?: string;
        reason?: unknown;
      } | null;
      const invalidMediaReason =
        outcome?.outcome === 'invalid-media' &&
        typeof outcome.reason === 'string'
          ? outcome.reason
          : undefined;
      if (session.pendingMediaId === null)
        return this.invalid('upload task has no pending stage');
      await this.requireStageForPart(userId, {
        pendingMediaId: session.pendingMediaId,
        position: session.position,
        intent: session.partIntent as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
      });
      await this.quota.assertCanSend(userId);
      this.execution.assertCurrent();
      let offset: bigint;
      if (invalidMediaReason !== undefined || cancelled) {
        // Explicit cancellation removed the checkpoint. Retry starts at zero, including after
        // a partial cleanup failure. Ordinary missing checkpoints still remain errors.
        if (cancelled) await this.cleanupCancelledSessions([session]);
        else await this.discardStaging(session.tmpKey);
        this.execution.assertCurrent();
        await mkdir(this.tmpDir, { recursive: true });
        await writeFile(this.partPath(session.tmpKey), Buffer.alloc(0));
        await this.writeSidecar(session.tmpKey, 0n);
        this.execution.assertCurrent();
        offset = 0n;
      } else {
        offset = await this.alignPart(session);
      }
      this.execution.assertCurrent();
      const [resumed] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'PENDING',
          ...(invalidMediaReason !== undefined || cancelled
            ? { digest: null, result: null }
            : {}),
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, session.id),
            eq(uploadSession.status, session.status),
          ),
        )
        .returning();
      this.execution.assertCurrent();
      if (!resumed) return this.invalid('upload state changed');
      // Stable disk identity, fresh runtime identity. Old parsed bodies cannot enter this attempt.
      this.stopActivity(taskId);
      if (offset === session.totalBytes)
        return this.completeLocked(userId, taskId);
      this.watchWaiting(resumed);
      return this.viewOf(resumed);
    });
  }

  async retryForAdmin(taskId: string): Promise<UploadSessionView> {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, parseUploadTaskId(taskId)),
    });
    if (!session)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload not found',
        404,
      );
    return this.retry(session.creatorId, taskId);
  }

  async stop(userId: number, taskId: string): Promise<UploadSessionView> {
    return this.cancelExecution(userId, taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (session.status === 'COMPLETED')
        return this.invalid('completed upload cannot be stopped');
      if (session.errorReason === 'USER_CANCELLED') return this.viewOf(session);
      const [stopped] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'FAILED',
          errorReason: 'USER_STOPPED',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, session.id),
            inArray(uploadSession.status, ['PENDING', 'FAILED']),
          ),
        )
        .returning();
      this.stopActivity(taskId);
      return this.viewOf(stopped ?? session);
    });
  }

  async cancel(userId: number, taskId: string) {
    return this.cancelExecution(userId, taskId, async () => {
      const session = await this.owned(userId, taskId);
      if (session.status === 'COMPLETED' || session.messageId !== null)
        return this.invalid('committed upload cannot be cancelled');
      const [cancelled] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'FAILED',
          errorReason: 'USER_CANCELLED',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, session.id),
            eq(uploadSession.status, session.status),
          ),
        )
        .returning();
      if (!cancelled) return this.invalid('upload state changed');
      this.stopActivity(taskId);
      await this.cleanupCancelledSessions([cancelled]);
      return this.viewOf(cancelled);
    });
  }

  /** A cancellation is durable even if cleanup fails; repeating it retries every artifact. */
  private async cleanupCancelledSessions(
    sessions: Array<{ tmpKey: string }>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      sessions.map((session) => this.discardStaging(session.tmpKey)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length) {
      const error = new AggregateError(
        failures,
        'cancelled upload cleanup failed',
      );
      this.logger.error(
        'Cancelled uploads retain temporary artifacts after cleanup failure',
        error,
      );
      throw error;
    }
  }

  /** Cancel every uncommitted part and remove its temporary message stage. */
  async cancelBatch(userId: number, clientMessageId: string) {
    return this.cancelBatchExecution(
      userId,
      clientMessageId,
      async (pendingMediaId) => {
        const stageRow =
          pendingMediaId === null
            ? undefined
            : await this.database.db.query.pendingMedia.findFirst({
                where: eq(pendingMedia.id, pendingMediaId),
              });
        const stage = stageRow
          ? requireOutboundPendingMedia(stageRow)
          : undefined;
        if (
          !stage ||
          !(await this.messages.isAuthoredBy(
            {
              account: stage.creatorAccount,
              namespaceId: stage.publisherNamespaceId,
            },
            userId,
          ))
        ) {
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'upload batch not found',
            404,
          );
        }
        // A deleted stage has no remaining cleanup work. Never select detached history
        // by a client idempotency key, even when this command is repeated.
        const sessions = await this.database.db
          .select()
          .from(uploadSession)
          .where(eq(uploadSession.pendingMediaId, stage.id));
        if (sessions.some((session) => session.creatorId !== userId))
          return this.invalid('upload batch contains mixed owners');
        const owned = sessions;
        if (
          owned.some(
            (session) =>
              session.status === 'COMPLETED' || session.messageId !== null,
          )
        ) {
          throw new BusinessException(
            BusinessCode.ALREADY_EXISTS,
            'completed upload batch cannot be cancelled',
            409,
          );
        }
        // Cancellation has invalidated and drained the prior execution. Persist the outcome
        // before touching the filesystem so retry restarts at zero after cleanup.
        await this.database.db.transaction(async (tx) => {
          if (owned.length > 0) {
            await tx
              .update(uploadSession)
              .set({
                status: 'FAILED',
                errorReason: 'USER_CANCELLED',
                updatedAt: new Date(),
              })
              .where(
                inArray(
                  uploadSession.id,
                  owned.map((session) => session.id),
                ),
              );
          }
        });
        for (const session of owned) this.stopActivity(session.id.toString());
        await this.cleanupCancelledSessions(owned);
        // Keep the coordinator and task associations until every artifact is gone.
        // A cleanup failure or crash leaves enough identity for a repeated cancellation.
        // The cancelling phase rejects retry until cleanup and deletion have finished.
        if (stage) {
          await this.database.db
            .delete(pendingMedia)
            .where(eq(pendingMedia.id, stage.id));
        }
        return { clientMessageId, cancelled: owned.length };
      },
    );
  }

  /** Commit ready parts and retain stopped unfinished parts for inspection. */
  async sendCompleted(userId: number, clientMessageId: string) {
    return this.runBatchExecution(clientMessageId, async (pendingMediaId) => {
      const stageRow =
        pendingMediaId === null
          ? undefined
          : await this.database.db.query.pendingMedia.findFirst({
              where: eq(pendingMedia.id, pendingMediaId),
            });
      if (!stageRow) return this.replayCompletedBatch(userId, clientMessageId);
      const stage = stageRow
        ? requireOutboundPendingMedia(stageRow)
        : undefined;
      if (
        !stage ||
        !(await this.messages.isAuthoredBy(
          {
            account: stage.creatorAccount,
            namespaceId: stage.publisherNamespaceId,
          },
          userId,
        ))
      ) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'upload batch not found',
          404,
        );
      }
      if (stage.status !== 'pending')
        return this.invalid('media send is not pending');
      const owned = await this.database.db
        .select()
        .from(uploadSession)
        .where(eq(uploadSession.pendingMediaId, stage.id))
        .orderBy(asc(uploadSession.position));
      if (owned.some((session) => session.creatorId !== userId))
        return this.invalid('upload batch contains mixed owners');
      const completed = owned.filter(
        (session) =>
          session.status === 'PENDING' && session.digest && session.result,
      );
      const discarded = owned.filter(
        (item) =>
          !completed.includes(item) && item.errorReason !== 'USER_CANCELLED',
      );
      if (discarded.length > 0) {
        await this.database.db
          .update(uploadSession)
          .set({
            status: 'FAILED',
            errorReason: 'USER_STOPPED',
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(
                uploadSession.id,
                discarded.map((item) => item.id),
              ),
              inArray(uploadSession.status, ['PENDING', 'FAILED']),
            ),
          );
      }
      for (const session of discarded) this.stopActivity(session.id.toString());
      if (completed.length === 0) {
        return { clientMessageId, sent: false, completed: 0 };
      }
      // Keep original positions/identities. The selected payload array already preserves order.
      await this.database.db
        .update(pendingMedia)
        .set({ fileCnt: completed.length, updatedAt: new Date() })
        .where(eq(pendingMedia.id, stage.id));
      await this.commitSelectedBatch(stage.id, userId, completed).catch(
        async (error: unknown) => {
          // Keep the original batch retryable if selected publication did not commit.
          await this.database.db
            .update(pendingMedia)
            .set({ fileCnt: stage.fileCnt, updatedAt: new Date() })
            .where(eq(pendingMedia.id, stage.id));
          for (const session of completed)
            await this.failSession(session.id, this.errorMessage(error));
          throw error;
        },
      );
      return {
        clientMessageId,
        sent: true,
        completed: completed.length,
      };
    });
  }

  private async replayCompletedBatch(userId: number, clientMessageId: string) {
    // Resolve the send idempotency key once, then follow direct task ownership.
    // Digest usage and detached task history cannot establish a batch result.
    const committed = await this.database.db.query.message.findFirst({
      where: eq(message.clientMessageId, clientMessageId),
    });
    if (
      !committed ||
      committed.creatorAccount === null ||
      !(await this.messages.isAuthoredBy(
        {
          account: committed.creatorAccount,
          namespaceId: committed.publisherNamespaceId,
        },
        userId,
      ))
    ) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload batch not found',
        404,
      );
    }
    const tasks = await this.database.db
      .select()
      .from(uploadSession)
      .where(eq(uploadSession.messageId, committed.id));
    if (tasks.length === 0)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload batch not found',
        404,
      );
    if (
      tasks.some(
        (task) => task.creatorId !== userId || task.status !== 'COMPLETED',
      )
    )
      return this.invalid(
        'committed upload task ownership or outcome is invalid',
      );
    return { clientMessageId, sent: true, completed: tasks.length };
  }

  private async commitSelectedBatch(
    pendingMediaId: bigint,
    userId: number,
    sessions: Array<typeof uploadSession.$inferSelect>,
  ) {
    for (const session of sessions) {
      this.execution.assertCurrent();
      const payload = (session.result as { payload: OutboundFilePayload })
        .payload;
      payload.localMeta = await this.upload.prepareStagedMetadata(
        this.partPath(session.tmpKey),
        session.digest!,
        payload.localMeta,
        this.execution.signal(),
      );
      this.execution.assertCurrent();
      await this.upload.landStagedPart(
        this.partPath(session.tmpKey),
        session.digest!,
      );
    }
    this.execution.beginCommit();
    const committed = await this.messages.commitOutboundBatch(
      pendingMediaId,
      userId,
      sessions.map((session) => ({
        sessionId: session.id,
        digest: session.digest!,
        payload: (session.result as { payload: OutboundFilePayload }).payload,
      })),
    );
    await this.cleanupCommittedSessions(sessions.map((session) => session.id));
    return committed;
  }

  async listForAdmin(query: { skip?: number; take?: number; userId?: number }) {
    const where = and(
      inArray(uploadSession.status, ['PENDING', 'FAILED']),
      query.userId === undefined
        ? undefined
        : eq(uploadSession.creatorId, query.userId),
    );
    const [rows, [aggregate]] = await Promise.all([
      this.database.db
        .select({
          id: uploadSession.id,
          creatorId: uploadSession.creatorId,
          digest: uploadSession.digest,
          bytes: uploadSession.totalBytes,
          status: uploadSession.status,
          tmpKey: uploadSession.tmpKey,
        })
        .from(uploadSession)
        .where(where)
        .orderBy(desc(uploadSession.id))
        .offset(query.skip ?? 0)
        .limit(query.take ?? 50),
      this.database.db
        .select({
          total: count(),
          bytes: sql<string>`coalesce(sum(${uploadSession.totalBytes}), 0)::text`,
        })
        .from(uploadSession)
        .where(where),
    ]);
    return {
      ...aggregate,
      list: await Promise.all(
        rows.map(async (row) => ({
          id: row.id.toString(),
          userId: row.creatorId,
          digest: row.digest,
          bytes: row.bytes.toString(),
          status: row.status,
          bytesReceived: await this.readSidecarOffset({
            tmpKey: row.tmpKey,
            totalBytes: row.bytes,
          })
            .then((offset) => offset.toString())
            .catch(() => null),
        })),
      ),
    };
  }

  /** Stop only the selected task; siblings remain available at the batch barrier. */
  async stopForAdmin(taskId: string): Promise<UploadSessionView> {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, parseUploadTaskId(taskId)),
    });
    if (!session)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload not found',
        404,
      );
    return this.stop(session.creatorId, taskId);
  }

  private async owned(userId: number, taskId: string) {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: and(
        eq(uploadSession.id, parseUploadTaskId(taskId)),
        eq(uploadSession.creatorId, userId),
      ),
    });
    if (!session) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload not found',
        404,
      );
    }
    return session;
  }

  private async viewOf(
    session: typeof uploadSession.$inferSelect,
  ): Promise<UploadSessionView> {
    const stored = session.result as {
      payload?: OutboundFilePayload;
    } | null;
    // Unknown progress is null, never a fabricated zero that invites a destructive restart.
    const offset =
      session.status === 'COMPLETED'
        ? session.totalBytes
        : await this.readSidecarOffset(session).catch(() => null);
    const result = stored?.payload ? { ...stored.payload } : undefined;
    if (result) delete result.localMeta;
    return {
      id: session.id.toString(),
      partId: session.partId,
      position: session.position,
      originalName: session.originalName,
      mimeType: session.mimeType,
      totalBytes: Number(session.totalBytes),
      offset: offset === null ? null : Number(offset),
      chunkSize: RESUMABLE_CHUNK_SIZE,
      ...(session.status === 'PENDING'
        ? {
            status: session.status,
            phase:
              offset === session.totalBytes ||
              (session.digest && stored?.payload)
                ? ('COMPLETING' as const)
                : ('UPLOADING' as const),
          }
        : { status: session.status }),
      ...(session.errorReason ? { errorReason: session.errorReason } : {}),
      ...(result ? { result } : {}),
    };
  }

  private invalid(message: string): never {
    throw new BusinessException(BusinessCode.VALIDATION_FAILED, message);
  }

  // ---- Staging artifacts: <tmpKey>.part + authoritative <tmpKey>.resume.json sidecar ----

  private partPath(tmpKey: string) {
    return join(this.tmpDir, `${tmpKey}.part`);
  }

  private sidecarPath(tmpKey: string) {
    return join(this.tmpDir, `${tmpKey}.resume.json`);
  }

  private async readSidecarOffset(
    session: Pick<typeof uploadSession.$inferSelect, 'tmpKey' | 'totalBytes'>,
  ): Promise<bigint> {
    return (await this.readSidecar(session)).offset;
  }

  /** Missing, corrupt, or out-of-bounds checkpoints are errors, not permission to reset. */
  private async readSidecar(
    session: Pick<typeof uploadSession.$inferSelect, 'tmpKey' | 'totalBytes'>,
  ): Promise<{ offset: bigint; digest?: string }> {
    const checkpointPath = this.sidecarPath(session.tmpKey);
    if (!(await lstat(checkpointPath)).isFile())
      throw new Error('resumable checkpoint is not a regular file');
    const meta: unknown = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (
      !meta ||
      typeof meta !== 'object' ||
      Array.isArray(meta) ||
      Object.keys(meta).some((key) => key !== 'offset' && key !== 'digest') ||
      !('offset' in meta) ||
      typeof meta.offset !== 'number' ||
      !Number.isSafeInteger(meta.offset) ||
      meta.offset < 0 ||
      BigInt(meta.offset) > session.totalBytes ||
      ('digest' in meta &&
        (typeof meta.digest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(meta.digest) ||
          BigInt(meta.offset) !== session.totalBytes))
    ) {
      throw new Error('invalid resumable upload checkpoint');
    }
    return {
      offset: BigInt(meta.offset),
      ...('digest' in meta ? { digest: meta.digest as string } : {}),
    };
  }

  /** Atomically rewrite the checkpoint; digest is present only after full-file hashing. */
  private async writeSidecar(tmpKey: string, offset: bigint, digest?: string) {
    if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error('invalid upload checkpoint digest');
    }
    await writeCheckpoint(
      this.sidecarPath(tmpKey),
      JSON.stringify({ offset: Number(offset), ...(digest ? { digest } : {}) }),
      this.partPath(tmpKey),
    );
  }

  /** Align the staged file to the sidecar offset. Longer → truncate the uncommitted surplus
   *  (crash between append and sidecar rewrite); shorter → external corruption, refuse loudly. */
  private async alignPart(
    session: typeof uploadSession.$inferSelect,
  ): Promise<bigint> {
    const offset = await this.readSidecarOffset(session);
    const path = this.partPath(session.tmpKey);
    const entry = await lstat(path);
    if (!entry.isFile())
      throw new Error('resumable temporary file is not a regular file');
    const actual = entry.size;
    if (BigInt(actual) > offset) {
      await truncate(path, Number(offset));
    } else if (BigInt(actual) < offset) {
      throw new Error(
        'resumable temporary file is shorter than committed offset',
      );
    }
    return offset;
  }

  /** Strict cleanup; the owning lifecycle decides whether a committed result may still succeed. */
  private async discardStaging(tmpKey: string): Promise<void> {
    await removeStagingFiles([
      this.partPath(tmpKey),
      this.sidecarPath(tmpKey),
      `${this.sidecarPath(tmpKey)}.tmp`,
    ]);
  }

  /** Reject requests whose captured attempt was superseded during asynchronous admission. */
  private async runAttemptExecution<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const generation = this.generations.get(taskId) ?? 0;
    return this.runTaskExecution(taskId, () => {
      if ((this.generations.get(taskId) ?? 0) !== generation) {
        return this.invalid('upload attempt changed');
      }
      return operation();
    });
  }

  private async runTaskExecution<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, parseUploadTaskId(key)),
    });
    if (!session)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload not found',
        404,
      );
    const executionKey = this.taskExecutionKey(session);
    const outcome = await this.execution.run(
      executionKey,
      async () => {
        const current = await this.database.db.query.uploadSession.findFirst({
          where: eq(uploadSession.id, parseUploadTaskId(key)),
        });
        if (!current)
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'upload not found',
            404,
          );
        // Revalidate the ownership snapshot after asynchronous lookup.
        if (this.taskExecutionKey(current) !== executionKey)
          return { changed: true } as const;
        try {
          this.execution.assertCurrent();
          return { changed: false, value: await operation() } as const;
        } catch (error) {
          // A superseded execution cannot publish its failure over cancellation.
          this.execution.assertCurrent();
          // Request validation/conflicts are not terminal execution failures.
          if (!(error instanceof BusinessException)) {
            await this.failSession(current.id, this.errorMessage(error));
          }
          throw error;
        }
      },
      key,
    );
    return outcome.changed
      ? this.runTaskExecution(key, operation)
      : outcome.value;
  }

  /** Administrative deletion uses the same cancellation transition as the upload owner. */
  async cancelTemporaryUpload(tmpKey: string): Promise<boolean> {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.tmpKey, tmpKey),
      columns: { creatorId: true, id: true },
    });
    if (!session) return false;
    await this.cancel(session.creatorId, session.id.toString());
    return true;
  }

  private taskExecutionKey(session: {
    id: bigint;
    pendingMediaId: bigint | null;
  }): string {
    return session.pendingMediaId === null
      ? `upload:${session.id}`
      : `stage:${session.pendingMediaId}`;
  }

  private async runBatchExecution<T>(
    clientMessageId: string,
    operation: (pendingMediaId: bigint | null) => Promise<T>,
  ): Promise<T> {
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
      columns: { id: true },
    });
    // Capture once; never redirect this command to a replacement stage.
    if (!stage) return operation(null);
    return this.execution.run(`stage:${stage.id}`, () => operation(stage.id));
  }

  private async cancelExecution<T>(
    userId: number,
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const session = await this.owned(userId, taskId);
    return this.execution.cancel(
      this.taskExecutionKey(session),
      operation,
      () => this.stopActivity(taskId),
      taskId,
    );
  }

  private async cancelBatchExecution<T>(
    userId: number,
    clientMessageId: string,
    operation: (pendingMediaId: bigint | null) => Promise<T>,
  ): Promise<T> {
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    if (!stage) return operation(null);
    if (
      stage.direction !== 'OUTBOUND' ||
      stage.creatorAccount === null ||
      !(await this.messages.isAuthoredBy(
        {
          account: stage.creatorAccount,
          namespaceId: stage.publisherNamespaceId,
        },
        userId,
      ))
    )
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'upload batch not found',
        404,
      );
    const tasks = await this.database.db
      .select()
      .from(uploadSession)
      .where(eq(uploadSession.pendingMediaId, stage.id));
    if (tasks.some((task) => task.creatorId !== userId))
      return this.invalid('upload batch contains mixed owners');
    return this.execution.cancel(
      `stage:${stage.id}`,
      () => operation(stage.id),
      () => {
        for (const task of tasks) this.stopActivity(task.id.toString());
      },
    );
  }
}
