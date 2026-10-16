import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { pendingMedia, uploadSession } from '../database/schema.js';
import type { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import type { PublicMessage } from '../message/message.service.js';
import { MessageService } from '../message/message.service.js';
import { requireOutboundPendingMedia } from '../message/pending-media-row.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { MAX_FILE_NAME_LEN, type OutboundFilePayload } from './file-content.js';
import { ContentType } from '../database/enums.js';
import { dataDirectory } from '../common/data-directory.js';
import { UploadService } from './upload.service.js';

import {
  MAX_MEDIA_FILE_BYTES,
  MEDIA_UPLOAD_CHUNK_BYTES,
} from '../../shared/media-upload-limits.js';

export const RESUMABLE_CHUNK_SIZE = MEDIA_UPLOAD_CHUNK_BYTES;

export interface UploadSessionView {
  uploadId: string;
  clientMessageId: string;
  partId: string;
  position: number;
  originalName: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  chunkSize: number;
  status: 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'ABORTED';
  result?: OutboundFilePayload;
}

/**
 * Resumable client uploads under the batch-commit model.
 *
 * Transport state (the byte offset) lives in a sidecar file next to the staged `.part` — the
 * database row owns identity, quota, terminal state and the computed digest/result, never
 * in-flight progress. Per-file `complete` only records the digest + payload (record-first); the
 * CAS shard tree is touched exclusively by the idempotent batch commit that fires when the LAST
 * file of a staged message completes. Consequence: a cancelled batch leaves NOTHING in the CAS
 * store — cancellation is unlinking staging files plus flipping session rows.
 *
 * Session status meanings:
 *   UPLOADING  — chunks still arriving (sidecar authoritative for the offset)
 *   COMPLETING — per-file done: digest + result recorded, staging retained, awaiting batch commit
 *   COMPLETED  — the batch committed (message exists, bytes in the shard tree, staging removed)
 *   ABORTED    — terminal failure (admin abort / staged part lost); re-init resets for retry
 *
 * Lock ordering: per-file operations hold the uploadId advisory lock and may then take the batch
 * (clientMessageId) lock inside `complete`; the batch path never acquires an uploadId lock, so no
 * cycle can form.
 */
@Injectable()
export class ResumableUploadService {
  private readonly tmpDir = dataDirectory('resumable');
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly messages: MessageService,
    private readonly quota: UserQuotaService,
  ) {}

  async init(
    userId: number,
    dto: InitResumableUploadDto,
  ): Promise<UploadSessionView> {
    const stage = await this.requireStageForPart(userId, dto);
    // The complete attachment limit is independent of transport chunk size and daily quota.
    if (dto.totalBytes > MAX_MEDIA_FILE_BYTES) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'file too large',
      );
    }
    const originalName = basename(dto.originalName).slice(0, MAX_FILE_NAME_LEN);
    if (!originalName) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid filename',
      );
    }
    const existing = await this.database.db.query.uploadSession.findFirst({
      where: and(
        eq(uploadSession.clientMessageId, dto.clientMessageId),
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
      // Retry with stable identity: a terminated session restarts from a fresh staging file.
      if (existing.status === 'ABORTED') {
        return this.viewOf(await this.resetForRetry(existing));
      }
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
          clientMessageId: dto.clientMessageId,
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
      await this.quota.preCheckFile(userId, 1, BigInt(dto.totalBytes), tx);
      await this.quota.tickLax(userId, 'files', tx);
      await this.quota.tickFileBytes(userId, BigInt(dto.totalBytes), tx);
      return row;
    });
    if (!created) {
      const winner = await this.database.db.query.uploadSession.findFirst({
        where: and(
          eq(uploadSession.clientMessageId, dto.clientMessageId),
          eq(uploadSession.position, dto.position),
        ),
      });
      if (winner?.partId !== dto.partId) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'upload position is already assigned to another part',
        );
      }
      return this.init(userId, dto);
    }
    await mkdir(this.tmpDir, { recursive: true });
    return this.viewOf(created);
  }

  /**
   * Buffered transport ingestion onto the SAME session state machine as the resumable transport
   * (batch-commit model). The whole file arrives in one request body: it is written wholesale to a
   * fresh staging file, hashed and recorded (record-first), then the identical batch commit runs.
   * Quota is claimed only by the transaction that inserts the session row — a retry of the same
   * part identity reuses the row and is free, exactly like resumable init.
   */
  async ingestBuffered(
    userId: number,
    dto: {
      clientMessageId: string;
      partId: string;
      position: number;
      intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
      originalName: string;
      mimeType: string;
    },
    body: Buffer,
  ): Promise<UploadSessionView> {
    if (body.length === 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'empty upload part',
      );
    }
    if (body.length > MAX_MEDIA_FILE_BYTES) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'file too large',
      );
    }
    const originalName = basename(dto.originalName).slice(0, MAX_FILE_NAME_LEN);
    if (!originalName) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid filename',
      );
    }
    let session = await this.database.db.query.uploadSession.findFirst({
      where: and(
        eq(uploadSession.clientMessageId, dto.clientMessageId),
        eq(uploadSession.partId, dto.partId),
      ),
    });
    if (
      session &&
      (session.status === 'COMPLETING' || session.status === 'COMPLETED') &&
      session.result
    ) {
      // The stage may already have been consumed by a previous commit attempt. A recorded result is
      // sufficient to resume the batch commit without requiring PendingMedia to still exist.
      await this.tryCommitBatch(dto.clientMessageId, userId);
      return this.viewOf(await this.owned(userId, session.uploadId));
    }
    const stage = await this.requireStageForPart(userId, dto);
    if (!session) {
      const created = await this.database.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(uploadSession)
          .values({
            clientMessageId: dto.clientMessageId,
            partId: dto.partId,
            position: dto.position,
            partIntent: dto.intent,
            creatorId: userId,
            contentType: stage.contentType,
            originalName,
            mimeType: dto.mimeType || 'application/octet-stream',
            totalBytes: BigInt(body.length),
          })
          .onConflictDoNothing()
          .returning();
        if (!row) return null;
        await this.quota.preCheckFile(userId, 1, BigInt(body.length), tx);
        await this.quota.tickLax(userId, 'files', tx);
        await this.quota.tickFileBytes(userId, BigInt(body.length), tx);
        return row;
      });
      if (!created) {
        const winner = await this.database.db.query.uploadSession.findFirst({
          where: and(
            eq(uploadSession.clientMessageId, dto.clientMessageId),
            eq(uploadSession.position, dto.position),
          ),
        });
        if (winner?.partId !== dto.partId) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'upload position is already assigned to another part',
          );
        }
        return this.ingestBuffered(userId, dto, body);
      }
      session = created;
    }
    return this.exclusive(session.uploadId, async () => {
      let current = await this.owned(userId, session!.uploadId);
      if (
        current.creatorId !== userId ||
        current.position !== dto.position ||
        current.partIntent !== dto.intent ||
        current.originalName !== originalName ||
        current.mimeType !== (dto.mimeType || 'application/octet-stream') ||
        current.totalBytes !== BigInt(body.length)
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'upload metadata does not match the existing session',
        );
      }
      const stored = current.result as {
        payload?: OutboundFilePayload;
      } | null;
      if (
        stored?.payload &&
        (current.status === 'COMPLETING' || current.status === 'COMPLETED')
      ) {
        // Idempotent retry: the part is already recorded (and possibly committed).
        await this.tryCommitBatch(dto.clientMessageId, userId);
        return this.viewOf(await this.owned(userId, session!.uploadId));
      }
      if (current.status === 'ABORTED') {
        current = await this.resetForRetry(current);
      }
      // UPLOADING: a fresh row, or a stale resumable attempt — the buffered body is authoritative
      // and is written wholesale over the staging file.
      const path = this.partPath(current.tmpKey);
      await mkdir(this.tmpDir, { recursive: true });
      await writeFile(path, body);
      await this.writeSidecar(current.tmpKey, BigInt(body.length));
      const resolved = await this.upload.resolveStagedPart(
        path,
        dto.intent,
        originalName,
        dto.mimeType,
      );
      if (resolved.overrideContentType !== undefined) {
        await this.messages.updateStagedContentType(
          dto.clientMessageId,
          userId,
          resolved.overrideContentType,
        );
      }
      if (this.upload.casShardExists(resolved.digest)) {
        await this.discardStaging(current.tmpKey);
      }
      const [updated] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'COMPLETING',
          digest: resolved.digest,
          result: {
            payload: resolved.payload,
            ...(resolved.overrideContentType
              ? { overrideContentType: resolved.overrideContentType }
              : {}),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, current.id),
            eq(uploadSession.status, 'UPLOADING'),
          ),
        )
        .returning();
      if (!updated) return this.invalid('upload aborted');
      await this.tryCommitBatch(dto.clientMessageId, userId);
      return this.viewOf(await this.owned(userId, session!.uploadId));
    });
  }

  /** Shared stage validation for one upload part (both transports): the staged send must be pending,
   *  authored by the caller, and the part must match the staged message's shape — single-file types
   *  take position 0 with the message type equal to the intent; GALLERY takes any position below
   *  fileCnt. */
  private async requireStageForPart(
    userId: number,
    part: {
      clientMessageId: string;
      position: number;
      intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
    },
  ) {
    const stageRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, part.clientMessageId),
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

  async status(userId: number, uploadId: string) {
    return this.viewOf(await this.owned(userId, uploadId));
  }

  async append(
    userId: number,
    uploadId: string,
    contentRange: string | undefined,
    body: Buffer,
  ) {
    return this.exclusive(uploadId, async () => {
      const session = await this.owned(userId, uploadId);
      if (session.status === 'ABORTED') return this.invalid('upload aborted');
      if (session.status !== 'UPLOADING') return this.viewOf(session);
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
      // No database write per chunk: bytes land, then the sidecar is atomically rewritten. A crash
      // between the two leaves the file longer than the committed offset — the next align truncates
      // back and the client re-sends one chunk. The advisory lock serializes same-upload writers
      // across instances, so the sidecar read-modify-write is race-free.
      await appendFile(this.partPath(session.tmpKey), body, { flag: 'a' });
      await this.writeSidecar(session.tmpKey, offset + BigInt(body.length));
      return this.viewOf(session);
    });
  }

  async complete(userId: number, uploadId: string) {
    return this.exclusive(uploadId, async () => {
      let session = await this.owned(userId, uploadId);
      if (session.status === 'COMPLETED') return this.viewOf(session);
      if (session.status === 'ABORTED') return this.invalid('upload aborted');
      const offset = await this.readSidecarOffset(session);
      if (offset !== session.totalBytes) {
        return this.invalid('upload is incomplete');
      }
      const path = this.partPath(session.tmpKey);
      const actual = await stat(path)
        .then((s) => s.size)
        .catch(() => -1);
      if (BigInt(actual) !== session.totalBytes) {
        return this.invalid('temporary file size mismatch');
      }
      let stored = session.result as {
        payload?: OutboundFilePayload;
        overrideContentType?: ContentType;
      } | null;
      if (!stored || !stored.payload) {
        // Record-first: hash + resolve the staged bytes and durably record digest/result. The CAS
        // shard tree is NOT touched here — landing happens at the batch barrier.
        const resolved = await this.upload.resolveStagedPart(
          path,
          session.partIntent as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
          session.originalName,
          session.mimeType,
        );
        if (resolved.overrideContentType !== undefined) {
          await this.messages.updateStagedContentType(
            session.clientMessageId,
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
        // Dedup fast path: identical bytes already in the shard tree — the staging file is
        // immediately droppable; the batch commit's move phase will skip this digest.
        if (this.upload.casShardExists(resolved.digest)) {
          await this.discardStaging(session.tmpKey);
        }
        const [updated] = await this.database.db
          .update(uploadSession)
          .set({
            status: 'COMPLETING',
            digest: resolved.digest,
            result: stored,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(uploadSession.id, session.id),
              eq(uploadSession.status, 'UPLOADING'),
            ),
          )
          .returning();
        if (!updated) {
          // Serialized on the same advisory lock as abort, so this is exotic: re-read and honor the
          // concurrent terminal transition instead of trusting the stale row.
          session = await this.owned(userId, uploadId);
          if (
            session.status !== 'COMPLETING' &&
            session.status !== 'COMPLETED'
          ) {
            return this.invalid('upload aborted');
          }
        } else {
          session = updated;
        }
      }
      // The last completed file carries the batch over the barrier: idempotent CAS landing +
      // the single commit transaction (message, assets, MediaAsset claims, fan-out).
      await this.tryCommitBatch(session.clientMessageId, userId);
      return this.viewOf(await this.owned(userId, uploadId));
    });
  }

  /**
   * Batch barrier + idempotent commit, under the per-batch (clientMessageId) advisory lock.
   * Phases: (1) barrier — every session of the staged message must be COMPLETING with a recorded
   * digest+result; (2) move — land every staged part into the CAS shard tree, idempotently, and
   * REQUIRE the shard to exist on disk (a part whose bytes vanished fails that part instead of
   * committing a database claim for bytes that are not on disk); (3) the single database
   * transaction via MessageService.commitOutboundBatch; (4) finalize sessions + drop staging.
   * Every phase is a no-op when already done, so a crash anywhere re-converges on re-entry.
   */
  private async tryCommitBatch(
    clientMessageId: string,
    userId: number,
  ): Promise<{
    message: PublicMessage;
    newlyPromoted: boolean;
  } | null> {
    return this.batchExclusive(clientMessageId, async () => {
      const stageRow = await this.database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      });
      const sessions = await this.database.db
        .select()
        .from(uploadSession)
        .where(eq(uploadSession.clientMessageId, clientMessageId))
        .orderBy(asc(uploadSession.position));
      if (!stageRow) {
        // Stage already consumed — a crash between the commit transaction and the session
        // finalization leaves COMPLETING rows behind. Their bytes were already moved; self-heal.
        if (sessions.some((s) => s.status === 'COMPLETING')) {
          await this.finalizeCommittedSessions(clientMessageId);
        }
        return null;
      }
      const stage = requireOutboundPendingMedia(stageRow);
      if (stage.status !== 'pending') return null; // failed stage — retry/discard is the client's call
      if (
        sessions.length === 0 ||
        sessions.some(
          (s) => s.status !== 'COMPLETING' && s.status !== 'COMPLETED',
        ) ||
        sessions.length !== stage.fileCnt
      ) {
        return null; // barrier not met (or an earlier finalize already raced ahead)
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
      if (items.some((item) => !item.digest || !item.payload)) return null;
      for (const item of items) {
        if (this.upload.casShardExists(item.digest)) continue; // dedup or a prior crash's landing
        try {
          await this.upload.landStagedPart(
            this.partPath(item.session.tmpKey),
            item.digest,
          );
        } catch {
          // Never commit a liveness claim for missing bytes: fail this part and the staged send.
          // The sender still holds the original file, so a retry re-drives everything idempotently.
          await this.abortSession(item.session.id, 'staged part lost');

          await this.messages.failStaged(
            userId,
            clientMessageId,
            'staged part lost',
          );
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'staged part lost, retry the upload',
          );
        }
      }
      const committed = await this.messages.commitOutboundBatch(
        clientMessageId,
        userId,
        items.map((item) => ({
          digest: item.digest,
          payload: item.payload,
        })),
      );
      if (committed) await this.finalizeCommittedSessions(clientMessageId);
      return committed;
    });
  }

  /** Flip a committed batch's sessions to COMPLETED and drop their staging artifacts. Idempotent. */
  private async finalizeCommittedSessions(clientMessageId: string) {
    const rows = await this.database.db
      .update(uploadSession)
      .set({
        status: 'COMPLETED',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(uploadSession.clientMessageId, clientMessageId),
          inArray(uploadSession.status, ['COMPLETING']),
        ),
      )
      .returning({ tmpKey: uploadSession.tmpKey });
    for (const row of rows) await this.discardStaging(row.tmpKey);
  }

  /** Terminate one session (admin abort / staged part lost) and drop its staging artifacts. */
  private async abortSession(id: bigint, reason: string) {
    const [row] = await this.database.db
      .update(uploadSession)
      .set({
        status: 'ABORTED',
        errorReason: reason.slice(0, 255),
        abortedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(uploadSession.id, id),
          inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']),
        ),
      )
      .returning({ tmpKey: uploadSession.tmpKey });
    if (row) await this.discardStaging(row.tmpKey);
  }

  /** Restart an aborted session under its stable identity: fresh staging file, cleared outcome. */
  private async resetForRetry(
    session: typeof uploadSession.$inferSelect,
  ): Promise<typeof uploadSession.$inferSelect> {
    const [reset] = await this.database.db
      .update(uploadSession)
      .set({
        status: 'UPLOADING',
        tmpKey: randomUUID(),
        digest: null,
        result: null,
        errorReason: null,
        abortedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(uploadSession.id, session.id),
          eq(uploadSession.status, 'ABORTED'),
        ),
      )
      .returning();
    await this.discardStaging(session.tmpKey);
    return reset ?? session;
  }

  async cancel(userId: number, uploadId: string) {
    return this.exclusive(uploadId, async () => {
      const session = await this.owned(userId, uploadId);
      if (session.status === 'COMPLETED') {
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'completed upload cannot be cancelled',
          409,
        );
      }
      await this.abortSession(session.id, 'cancelled by user');
      await this.batchExclusive(session.clientMessageId, () =>
        this.messages.discardStaged(userId, session.clientMessageId),
      );
      return this.viewOf({
        ...session,
        status: 'ABORTED',
        errorReason: 'cancelled by user',
        abortedAt: new Date(),
      });
    });
  }

  /** Cancel every uncommitted part in a staged media batch. */
  async cancelBatch(userId: number, clientMessageId: string) {
    const cleanup: Array<{ uploadId: string; tmpKey: string }> = [];
    try {
      return await this.batchExclusive(clientMessageId, async () => {
        const sessions = await this.database.db
          .select()
          .from(uploadSession)
          .where(eq(uploadSession.clientMessageId, clientMessageId));
        const owned = sessions.filter(
          (session) => session.creatorId === userId,
        );
        if (owned.length === 0) {
          const discardedStage = await this.messages.discardStaged(
            userId,
            clientMessageId,
          );
          if (!discardedStage) {
            throw new BusinessException(
              BusinessCode.NOT_FOUND,
              'upload batch not found',
              404,
            );
          }
          return { clientMessageId, cancelled: 0 };
        }
        if (owned.some((session) => session.status === 'COMPLETED')) {
          throw new BusinessException(
            BusinessCode.ALREADY_EXISTS,
            'completed upload batch cannot be cancelled',
            409,
          );
        }
        cleanup.push(
          ...owned.map(({ uploadId, tmpKey }) => ({ uploadId, tmpKey })),
        );
        await this.database.db
          .update(uploadSession)
          .set({
            status: 'ABORTED',
            errorReason: 'cancelled by user',
            abortedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(
                uploadSession.id,
                owned.map((session) => session.id),
              ),
              inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']),
            ),
          );
        await this.messages.discardStaged(userId, clientMessageId);
        return { clientMessageId, cancelled: owned.length };
      });
    } finally {
      // Wait out any in-flight append before the final unlink. New append calls observe ABORTED.
      for (const item of cleanup) {
        await this.exclusive(item.uploadId, () =>
          this.discardStaging(item.tmpKey),
        );
      }
    }
  }

  /** Commit only the parts that have already reached COMPLETING, discarding unfinished parts. */
  async sendCompleted(userId: number, clientMessageId: string) {
    const cleanup: Array<{ uploadId: string; tmpKey: string }> = [];
    try {
      return await this.batchExclusive(clientMessageId, async () => {
        const sessions = await this.database.db
          .select()
          .from(uploadSession)
          .where(eq(uploadSession.clientMessageId, clientMessageId))
          .orderBy(asc(uploadSession.position));
        const owned = sessions.filter(
          (session) => session.creatorId === userId,
        );
        if (owned.length === 0) {
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'upload batch not found',
            404,
          );
        }
        if (
          owned.some((session) => session.status === 'COMPLETED') &&
          (await this.messages.findByClientMessageId(clientMessageId))
        ) {
          return { clientMessageId, sent: true, completed: owned.length };
        }
        const stageRow = await this.database.db.query.pendingMedia.findFirst({
          where: eq(pendingMedia.clientMessageId, clientMessageId),
        });
        const stage = stageRow ? requireOutboundPendingMedia(stageRow) : undefined;
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
        const completed = owned.filter(
          (session) =>
            session.status === 'COMPLETING' && session.digest && session.result,
        );
        const discarded = owned.filter((item) => !completed.includes(item));
        cleanup.push(
          ...discarded.map(({ uploadId, tmpKey }) => ({ uploadId, tmpKey })),
        );
        if (discarded.length > 0) {
          await this.database.db
            .update(uploadSession)
            .set({
              status: 'ABORTED',
              errorReason: 'discarded unfinished upload',
              abortedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                inArray(
                  uploadSession.id,
                  discarded.map((item) => item.id),
                ),
                inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']),
              ),
            );
          // Remove discarded rows before compacting positions. UploadSession has a unique
          // (clientMessageId, position) key, so aborted siblings cannot collide with compaction.
          await this.database.db.delete(uploadSession).where(
            inArray(
              uploadSession.id,
              discarded.map((item) => item.id),
            ),
          );
        }
        if (completed.length === 0) {
          await this.messages.discardStaged(userId, clientMessageId);
          return { clientMessageId, sent: false, completed: 0 };
        }
        // Preserve original order while compacting retained positions to 0..N-1.
        for (const [position, session] of completed.entries()) {
          if (session.position !== position) {
            await this.database.db
              .update(uploadSession)
              .set({ position, updatedAt: new Date() })
              .where(eq(uploadSession.id, session.id));
          }
        }
        await this.database.db
          .update(pendingMedia)
          .set({ fileCnt: completed.length, updatedAt: new Date() })
          .where(eq(pendingMedia.id, stage.id));
        const committed = await this.commitSelectedBatch(
          clientMessageId,
          userId,
          completed,
        );
        return {
          clientMessageId,
          sent: committed !== null,
          completed: completed.length,
        };
      });
    } finally {
      for (const item of cleanup) {
        await this.exclusive(item.uploadId, () =>
          this.discardStaging(item.tmpKey),
        );
      }
    }
  }

  private async commitSelectedBatch(
    clientMessageId: string,
    userId: number,
    sessions: Array<typeof uploadSession.$inferSelect>,
  ) {
    for (const session of sessions) {
      if (!this.upload.casShardExists(session.digest!)) {
        await this.upload.landStagedPart(
          this.partPath(session.tmpKey),
          session.digest!,
        );
      }
    }
    const committed = await this.messages.commitOutboundBatch(
      clientMessageId,
      userId,
      sessions.map((session) => ({
        digest: session.digest!,
        payload: (session.result as { payload: OutboundFilePayload }).payload,
      })),
    );
    if (committed) await this.finalizeCommittedSessions(clientMessageId);
    return committed;
  }

  async listForAdmin() {
    const rows = await this.database.db
      .select()
      .from(uploadSession)
      .where(inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']))
      .orderBy(desc(uploadSession.createdAt))
      .limit(200);
    return Promise.all(
      rows.map(async (row) => ({
        ...(await this.viewOf(row)),
        creatorId: row.creatorId,
        contentType: row.contentType,
        updatedAt: row.updatedAt,
      })),
    );
  }

  async abortForAdmin(
    uploadId: string,
    reason = 'terminated by administrator',
  ) {
    return this.exclusive(uploadId, async () => {
      const session = await this.database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.uploadId, uploadId),
      });
      if (!session) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'upload not found',
          404,
        );
      }
      if (session.status === 'COMPLETED') {
        return this.invalid('completed upload cannot be aborted');
      }
      const [aborted] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'ABORTED',
          errorReason: reason.slice(0, 255),
          abortedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(uploadSession.id, session.id),
            inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']),
          ),
        )
        .returning();
      await this.discardStaging(session.tmpKey);
      await this.messages.failStaged(
        session.creatorId,
        session.clientMessageId,
        reason,
      );
      return this.viewOf(aborted ?? session);
    });
  }

  private async owned(userId: number, uploadId: string) {
    const session = await this.database.db.query.uploadSession.findFirst({
      where: and(
        eq(uploadSession.uploadId, uploadId),
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
    const offset =
      session.status === 'COMPLETED' || session.status === 'COMPLETING'
        ? session.totalBytes
        : session.status === 'ABORTED'
          ? 0n
          : await this.readSidecarOffset(session);
    return {
      uploadId: session.uploadId,
      clientMessageId: session.clientMessageId,
      partId: session.partId,
      position: session.position,
      originalName: session.originalName,
      mimeType: session.mimeType,
      totalBytes: Number(session.totalBytes),
      offset: Number(offset),
      chunkSize: RESUMABLE_CHUNK_SIZE,
      status: session.status,
      ...(stored?.payload ? { result: stored.payload } : {}),
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

  /** Authoritative committed offset. A missing/corrupt sidecar means zero: the safe direction is
   *  re-sending chunks (alignPart truncates any uncommitted surplus bytes). */
  private async readSidecarOffset(
    session: typeof uploadSession.$inferSelect,
  ): Promise<bigint> {
    try {
      const meta = JSON.parse(
        await readFile(this.sidecarPath(session.tmpKey), 'utf8'),
      ) as { version?: number; offset?: number };
      if (
        meta.version !== 1 ||
        !Number.isSafeInteger(meta.offset) ||
        meta.offset! < 0
      ) {
        return 0n;
      }
      const offset = BigInt(meta.offset!);
      return offset > session.totalBytes ? 0n : offset;
    } catch {
      return 0n;
    }
  }

  /** Atomically rewrite the sidecar AFTER the bytes landed (write tmp + rename). */
  private async writeSidecar(tmpKey: string, offset: bigint) {
    const tmp = `${this.sidecarPath(tmpKey)}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({ version: 1, offset: Number(offset) }),
    );
    await rename(tmp, this.sidecarPath(tmpKey));
  }

  /** Align the staged file to the sidecar offset. Longer → truncate the uncommitted surplus
   *  (crash between append and sidecar rewrite); shorter → external corruption, refuse loudly. */
  private async alignPart(
    session: typeof uploadSession.$inferSelect,
  ): Promise<bigint> {
    const offset = await this.readSidecarOffset(session);
    const path = this.partPath(session.tmpKey);
    const actual = await stat(path)
      .then((s) => s.size)
      .catch(() => -1);
    if (actual < 0) {
      if (offset === 0n) return 0n;
      throw new Error(
        'resumable temporary file is shorter than committed offset',
      );
    }
    if (BigInt(actual) > offset) {
      await truncate(path, Number(offset));
    } else if (BigInt(actual) < offset) {
      throw new Error(
        'resumable temporary file is shorter than committed offset',
      );
    }
    return offset;
  }

  /** Best-effort removal of both staging artifacts for a tmpKey. */
  private async discardStaging(tmpKey: string) {
    await Promise.all([
      unlink(this.partPath(tmpKey)).catch(() => undefined),
      unlink(this.sidecarPath(tmpKey)).catch(() => undefined),
    ]);
  }

  private async exclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withAdvisoryLock(`upload:${key}`, operation);
  }

  private async batchExclusive<T>(
    clientMessageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withAdvisoryLock(`batch:${clientMessageId}`, operation);
  }

  private async withAdvisoryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      // The local queue avoids duplicate work in one process; the advisory transaction lock extends
      // the same exclusion across horizontally-scaled API instances sharing the temp volume.
      return await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        return operation();
      });
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
