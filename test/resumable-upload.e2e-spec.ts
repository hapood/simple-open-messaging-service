import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  threadParticipant,
  user,
} from '../src/database/schema';
import { MessageService } from '../src/message/message.service';
import { ResumableUploadService } from '../src/upload/resumable-upload.service';
import { eq } from 'drizzle-orm';

describe('sequential resumable uploads', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let messages: MessageService;
  let uploads: ResumableUploadService;
  let userId: number;
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
        name: 'resume',
        isForeigner: false,
        updatedAt: now,
      })
      .returning({ id: user.id });
    userId = createdUser.id;
    const [createdThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning({ id: messageThread.id });
    threadId = createdThread.id;
    await database.db
      .insert(threadParticipant)
      .values({ userId, threadId, updatedAt: now });
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
});
