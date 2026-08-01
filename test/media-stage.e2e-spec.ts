import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { and, count, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  mediaMessage,
  message,
  messageThread,
  pendingMedia,
  threadParticipant,
  user,
} from '../src/database/schema';
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
  let database: DatabaseService;
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
    database = app.get(DatabaseService);
    messages = app.get(MessageService);

    const now = new Date();
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account: `st-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        hashPwd: 'x',
        name: 'stage',
        isForeigner: false,
        updatedAt: now,
      })
      .returning({ id: user.id });
    userId = createdUser.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db
      .insert(threadParticipant)
      .values({ userId, threadId, updatedAt: now });
  });

  afterAll(async () => {
    await database.pool
      .query('DELETE FROM "ThreadParticipant" WHERE "threadId" = $1', [
        threadId,
      ])
      .catch(() => {});
    await database.pool
      .query('DELETE FROM "MessageThread" WHERE id = $1', [threadId])
      .catch(() => {});
    await database.pool
      .query('DELETE FROM "User" WHERE id = $1', [userId])
      .catch(() => {});
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
    const rows = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].threadId).toBe(threadId);
    expect(rows[0].creatorId).toBe(userId);
    // cleanup
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.id, rows[0].id));
  });

  it('persists failure and only an explicit retry moves failed back to pending', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {});
    await messages.failStaged(userId, cid, 'file too large');

    let [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('failed');
    expect(stage?.failReason).toBe('file too large');
    expect(await messages.promoteStaged(cid, uploadPayload, userId)).toBeNull();

    // An ordinary duplicate stage is a no-op; it must not silently retry a failed send.
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {});
    [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('failed');

    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {}, true);
    [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('pending');
    expect(stage?.failReason).toBeNull();

    const recovered = await messages.queryMediaStages(userId, threadId);
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientMessageId: cid,
          status: 'pending',
          failReason: null,
        }),
      ]),
    );
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid));
  });

  it('does not let another user fail or promote a staged send by clientMessageId', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, 'FILE' as never, cid, {});
    await messages.failStaged(userId + 1, cid, 'not mine');
    expect(
      await messages.promoteStaged(cid, uploadPayload, userId + 1),
    ).toBeNull();
    const [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('pending');
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid));
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
    expect(
      (
        await database.db
          .select()
          .from(pendingMedia)
          .where(eq(pendingMedia.clientMessageId, cid))
          .limit(1)
      )[0],
    ).toBeUndefined();
    const [msg] = await database.db
      .select()
      .from(message)
      .where(and(eq(message.threadId, threadId), eq(message.creator, userId)))
      .limit(1);
    expect(msg).toBeDefined();
    const [mediaMsg] = await database.db
      .select()
      .from(mediaMessage)
      .where(eq(mediaMessage.threadId, threadId))
      .limit(1);
    expect(mediaMsg).toBeDefined();
    expect(mediaMsg!.digest).toBe(digest);

    // Re-promote with the same cid returns the SAME message (idempotent) — no duplicate, no error.
    const again = await messages.promoteStaged(cid, uploadPayload);
    expect(again!.seq).toBe(committed!.seq);
    const [{ value }] = await database.db
      .select({ value: count() })
      .from(message)
      .where(and(eq(message.threadId, threadId), eq(message.creator, userId)));
    expect(value).toBe(1);
  });

  it('can promote an IMAGE stage as FILE and drops image-only metadata', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, 'IMAGE' as never, cid, {
      w: 4032,
      h: 3024,
    });
    await messages.linkStagedDigest(cid, digest);

    const committed = await messages.promoteStaged(
      cid,
      uploadPayload,
      userId,
      'FILE' as never,
    );
    expect(committed?.contentType).toBe('FILE');
    expect(JSON.parse(committed!.content)).toEqual(uploadPayload);
  });
});
