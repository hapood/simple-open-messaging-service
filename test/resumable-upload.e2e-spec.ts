import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UploadService } from '../src/upload/upload.service';
import { UploadRecoveryService } from '../src/upload/upload-recovery.service';
import { TemporaryGarbageService } from '../src/media/temporary-garbage.service';
import { MediaMetadataService } from '../src/upload/media-metadata.service';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  pendingMedia,
  uploadSession,
  mediaAsset,
  message,
  messageThread,
  account as user,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums';
import { MessageService } from '../src/message/message.service';
import { ResumableUploadService } from '../src/upload/resumable-upload.service';
import { eq, inArray } from 'drizzle-orm';
import { seedAcceptedRelationship, seedSession } from './seed';
import request from 'supertest';
import { dataDirectory } from '../src/common/data-directory';

describe('sequential resumable uploads', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let messages: MessageService;
  let uploads: ResumableUploadService;
  let userId: number;
  let peerId: number;
  let threadId: number;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = fixture.createNestApplication(adapter);
    await configureApp(app as never, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    messages = app.get(MessageService);
    uploads = app.get(ResumableUploadService);
    const now = new Date();
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account: `resume-${randomUUID().slice(0, 8)}`,
        hashPwd: 'x',
        updatedAt: now,
      })
      .returning({ id: user.id });
    userId = createdUser.id;
    const [peer] = await database.db
      .insert(user)
      .values({
        account: `resume-peer-${randomUUID().slice(0, 8)}`,
        hashPwd: 'x',
        updatedAt: now,
      })
      .returning({ id: user.id });
    peerId = peer.id;
    const [createdThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning({ id: messageThread.id });
    threadId = createdThread.id;
    await seedAcceptedRelationship(database.db, userId, peer.id, threadId);
  });

  afterAll(async () => app.close());

  it('continues pending tasks directly but requires explicit retry after stopping, using the same owned database ID', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const initialized = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'resume.txt',
      mimeType: 'text/plain',
      totalBytes: 6,
    });
    expect(initialized.id).toMatch(/^[1-9][0-9]*$/);
    expect(initialized).not.toHaveProperty('uploadId');
    const task = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(initialized.id)),
    });
    expect(task?.creatorId).toBe(userId);
    for (const operation of [
      () => uploads.status(peerId, initialized.id),
      () =>
        uploads.append(
          peerId,
          initialized.id,
          'bytes 0-1/6',
          Buffer.from('ab'),
        ),
      () => uploads.complete(peerId, initialized.id),
      () => uploads.retry(peerId, initialized.id),
      () => uploads.cancel(peerId, initialized.id),
    ]) {
      await expect(operation()).rejects.toThrow('upload not found');
    }
    await uploads.append(
      userId,
      initialized.id,
      'bytes 0-1/6',
      Buffer.from('ab'),
    );
    expect(await uploads.status(userId, initialized.id)).toMatchObject({
      id: initialized.id,
      status: 'PENDING',
      phase: 'UPLOADING',
      offset: 2,
    });
    // A still-pending task needs no reactivation between chunks.
    await uploads.append(
      userId,
      initialized.id,
      'bytes 2-3/6',
      Buffer.from('cd'),
    );
    expect(await uploads.stop(userId, initialized.id)).toMatchObject({
      id: initialized.id,
      status: 'FAILED',
      offset: 4,
    });
    await expect(
      uploads.append(userId, initialized.id, 'bytes 4-5/6', Buffer.from('ef')),
    ).rejects.toThrow('upload requires explicit retry');
    expect(await uploads.retry(userId, initialized.id)).toMatchObject({
      id: initialized.id,
      status: 'PENDING',
      phase: 'UPLOADING',
      offset: 4,
    });
    await uploads.append(
      userId,
      initialized.id,
      'bytes 4-5/6',
      Buffer.from('ef'),
    );
    expect(await uploads.complete(userId, initialized.id)).toMatchObject({
      id: initialized.id,
      status: 'COMPLETED',
      offset: 6,
    });
  });

  it('validates task IDs and authorizes the owner before HTTP chunk reception', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const ownerToken = await seedSession(app, userId);
    const otherToken = await seedSession(app, peerId);
    const server = app.getHttpServer();
    const initialized = await request(server)
      .post('/api/v1/uploads/resumable/init')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        clientMessageId,
        partId: randomUUID(),
        position: 0,
        intent: 'FILE',
        originalName: 'http.txt',
        mimeType: 'text/plain',
        totalBytes: 2,
      });
    expect(initialized.body.code).toBe(0);
    const taskId = initialized.body.data.id as string;
    expect(taskId).toMatch(/^[1-9][0-9]*$/);
    const chunk = (id: string, token = ownerToken) =>
      request(server)
        .put(`/api/v1/uploads/resumable/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/octet-stream')
        .set('Content-Range', 'bytes 0-1/2')
        .send(Buffer.from('ok'));
    for (const invalidId of [randomUUID(), '01', '-1', '9223372036854775808']) {
      expect((await chunk(invalidId)).body.message).toBe(
        'invalid upload task id',
      );
      const status = await request(server)
        .get(`/api/v1/uploads/resumable/${invalidId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(status.body.message).toBe('invalid upload task id');
    }
    expect((await chunk(taskId, otherToken)).status).toBe(404);
    expect((await uploads.status(userId, taskId)).offset).toBe(0);
    expect((await chunk(taskId)).body.data).toMatchObject({
      id: taskId,
      offset: 2,
    });
    const completed = await request(server)
      .post(`/api/v1/uploads/resumable/${taskId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(completed.body.data).toMatchObject({
      id: taskId,
      status: 'COMPLETED',
    });
  });

  it('cancels active processing through garbage deletion and retries the retained task from zero', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from(`garbage-cancel-${randomUUID()}`);
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const initialized = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'cancel.bin',
      mimeType: 'application/octet-stream',
      totalBytes: bytes.length,
    });
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const row = (await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(initialized.id)),
    }))!;
    const garbage = app.get(TemporaryGarbageService);
    const candidate = (await garbage.scan()).list.find(
      (entry) => entry.name === row.tmpKey,
    )!;
    expect(candidate).toMatchObject({ kind: 'upload', canDelete: true });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: AbortSignal;
    const storage = app.get(UploadService);
    const spy = vi
      .spyOn(storage, 'resolveStagedPart')
      .mockImplementationOnce(
        async (_path, _intent, _name, _mime, physical) => {
          signal = physical;
          entered();
          await gate;
          physical.throwIfAborted();
          throw new Error('cancelled processor must not publish');
        },
      );
    const completing = expect(
      uploads.complete(userId, initialized.id),
    ).rejects.toThrow('cancelled');
    await started;
    const deletion = garbage.clean(candidate.token);
    const deleted = expect(deletion).resolves.toEqual({ cleaned: true });
    try {
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      await expect(uploads.retry(userId, initialized.id)).rejects.toThrow(
        'execution is busy',
      );
    } finally {
      release();
      await completing;
      await deleted;
      spy.mockRestore();
    }
    expect(
      await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, row.id),
      }),
    ).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_CANCELLED',
      pendingMediaId: row.pendingMediaId,
    });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, row.pendingMediaId!),
      }),
    ).toBeDefined();
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    for (const suffix of ['.part', '.resume.json'])
      await expect(
        stat(join(dataDirectory('resumable'), row.tmpKey + suffix)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(uploads.retry(userId, initialized.id)).resolves.toMatchObject({
      status: 'PENDING',
      offset: 0,
    });
    expect(
      (await stat(join(dataDirectory('resumable'), row.tmpKey + '.part'))).size,
    ).toBe(0);
    await uploads.cancel(userId, initialized.id);
  });

  it('recovers offset zero, ignores a completed duplicate chunk and promotes once', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from('resumable upload bytes');
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const initRequest = {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE' as const,
      originalName: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.length,
    };
    const initialized = await uploads.init(userId, initRequest);
    expect(initialized.offset).toBe(0);
    expect((await uploads.init(userId, initRequest)).id).toBe(initialized.id);

    const first = bytes.subarray(0, 8);
    const afterFirst = await uploads.append(
      userId,
      initialized.id,
      `bytes 0-7/${bytes.length}`,
      first,
    );
    expect(afterFirst.offset).toBe(8);
    expect(
      (
        await uploads.append(
          userId,
          initialized.id,
          `bytes 0-7/${bytes.length}`,
          first,
        )
      ).offset,
    ).toBe(8);

    const rest = bytes.subarray(8);
    const received = await uploads.append(
      userId,
      initialized.id,
      `bytes 8-${bytes.length - 1}/${bytes.length}`,
      rest,
    );
    expect(received.offset).toBe(bytes.length);
    expect((await uploads.complete(userId, initialized.id)).status).toBe(
      'COMPLETED',
    );
    expect((await uploads.complete(userId, initialized.id)).status).toBe(
      'COMPLETED',
    );
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.clientMessageId, clientMessageId),
      }),
    ).toBeDefined();
  });

  it('commits a sequential part and idempotently completes the same session', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from('sequential upload bytes');
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const dto = {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE' as const,
      originalName: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.length,
    };
    const initialized = await uploads.init(userId, dto);
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const view = await uploads.complete(userId, initialized.id);
    expect(view.status).toBe('COMPLETED');
    expect(view.result?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(view.result?.size).toBe(bytes.length);
    // The blob landed in the CAS shard tree and its liveness row was asserted by the commit.
    const [asset] = await database.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.digest, view.result!.digest))
      .limit(1);
    expect(asset).toBeDefined();
    // Idempotent retry with the same part identity: free, same outcome, no second message.
    const again = await uploads.complete(userId, initialized.id);
    expect(again.status).toBe('COMPLETED');
    expect(again.result?.digest).toBe(view.result?.digest);
    const messages2 = await database.db.query.message.findMany({
      where: eq(message.clientMessageId, clientMessageId),
    });
    expect(messages2).toHaveLength(1);
    await expect(
      database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(initialized.id)),
      }),
    ).resolves.toMatchObject({
      pendingMediaId: null,
      messageId: messages2[0].id,
    });
    await expect(
      database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).resolves.toBeUndefined();
  });

  it('cancels one upload, deletes its artifacts, retains its stage and retries from zero', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from('cancel this upload');
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const request = {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE' as const,
      originalName: 'cancel.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.length,
    };
    const initialized = await uploads.init(userId, request);
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const session = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(initialized.id)),
    });
    const root = dataDirectory('resumable');
    const partPath = join(root, `${session!.tmpKey}.part`);
    const sidecarPath = join(root, `${session!.tmpKey}.resume.json`);
    await expect(stat(partPath)).resolves.toBeDefined();
    await expect(stat(sidecarPath)).resolves.toBeDefined();

    expect(await uploads.cancel(userId, initialized.id)).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_CANCELLED',
    });
    await expect(stat(partPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toMatchObject({ id: session!.pendingMediaId, status: 'pending' });
    await expect(
      uploads.append(
        userId,
        initialized.id,
        `bytes 0-${bytes.length - 1}/${bytes.length}`,
        bytes,
      ),
    ).rejects.toThrow('upload requires explicit retry');
    expect((await uploads.cancel(userId, initialized.id)).status).toBe(
      'FAILED',
    );
    expect(await uploads.retry(userId, initialized.id)).toMatchObject({
      offset: 0,
    });
    await expect(stat(partPath)).resolves.toMatchObject({ size: 0 });
    expect(JSON.parse(await readFile(sidecarPath, 'utf8'))).toEqual({
      offset: 0,
    });
    expect(
      (
        await database.db.query.uploadSession.findFirst({
          where: eq(uploadSession.id, BigInt(initialized.id)),
        })
      )?.tmpKey,
    ).toBe(session!.tmpKey);
  });

  it('recovers published metadata and commits message ownership with the task outcome', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'GALLERY' as never,
      clientMessageId,
      2,
    );
    const bytes = Buffer.from(`recovery-${randomUUID()}`);
    const initialized = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'recovery.bin',
      mimeType: 'application/octet-stream',
      totalBytes: bytes.length,
    });
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    expect((await uploads.complete(userId, initialized.id)).phase).toBe(
      'COMPLETING',
    );
    const row = (await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(initialized.id)),
    }))!;
    await app
      .get(UploadService)
      .landStagedPart(
        join(dataDirectory('resumable'), `${row.tmpKey}.part`),
        row.digest!,
      );
    const result = row.result as { payload: Record<string, unknown> };
    delete result.payload.localMeta;
    await database.db
      .update(uploadSession)
      .set({ result })
      .where(eq(uploadSession.id, row.id));
    const process = vi.spyOn(app.get(MediaMetadataService), 'processFile');
    try {
      expect((await uploads.sendCompleted(userId, clientMessageId)).sent).toBe(
        true,
      );
      expect(process).toHaveBeenCalledOnce();
      const asset = await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, row.digest!),
      });
      expect(asset?.meta?.kind).toBe('FILE');
      // Message ownership and task completion commit atomically; there is no separate
      // pending-task finalization window after publication.
      const committedTask = await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, row.id),
      });
      const committedMessage = await database.db.query.message.findFirst({
        where: eq(message.clientMessageId, clientMessageId),
      });
      expect(committedMessage).toBeDefined();
      expect(committedTask).toMatchObject({
        status: 'COMPLETED',
        pendingMediaId: null,
        messageId: committedMessage!.id,
        completedAt: expect.any(Date),
      });
      process.mockClear();
      await app.get(UploadRecoveryService).resume();
      expect(
        (
          await database.db.query.uploadSession.findFirst({
            where: eq(uploadSession.id, BigInt(initialized.id)),
          })
        )?.status,
      ).toBe('COMPLETED');
      expect(process).not.toHaveBeenCalled();
    } finally {
      process.mockRestore();
    }
  });

  it.each([false, true])(
    'recovers a final checkpoint without a database result (changed: %s)',
    async (changed) => {
      const clientMessageId = randomUUID();
      const bytes = Buffer.from(`final-checkpoint-${randomUUID()}`);
      await messages.stageMedia(
        userId,
        threadId,
        'FILE' as never,
        clientMessageId,
      );
      const initialized = await uploads.init(userId, {
        clientMessageId,
        partId: randomUUID(),
        position: 0,
        intent: 'FILE',
        originalName: 'checkpoint.bin',
        mimeType: 'application/octet-stream',
        totalBytes: bytes.length,
      });
      await uploads.append(
        userId,
        initialized.id,
        `bytes 0-${bytes.length - 1}/${bytes.length}`,
        bytes,
      );
      const row = (await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(initialized.id)),
      }))!;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const checkpoint = join(
        dataDirectory('resumable'),
        `${row.tmpKey}.resume.json`,
      );
      const part = join(dataDirectory('resumable'), `${row.tmpKey}.part`);
      const finalCheckpoint = JSON.stringify({ offset: bytes.length, digest });
      await writeFile(checkpoint, finalCheckpoint);
      if (changed) {
        const modified = Buffer.from(bytes);
        modified[0] ^= 1;
        await writeFile(part, modified);
        await expect(uploads.complete(userId, initialized.id)).rejects.toThrow(
          'does not match its final checkpoint',
        );
        expect(await readFile(part)).toEqual(modified);
        expect(await readFile(checkpoint, 'utf8')).toBe(finalCheckpoint);
        expect(
          await database.db.query.uploadSession.findFirst({
            where: eq(uploadSession.id, row.id),
          }),
        ).toMatchObject({ status: 'FAILED', digest: null, result: null });
        expect(
          await database.db.query.message.findFirst({
            where: eq(message.clientMessageId, clientMessageId),
          }),
        ).toBeUndefined();
        await uploads.cancel(userId, initialized.id);
      } else {
        await expect(
          uploads.complete(userId, initialized.id),
        ).resolves.toMatchObject({ status: 'COMPLETED' });
        expect(
          await readFile(app.get(UploadService).casTarget(digest).abs),
        ).toEqual(bytes);
      }
    },
  );

  it.each([false, true])(
    'verifies retained bytes before publishing a durable result (changed: %s)',
    async (changed) => {
      const clientMessageId = randomUUID();
      const bytes = Buffer.from(`durable-result-${randomUUID()}`);
      await messages.stageMedia(
        userId,
        threadId,
        'GALLERY' as never,
        clientMessageId,
        2,
      );
      const initialized = await uploads.init(userId, {
        clientMessageId,
        partId: randomUUID(),
        position: 0,
        intent: 'FILE',
        originalName: 'retained.bin',
        mimeType: 'application/octet-stream',
        totalBytes: bytes.length,
      });
      await uploads.append(
        userId,
        initialized.id,
        `bytes 0-${bytes.length - 1}/${bytes.length}`,
        bytes,
      );
      await uploads.complete(userId, initialized.id);
      const row = (await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(initialized.id)),
      }))!;
      expect(row.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(row.result).toHaveProperty('payload.localMeta');
      const part = join(dataDirectory('resumable'), `${row.tmpKey}.part`);
      const checkpoint = join(
        dataDirectory('resumable'),
        `${row.tmpKey}.resume.json`,
      );
      const originalCheckpoint = await readFile(checkpoint, 'utf8');
      if (changed) {
        const modified = Buffer.from(bytes);
        modified[0] ^= 1;
        await writeFile(part, modified);
        await expect(
          uploads.sendCompleted(userId, clientMessageId),
        ).rejects.toThrow('CAS digest mismatch');
        expect(await readFile(part)).toEqual(modified);
        expect(await readFile(checkpoint, 'utf8')).toBe(originalCheckpoint);
        expect(
          await database.db.query.message.findFirst({
            where: eq(message.clientMessageId, clientMessageId),
          }),
        ).toBeUndefined();
        await expect(
          stat(app.get(UploadService).casTarget(row.digest!).abs),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await uploads.cancel(userId, initialized.id);
      } else {
        await expect(
          uploads.sendCompleted(userId, clientMessageId),
        ).resolves.toMatchObject({ sent: true });
        expect(
          await readFile(app.get(UploadService).casTarget(row.digest!).abs),
        ).toEqual(bytes);
      }
    },
  );

  it('preserves accepted bytes after a processing error and requires explicit retry', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from(`interrupted-${randomUUID()}`);
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const initialized = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'input.bin',
      mimeType: 'application/octet-stream',
      totalBytes: bytes.length,
    });
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const process = vi
      .spyOn(app.get(MediaMetadataService), 'processFile')
      .mockRejectedValueOnce(new Error('interrupted decoder'));
    try {
      await expect(uploads.complete(userId, initialized.id)).rejects.toThrow(
        'interrupted decoder',
      );
      const interrupted = await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(initialized.id)),
      });
      expect(interrupted).toMatchObject({
        status: 'FAILED',
        result: null,
        errorReason: 'interrupted decoder',
      });
      expect(
        await readFile(
          join(dataDirectory('resumable'), `${interrupted!.tmpKey}.part`),
        ),
      ).toEqual(bytes);
      await app.get(UploadRecoveryService).resume();
      expect((await uploads.status(userId, initialized.id)).status).toBe(
        'FAILED',
      );
      expect(process).toHaveBeenCalledOnce();
      expect((await uploads.retry(userId, initialized.id)).status).toBe(
        'COMPLETED',
      );
      const finished = await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(initialized.id)),
      });
      expect(finished?.status).toBe('COMPLETED');
      expect(finished?.tmpKey).toBe(interrupted?.tmpKey);
      expect(process).toHaveBeenCalledTimes(2);
    } finally {
      process.mockRestore();
    }
  });

  it('publishes only selected completed files and retains stopped siblings with stable positions and bytes', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'GALLERY' as never,
      clientMessageId,
      2,
    );
    const unfinishedBytes = Buffer.from('unfinished gallery file');
    const unfinished = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'unfinished.txt',
      mimeType: 'text/plain',
      totalBytes: unfinishedBytes.length,
    });
    await uploads.append(
      userId,
      unfinished.id,
      `bytes 0-3/${unfinishedBytes.length}`,
      unfinishedBytes.subarray(0, 4),
    );
    const unfinishedRow = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(unfinished.id)),
    });

    const completedBytes = Buffer.from('completed gallery file');
    const completed = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 1,
      intent: 'FILE',
      originalName: 'completed.txt',
      mimeType: 'text/plain',
      totalBytes: completedBytes.length,
    });
    await uploads.append(
      userId,
      completed.id,
      `bytes 0-${completedBytes.length - 1}/${completedBytes.length}`,
      completedBytes,
    );
    expect((await uploads.complete(userId, completed.id)).phase).toBe(
      'COMPLETING',
    );
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();

    expect(await uploads.sendCompleted(userId, clientMessageId)).toEqual({
      clientMessageId,
      sent: true,
      completed: 1,
    });
    const committed = await database.db.query.message.findFirst({
      where: eq(message.clientMessageId, clientMessageId),
    });
    expect(JSON.parse(committed!.content).items).toMatchObject([
      {
        url: expect.stringContaining(
          createHash('sha256').update(completedBytes).digest('hex'),
        ),
        name: 'completed.txt',
        size: completedBytes.length,
      },
    ]);
    const remaining = await database.db.query.uploadSession.findMany({
      where: inArray(uploadSession.id, [
        BigInt(completed.id),
        BigInt(unfinished.id),
      ]),
    });
    expect(remaining).toHaveLength(2);
    expect(
      remaining.find((row) => row.id.toString() === completed.id),
    ).toMatchObject({ position: 1, status: 'COMPLETED' });
    expect(
      remaining.find((row) => row.id.toString() === unfinished.id),
    ).toMatchObject({
      position: 0,
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      tmpKey: unfinishedRow!.tmpKey,
    });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    await expect(
      stat(join(dataDirectory('resumable'), `${unfinishedRow!.tmpKey}.part`)),
    ).resolves.toBeDefined();
    await expect(
      stat(
        join(
          dataDirectory('resumable'),
          `${unfinishedRow!.tmpKey}.resume.json`,
        ),
      ),
    ).resolves.toBeDefined();
    expect(
      await readFile(
        join(dataDirectory('resumable'), `${unfinishedRow!.tmpKey}.part`),
      ),
    ).toEqual(unfinishedBytes.subarray(0, 4));
    expect(await uploads.sendCompleted(userId, clientMessageId)).toEqual({
      clientMessageId,
      sent: true,
      completed: 1,
    });
  });

  it('cancels a stage-only batch before any upload session exists', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );

    await expect(uploads.cancelBatch(userId, clientMessageId)).resolves.toEqual(
      { clientMessageId, cancelled: 0 },
    );
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    // No stage or task remains to establish ownership for a subsequent command.
    await expect(uploads.cancelBatch(userId, clientMessageId)).rejects.toThrow(
      'upload batch not found',
    );
  });

  it('deletes batch staging after cleanup and creates fresh tasks when sending again', async () => {
    const clientMessageId = randomUUID();
    const request = {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE' as const,
      originalName: 'retry.txt',
      mimeType: 'text/plain',
      totalBytes: 4,
    };
    await messages.stageMedia(
      userId,
      threadId,
      ContentType.FILE,
      clientMessageId,
    );
    const first = await uploads.init(userId, request);
    await uploads.append(userId, first.id, 'bytes 0-3/4', Buffer.from('data'));
    const original = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(first.id)),
    });
    expect(original).toBeDefined();
    await uploads.cancelBatch(userId, clientMessageId);
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    expect(
      await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, BigInt(first.id)),
      }),
    ).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_CANCELLED',
      pendingMediaId: null,
    });
    for (const suffix of ['.part', '.resume.json', '.resume.json.tmp']) {
      await expect(
        stat(join(dataDirectory('resumable'), original!.tmpKey + suffix)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(uploads.retry(userId, first.id)).rejects.toThrow(
      'upload task has no pending stage',
    );
    await messages.stageMedia(
      userId,
      threadId,
      ContentType.FILE,
      clientMessageId,
    );
    const next = await uploads.init(userId, request);
    expect(next.id).not.toBe(first.id);
    expect(next.offset).toBe(0);
    const replacement = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.id, BigInt(next.id)),
    });
    expect(replacement!.pendingMediaId).not.toBe(original!.pendingMediaId);
    expect(replacement!.tmpKey).not.toBe(original!.tmpKey);
    await expect(
      uploads.cancelBatch(userId, clientMessageId),
    ).resolves.toMatchObject({ cancelled: 1 });
  });

  it('rejects non-owner batch cancel and send-completed without touching the owner stage', async () => {
    const clientMessageId = randomUUID();
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );

    await expect(uploads.cancelBatch(peerId, clientMessageId)).rejects.toThrow(
      'upload batch not found',
    );
    await expect(
      uploads.sendCompleted(peerId, clientMessageId),
    ).rejects.toThrow('upload batch not found');
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeDefined();
  });

  it('rejects cancelling an already committed batch', async () => {
    const clientMessageId = randomUUID();
    const bytes = Buffer.from('committed upload bytes');
    await messages.stageMedia(
      userId,
      threadId,
      'FILE' as never,
      clientMessageId,
    );
    const initialized = await uploads.init(userId, {
      clientMessageId,
      partId: randomUUID(),
      position: 0,
      intent: 'FILE',
      originalName: 'committed.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.length,
    });
    await uploads.append(
      userId,
      initialized.id,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    expect((await uploads.complete(userId, initialized.id)).status).toBe(
      'COMPLETED',
    );

    await expect(uploads.cancelBatch(userId, clientMessageId)).rejects.toThrow(
      'upload batch not found',
    );
  });

  it.each(['complete', 'selection'] as const)(
    'rejects the conflicting operation immediately when %s owns publication',
    async (winner) => {
      const clientMessageId = randomUUID();
      await messages.stageMedia(
        userId,
        threadId,
        'GALLERY' as never,
        clientMessageId,
        2,
      );
      const firstBytes = Buffer.from('first concurrent gallery file');
      const first = await uploads.init(userId, {
        clientMessageId,
        partId: randomUUID(),
        position: 0,
        intent: 'FILE',
        originalName: 'first.txt',
        mimeType: 'text/plain',
        totalBytes: firstBytes.length,
      });
      await uploads.append(
        userId,
        first.id,
        `bytes 0-${firstBytes.length - 1}/${firstBytes.length}`,
        firstBytes,
      );
      expect((await uploads.complete(userId, first.id)).phase).toBe(
        'COMPLETING',
      );

      const secondBytes = Buffer.from('second concurrent gallery file');
      const second = await uploads.init(userId, {
        clientMessageId,
        partId: randomUUID(),
        position: 1,
        intent: 'FILE',
        originalName: 'second.txt',
        mimeType: 'text/plain',
        totalBytes: secondBytes.length,
      });
      await uploads.append(
        userId,
        second.id,
        `bytes 0-${secondBytes.length - 1}/${secondBytes.length}`,
        secondBytes,
      );

      // Pause real publication while the winner owns the execution slot. The loser
      // must reject before this gate opens, rather than waiting for a queue turn.
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const publishing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const storage = app.get(UploadService);
      const land = storage.landStagedPart.bind(storage);
      const spy = vi
        .spyOn(storage, 'landStagedPart')
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return land(...args);
        });
      const winningRequest =
        winner === 'complete'
          ? uploads.complete(userId, second.id)
          : uploads.sendCompleted(userId, clientMessageId);
      const winningOutcome = Promise.allSettled([winningRequest]);
      try {
        await publishing;
        const losingRequest =
          winner === 'complete'
            ? uploads.sendCompleted(userId, clientMessageId)
            : uploads.complete(userId, second.id);
        await expect(losingRequest).rejects.toThrow('upload execution is busy');
        expect(
          await database.db.query.message.findFirst({
            where: eq(message.clientMessageId, clientMessageId),
          }),
        ).toBeUndefined();
      } finally {
        release();
        await winningOutcome;
        spy.mockRestore();
      }
      const [won] = await winningOutcome;
      expect(won.status).toBe('fulfilled');
      const committed = await database.db.query.message.findMany({
        where: eq(message.clientMessageId, clientMessageId),
      });
      expect(committed).toHaveLength(1);
      const sessions = await database.db.query.uploadSession.findMany({
        where: inArray(uploadSession.id, [BigInt(first.id), BigInt(second.id)]),
      });
      expect(sessions).toHaveLength(2);
      const firstRow = sessions.find((row) => row.id.toString() === first.id)!;
      const secondRow = sessions.find(
        (row) => row.id.toString() === second.id,
      )!;
      expect(firstRow.status).toBe('COMPLETED');
      const items = JSON.parse(committed[0].content).items as Array<{
        url: string;
      }>;
      const firstDigest = createHash('sha256').update(firstBytes).digest('hex');
      const secondDigest = createHash('sha256')
        .update(secondBytes)
        .digest('hex');
      expect(secondRow.status).toBe(
        winner === 'complete' ? 'COMPLETED' : 'FAILED',
      );
      if (winner === 'complete') {
        // Final complete owns publication: both files commit together.
        expect(items.map((item) => item.url.split('/').at(-1))).toEqual([
          firstDigest,
          secondDigest,
        ]);
        await expect(
          uploads.sendCompleted(userId, clientMessageId),
        ).resolves.toMatchObject({ sent: true, completed: 2 });
      } else {
        // Selection owns publication: the excluded file remains stopped and cannot publish.
        expect(secondRow.status).toBe('FAILED');
        expect(secondRow.errorReason).toBe('USER_STOPPED');
        await expect(uploads.complete(userId, second.id)).rejects.toThrow(
          'upload requires explicit retry',
        );
        expect(items.map((item) => item.url.split('/').at(-1))).toEqual([
          firstDigest,
        ]);
        expect(won).toMatchObject({
          value: { sent: true, completed: 1 },
        });
        expect(
          await readFile(
            join(dataDirectory('resumable'), `${secondRow.tmpKey}.part`),
          ),
        ).toEqual(secondBytes);
      }
      expect(
        await database.db.query.pendingMedia.findFirst({
          where: eq(pendingMedia.clientMessageId, clientMessageId),
        }),
      ).toBeUndefined();
    },
  );
});
