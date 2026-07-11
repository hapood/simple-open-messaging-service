import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { MessageService } from '../src/message/message.service';

/**
 * Local media send staging (PendingMedia): the new create-before-upload flow. A media message is NOT
 * committed as a Message until its bytes are confirmed (here: until promoteStaged runs after the
 * upload). Exercises MessageService.stageMedia / linkStagedDigest / promoteStaged directly against the
 * real DB — the stage→commit state machine + idempotency (the optimistic-send clientMessageId key).
 *
 * Federated stage→localize→commit is covered by federation.e2e-spec.ts (the media-localization cases);
 * the orphan/stale-pending GC sweep is covered by media-gc.e2e-spec.ts.
 */
describe('Local media send staging (PendingMedia)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let messages: MessageService;

  // A throwaway P2P thread + sender participant the staged send targets.
  let threadId: number;
  let userId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    messages = app.get(MessageService);

    const user = await prisma.user.create({
      data: { account: `st-${randomUUID().replace(/-/g, '').slice(0, 8)}`, hashPwd: 'x', name: 'stage', isForeigner: false },
    });
    userId = user.id;
    const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
    threadId = thread.id;
    await prisma.threadParticipant.create({ data: { userId, threadId } });
  });

  afterAll(async () => {
    await prisma.threadParticipant.deleteMany({ where: { threadId } }).catch(() => {});
    await prisma.messageThread.delete({ where: { id: threadId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await app.close();
  });

  /** A fake but shape-valid CAS payload: a 64-hex digest whose shard path extractDigests recognizes. */
  const digest = 'a'.repeat(64);
  const uploadPayload = {
    url: `/uploads/shards/aa/aa/${digest}.bin`,
    name: 'stage.bin',
    size: 7,
    mimeType: 'application/octet-stream',
  };

  it('stageMedia creates a PendingMedia(pending) and is idempotent by clientMessageId', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {});
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {}); // retried stage
    const rows = await prisma.pendingMedia.findMany({ where: { clientMessageId: cid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].threadId).toBe(threadId);
    expect(rows[0].creatorId).toBe(userId);
    // cleanup
    await prisma.pendingMedia.delete({ where: { id: rows[0].id } });
  });

  it('promoteStaged commits a Message + MediaMessage and deletes the stage; re-promote is idempotent', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {});
    await messages.linkStagedDigest(cid, digest);

    const committed = await messages.promoteStaged(cid, uploadPayload);
    expect(committed).not.toBeNull();
    expect(committed!.contentType).toBe('FILE');
    expect(committed!.threadId).toBe(threadId);
    // The stage row is gone; a real Message + its MediaMessage authz row now exist.
    expect(await prisma.pendingMedia.findUnique({ where: { clientMessageId: cid } })).toBeNull();
    const msg = await prisma.message.findFirst({ where: { threadId, creator: userId } });
    expect(msg).not.toBeNull();
    const mediaMsg = await prisma.mediaMessage.findFirst({ where: { threadId } });
    expect(mediaMsg).not.toBeNull();
    expect(mediaMsg!.digest).toBe(digest);

    // Re-promote with the same cid returns the SAME message (idempotent) — no duplicate, no error.
    const again = await messages.promoteStaged(cid, uploadPayload);
    expect(again!.seq).toBe(committed!.seq);
    const count = await prisma.message.count({ where: { threadId, creator: userId } });
    expect(count).toBe(1);
  });
});
