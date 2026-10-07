import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appendFile, mkdir, stat, truncate, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { pendingMedia, uploadSession } from '../database/schema.js';
import type { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import { MessageService } from '../message/message.service.js';
import { requireOutboundPendingMedia } from '../message/pending-media-row.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import {
  MAX_FILE_NAME_LEN,
  MAX_VIDEO_BYTES,
  type OutboundFilePayload,
} from './file-content.js';
import { ContentType } from '../database/enums.js';
import { dataDirectory } from '../common/data-directory.js';
import { UploadService } from './upload.service.js';

export const RESUMABLE_CHUNK_SIZE = 4 * 1024 * 1024;

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
    const stageRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, dto.clientMessageId),
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
      stage.fileCnt === 1 ? dto.intent : ContentType.GALLERY;
    if (
      stage.contentType !== expectedMessageType ||
      dto.position >= stage.fileCnt ||
      (stage.fileCnt === 1 && dto.position !== 0)
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'upload part does not match the staged message',
      );
    }
    // Phase 7 type-agnostic: accept any staged media contentType (IMAGE/FILE/VIDEO/AUDIO/GALLERY).
    // The per-type size caps are dropped in favor of the global multipart ceiling (MAX_VIDEO_BYTES)
    // plus the per-account byte quota asserted below.
    if (dto.totalBytes > MAX_VIDEO_BYTES) {
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
      return this.view(existing);
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
    return this.view(created);
  }

  async status(userId: number, uploadId: string) {
    return this.view(await this.owned(userId, uploadId));
  }

  async append(
    userId: number,
    uploadId: string,
    contentRange: string | undefined,
    body: Buffer,
  ) {
    return this.exclusive(uploadId, async () => {
      const session = await this.owned(userId, uploadId);
      if (session.status !== 'UPLOADING') return this.view(session);
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
      if (start < session.receivedBytes && end < session.receivedBytes) {
        return this.view(session);
      }
      if (start !== session.receivedBytes) {
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'upload offset mismatch',
          409,
          { offset: Number(session.receivedBytes) },
        );
      }
      await mkdir(this.tmpDir, { recursive: true });
      const path = this.tmpPath(session.tmpKey);
      const actual = await stat(path)
        .then((s) => s.size)
        .catch(() => 0);
      if (BigInt(actual) > session.receivedBytes) {
        await truncate(path, Number(session.receivedBytes));
      } else if (BigInt(actual) < session.receivedBytes) {
        throw new Error(
          'resumable temporary file is shorter than committed offset',
        );
      }
      await appendFile(path, body, { flag: 'a' });
      const nextOffset = session.receivedBytes + BigInt(body.length);
      const [updated] = await this.database.db
        .update(uploadSession)
        .set({ receivedBytes: nextOffset, updatedAt: new Date() })
        .where(
          and(
            eq(uploadSession.id, session.id),
            eq(uploadSession.status, 'UPLOADING'),
            eq(uploadSession.receivedBytes, session.receivedBytes),
          ),
        )
        .returning();
      if (!updated) {
        await truncate(path, Number(session.receivedBytes));
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'upload offset changed',
          409,
          { offset: Number(session.receivedBytes) },
        );
      }
      return this.view(updated);
    });
  }

  async complete(userId: number, uploadId: string) {
    return this.exclusive(uploadId, async () => {
      let session = await this.owned(userId, uploadId);
      if (session.status === 'COMPLETED') return this.view(session);
      if (session.status === 'ABORTED') return this.invalid('upload aborted');
      if (session.receivedBytes !== session.totalBytes) {
        return this.invalid('upload is incomplete');
      }
      let stored = session.result as {
        payload?: OutboundFilePayload;
        overrideContentType?: ContentType;
      } | null;
      if (!stored || !stored.payload) {
        const path = this.tmpPath(session.tmpKey);
        const actual = await stat(path);
        if (BigInt(actual.size) !== session.totalBytes) {
          return this.invalid('temporary file size mismatch');
        }
        await this.database.db
          .update(uploadSession)
          .set({ status: 'COMPLETING', updatedAt: new Date() })
          .where(eq(uploadSession.id, session.id));
        const published = await this.upload.publishResumable(
          path,
          session.partIntent as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
          session.originalName,
          session.mimeType,
        );
        stored = {
          payload: published.payload,
          ...(published.overrideContentType
            ? { overrideContentType: published.overrideContentType }
            : {}),
        };
        [session] = await this.database.db
          .update(uploadSession)
          .set({
            status: 'COMPLETING',
            digest: published.payload.digest,
            result: stored,
            updatedAt: new Date(),
          })
          .where(eq(uploadSession.id, session.id))
          .returning();
      }
      // Phase 7 barrier promote: upsert the file's FileSyncProgress(SUCCEEDED) row + attempt the batch
      // promote. markOutboundFileSucceeded returns the committed Message iff THIS call newly committed
      // it (the win-guard makes a concurrent/race re-complete a no-op) — only then fire the fan-out.
      await this.messages.markOutboundFileSucceeded(
        session.clientMessageId,
        session.partId,
        session.position,
        stored.payload!.digest,
        stored.payload!,
        userId,
        stored.overrideContentType,
      );
      const [completed] = await this.database.db
        .update(uploadSession)
        .set({
          status: 'COMPLETED',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(uploadSession.id, session.id))
        .returning();
      await unlink(this.tmpPath(session.tmpKey)).catch(() => undefined);
      return this.view(completed);
    });
  }

  async listForAdmin() {
    const rows = await this.database.db
      .select()
      .from(uploadSession)
      .where(inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']))
      .orderBy(desc(uploadSession.updatedAt))
      .limit(200);
    return rows.map((row) => ({
      ...this.view(row),
      creatorId: row.creatorId,
      contentType: row.contentType,
      updatedAt: row.updatedAt,
    }));
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
        .where(eq(uploadSession.id, session.id))
        .returning();
      await unlink(this.tmpPath(session.tmpKey)).catch(() => undefined);
      await this.messages.failStaged(
        session.creatorId,
        session.clientMessageId,
        reason,
      );
      return this.view(aborted);
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

  private view(session: typeof uploadSession.$inferSelect): UploadSessionView {
    const stored = session.result as {
      payload?: OutboundFilePayload;
    } | null;
    return {
      uploadId: session.uploadId,
      clientMessageId: session.clientMessageId,
      partId: session.partId,
      position: session.position,
      originalName: session.originalName,
      mimeType: session.mimeType,
      totalBytes: Number(session.totalBytes),
      offset: Number(session.receivedBytes),
      chunkSize: RESUMABLE_CHUNK_SIZE,
      status: session.status,
      ...(stored?.payload ? { result: stored.payload } : {}),
    };
  }

  private invalid(message: string): never {
    throw new BusinessException(BusinessCode.VALIDATION_FAILED, message);
  }

  private tmpPath(tmpKey: string) {
    return join(this.tmpDir, `${tmpKey}.part`);
  }

  private async exclusive<T>(
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
      // the same uploadId exclusion across horizontally-scaled API instances sharing the temp volume.
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
