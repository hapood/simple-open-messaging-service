import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
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
import { MessageService } from '../src/message/message.service';
import { ResumableUploadService } from '../src/upload/resumable-upload.service';
import { eq } from 'drizzle-orm';
import { seedAcceptedRelationship } from './seed';
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
    expect((await uploads.init(userId, initRequest)).uploadId).toBe(
      initialized.uploadId,
    );

    const first = bytes.subarray(0, 8);
    const afterFirst = await uploads.append(
      userId,
      initialized.uploadId,
      `bytes 0-7/${bytes.length}`,
      first,
    );
    expect(afterFirst.offset).toBe(8);
    expect(
      (
        await uploads.append(
          userId,
          initialized.uploadId,
          `bytes 0-7/${bytes.length}`,
          first,
        )
      ).offset,
    ).toBe(8);

    const rest = bytes.subarray(8);
    const received = await uploads.append(
      userId,
      initialized.uploadId,
      `bytes 8-${bytes.length - 1}/${bytes.length}`,
      rest,
    );
    expect(received.offset).toBe(bytes.length);
    expect((await uploads.complete(userId, initialized.uploadId)).status).toBe(
      'COMPLETED',
    );
    expect((await uploads.complete(userId, initialized.uploadId)).status).toBe(
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
      initialized.uploadId,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const view = await uploads.complete(userId, initialized.uploadId);
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
    const again = await uploads.complete(userId, initialized.uploadId);
    expect(again.status).toBe('COMPLETED');
    expect(again.result?.digest).toBe(view.result?.digest);
    const messages2 = await database.db.query.message.findMany({
      where: eq(message.clientMessageId, clientMessageId),
    });
    expect(messages2).toHaveLength(1);
  });

  it('cancels one upload, removes its artifacts and stage, and rejects further writes', async () => {
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
      initialized.uploadId,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    const session = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.uploadId, initialized.uploadId),
    });
    const root = dataDirectory('resumable');
    const partPath = join(root, `${session!.tmpKey}.part`);
    const sidecarPath = join(root, `${session!.tmpKey}.resume.json`);
    await expect(stat(partPath)).resolves.toBeDefined();
    await expect(stat(sidecarPath)).resolves.toBeDefined();

    expect((await uploads.cancel(userId, initialized.uploadId)).status).toBe(
      'ABORTED',
    );
    await expect(stat(partPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    await expect(
      uploads.append(
        userId,
        initialized.uploadId,
        `bytes 0-${bytes.length - 1}/${bytes.length}`,
        bytes,
      ),
    ).rejects.toThrow('upload aborted');
    expect((await uploads.cancel(userId, initialized.uploadId)).status).toBe(
      'ABORTED',
    );
  });

  it('sends only completed gallery files, compacts positions, and discards unfinished sessions', async () => {
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
      unfinished.uploadId,
      `bytes 0-3/${unfinishedBytes.length}`,
      unfinishedBytes.subarray(0, 4),
    );
    const unfinishedRow = await database.db.query.uploadSession.findFirst({
      where: eq(uploadSession.uploadId, unfinished.uploadId),
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
      completed.uploadId,
      `bytes 0-${completedBytes.length - 1}/${completedBytes.length}`,
      completedBytes,
    );
    expect((await uploads.complete(userId, completed.uploadId)).status).toBe(
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
    expect(JSON.parse(committed!.content).items).toHaveLength(1);
    const remaining = await database.db.query.uploadSession.findMany({
      where: eq(uploadSession.clientMessageId, clientMessageId),
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ position: 0, status: 'COMPLETED' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.clientMessageId, clientMessageId),
      }),
    ).toBeUndefined();
    await expect(
      stat(join(dataDirectory('resumable'), `${unfinishedRow!.tmpKey}.part`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(
        join(
          dataDirectory('resumable'),
          `${unfinishedRow!.tmpKey}.resume.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
      initialized.uploadId,
      `bytes 0-${bytes.length - 1}/${bytes.length}`,
      bytes,
    );
    expect((await uploads.complete(userId, initialized.uploadId)).status).toBe(
      'COMPLETED',
    );

    await expect(uploads.cancelBatch(userId, clientMessageId)).rejects.toThrow(
      'completed upload batch cannot be cancelled',
    );
  });

  it('serializes the final complete and send-completed into one committed message', async () => {
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
      first.uploadId,
      `bytes 0-${firstBytes.length - 1}/${firstBytes.length}`,
      firstBytes,
    );
    expect((await uploads.complete(userId, first.uploadId)).status).toBe(
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
      second.uploadId,
      `bytes 0-${secondBytes.length - 1}/${secondBytes.length}`,
      secondBytes,
    );

    await Promise.allSettled([
      uploads.complete(userId, second.uploadId),
      uploads.sendCompleted(userId, clientMessageId),
    ]);
    const committed = await database.db.query.message.findMany({
      where: eq(message.clientMessageId, clientMessageId),
    });
    expect(committed).toHaveLength(1);
    const sessions = await database.db.query.uploadSession.findMany({
      where: eq(uploadSession.clientMessageId, clientMessageId),
    });
    expect(sessions.every((session) => session.status === 'COMPLETED')).toBe(
      true,
    );
  });
});
