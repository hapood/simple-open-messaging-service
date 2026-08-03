import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appendFile, mkdir, stat, truncate, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { pendingMedia, uploadSession } from '../database/schema.js';
import type { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { MessageService } from '../message/message.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import {
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LEN,
  MAX_VIDEO_BYTES,
} from './file-content.js';
import { UploadService } from './upload.service.js';

export const RESUMABLE_CHUNK_SIZE = 4 * 1024 * 1024;

interface UploadSessionView {
  uploadId: string;
  clientMessageId: string;
  originalName: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  chunkSize: number;
  status: 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'ABORTED';
  result?: Record<string, unknown>;
}

@Injectable()
export class ResumableUploadService {
  private readonly tmpDir = join(process.cwd(), 'data', 'resumable');
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly messages: MessageService,
    private readonly fanout: MessageFanoutService,
    private readonly quota: UserQuotaService,
  ) {}

  async init(
    userId: number,
    dto: InitResumableUploadDto,
  ): Promise<UploadSessionView> {
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.clientMessageId, dto.clientMessageId),
        eq(pendingMedia.creatorId, userId),
      ),
    });
    if (!stage || stage.status !== 'pending') {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'media send is not pending',
      );
    }
    if (!['IMAGE', 'FILE', 'VIDEO', 'AUDIO'].includes(stage.contentType)) {
      return this.invalid('invalid media content type');
    }
    const limit =
      stage.contentType === 'IMAGE'
        ? UploadService.MAX_IMAGE_BYTES
        : stage.contentType === 'VIDEO'
          ? MAX_VIDEO_BYTES
          : stage.contentType === 'AUDIO'
            ? MAX_AUDIO_BYTES
            : MAX_FILE_BYTES;
    if (dto.totalBytes > limit) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'file too large',
      );
    }
    await this.quota.assertWithinByteCap(
      userId,
      stage.contentType === 'IMAGE' ? 'images' : 'largeFiles',
      dto.totalBytes,
    );
    const originalName = basename(dto.originalName).slice(0, MAX_FILE_NAME_LEN);
    if (!originalName) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid filename',
      );
    }
    const existing = await this.database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.clientMessageId, dto.clientMessageId),
    });
    if (existing) {
      if (
        existing.creatorId !== userId ||
        existing.contentType !== stage.contentType ||
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
    const [created] = await this.database.db
      .insert(uploadSession)
      .values({
        clientMessageId: dto.clientMessageId,
        creatorId: userId,
        contentType: stage.contentType,
        originalName,
        mimeType: dto.mimeType || 'application/octet-stream',
        totalBytes: BigInt(dto.totalBytes),
      })
      .onConflictDoNothing({ target: uploadSession.clientMessageId })
      .returning();
    if (!created) return this.init(userId, dto);
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
      let stored = session.result as Record<string, unknown> | null;
      if (!stored) {
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
          session.contentType as 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO',
          session.originalName,
          session.mimeType,
        );
        stored = {
          payload: published.payload,
          ...(published.contentTypeOverride
            ? { contentTypeOverride: published.contentTypeOverride }
            : {}),
        };
        [session] = await this.database.db
          .update(uploadSession)
          .set({
            status: 'COMPLETING',
            digest: published.digest,
            result: stored,
            updatedAt: new Date(),
          })
          .where(eq(uploadSession.id, session.id))
          .returning();
        await this.messages.linkStagedDigest(
          session.clientMessageId,
          published.digest,
          userId,
        );
      }
      const payload = stored.payload as Record<string, unknown>;
      const promoted = await this.messages.promoteStaged(
        session.clientMessageId,
        payload,
        userId,
        stored.contentTypeOverride as 'FILE' | undefined,
      );
      if (!promoted) throw new Error('media stage could not be promoted');
      void this.fanout.dispatch(promoted);
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
      payload?: Record<string, unknown>;
    } | null;
    return {
      uploadId: session.uploadId,
      clientMessageId: session.clientMessageId,
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
