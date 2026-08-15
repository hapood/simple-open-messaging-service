import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  messageAsset,
  message,
  messageThread,
  friendRequest,
  pendingMedia,
  threadParticipant,
  user,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums';
import { MessageService } from '../src/message/message.service';
import { UserQuotaService } from '../src/quota/user-quota.service';
import { BusinessCode } from '../src/common/business-code';
import { InviteService } from '../src/invite/invite.service';
import type { OutboundFilePayload } from '../src/upload/file-content';

/**
 * Local media send staging (Phase 7 barrier model): a media message is NOT committed as a Message until
 * every file in its batch has landed. Exercises MessageService.stageMedia (message-level intent +
 * fileCnt) + markOutboundFileSucceeded / promoteOutboundBatchIfReady (the FileSyncProgress barrier +
 * DELETE win-guard) directly against the real DB.
 *
 * Federated stage→localize→commit is covered by federation.e2e-spec.ts; the orphan/stale-pending GC
 * sweep is covered by media-gc.e2e-spec.ts.
 */
describe('Local media send staging (PendingMedia, Phase 7)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let messages: MessageService;
  let userQuota: UserQuotaService;
  let invites: InviteService;

  let threadId: number;
  let userId: number;
  let inviteTargetIds: number[];

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
    userQuota = app.get(UserQuotaService);
    invites = app.get(InviteService);

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
    inviteTargetIds = (
      await database.db
        .insert(user)
        .values(
          [1, 2].map((n) => ({
            account: `st-target-${n}-${randomUUID().slice(0, 8)}`,
            hashPwd: 'x',
            name: `target ${n}`,
            isForeigner: false,
            updatedAt: now,
          })),
        )
        .returning({ id: user.id })
    ).map((row) => row.id);
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
      .query('DELETE FROM "User" WHERE id = ANY($1)', [
        [userId, ...inviteTargetIds],
      ])
      .catch(() => {});
    await app.close();
  });

  /** Build a shape-valid outbound FILE payload for a given digest. */
  const filePayload = (d: string): OutboundFilePayload => ({
    digest: d,
    url: `/uploads/msg-assets/${d.slice(0, 2)}/${d.slice(2, 4)}/${d}`,
    size: 7,
    family: 'FILE',
    name: 'stage.bin',
    mimeType: 'application/octet-stream',
  });

  it('stageMedia creates a PendingMedia(pending) and is idempotent by clientMessageId', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid);
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid); // retried stage
    const rows = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].fileCnt).toBe(1);
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.id, rows[0].id));
  });

  it('charges only a newly-created friend request, not a pending duplicate', async () => {
    await userQuota.setPolicy(userId, { dailyRequestLimit: 1 });
    const writeAndCharge = async (
      tx: Parameters<UserQuotaService['tick']>[2],
      created: boolean,
    ) => {
      if (created) await userQuota.tick(userId, 'requests', tx);
      await invites.writeLocalFriendIntentInTx(
        tx,
        userId,
        inviteTargetIds[0],
        true,
        '',
      );
    };

    expect(
      await invites.createFriendInvite(
        userId,
        inviteTargetIds[0],
        '',
        true,
        undefined,
        writeAndCharge,
      ),
    ).toMatchObject({ status: 'created' });
    expect(
      await invites.createFriendInvite(
        userId,
        inviteTargetIds[0],
        'updated',
        true,
        undefined,
        writeAndCharge,
      ),
    ).toMatchObject({ status: 'already-pending' });
    await expect(
      invites.createFriendInvite(
        userId,
        inviteTargetIds[1],
        '',
        true,
        undefined,
        async (tx, created) => {
          if (created) await userQuota.tick(userId, 'requests', tx);
          await invites.writeLocalFriendIntentInTx(
            tx,
            userId,
            inviteTargetIds[1],
            true,
            '',
          );
        },
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.QUOTA_EXCEEDED });

    expect(
      await database.db.query.friendRequest.findFirst({
        where: and(
          eq(friendRequest.requesterUserId, userId),
          eq(friendRequest.targetUserId, inviteTargetIds[1]),
        ),
      }),
    ).toBeUndefined();
  });

  it('persists failure and only an explicit retry moves failed back to pending', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid);
    await messages.failStaged(userId, cid, 'file too large');

    let [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('failed');
    expect(stage?.failReason).toBe('file too large');
    // A failed stage is not promotable.
    const digest = 'f'.repeat(64);
    expect(
      await messages.markOutboundFileSucceeded(
        cid,
        randomUUID(),
        0,
        digest,
        filePayload(digest),
        userId,
      ),
    ).toBeNull();

    // An ordinary duplicate stage is a no-op; it must not silently retry a failed send.
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid);
    [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('failed');

    await messages.stageMedia(userId, threadId, ContentType.FILE, cid, 1, true);
    [stage] = await database.db
      .select()
      .from(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid))
      .limit(1);
    expect(stage?.status).toBe('pending');
    expect(stage?.failReason).toBeNull();
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.clientMessageId, cid));
  });

  it('does not let another user fail or promote a staged send by clientMessageId', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid);
    await messages.failStaged(userId + 1, cid, 'not mine');
    const digest = 'e'.repeat(64);
    expect(
      await messages.markOutboundFileSucceeded(
        cid,
        randomUUID(),
        0,
        digest,
        filePayload(digest),
        userId + 1,
      ),
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

  it('markOutboundFileSucceeded commits a Message + messageAsset and deletes the stage; re-promote is idempotent', async () => {
    const cid = randomUUID();
    const partId = randomUUID();
    const digest = 'a'.repeat(64);
    await messages.stageMedia(userId, threadId, ContentType.FILE, cid);

    const result = await messages.markOutboundFileSucceeded(
      cid,
      partId,
      0,
      digest,
      filePayload(digest),
      userId,
    );
    expect(result?.newlyPromoted).toBe(true);
    expect(result?.message.contentType).toBe('FILE');
    expect(result?.message.threadId).toBe(threadId);
    // The stage row is gone; a real Message + its messageAsset authz row now exist.
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
      .from(messageAsset)
      .where(eq(messageAsset.threadId, threadId))
      .limit(1);
    expect(mediaMsg).toBeDefined();
    expect(mediaMsg!.digest).toBe(digest);

    // Re-marking the same file after the stage is promoted+deleted is a no-op (returns null) — no
    // duplicate Message, no error.
    const again = await messages.markOutboundFileSucceeded(
      cid,
      partId,
      0,
      digest,
      filePayload(digest),
      userId,
    );
    expect(again).toBeNull();
    const [{ value }] = await database.db
      .select({ value: count() })
      .from(message)
      .where(and(eq(message.threadId, threadId), eq(message.creator, userId)));
    expect(value).toBe(1);
  });

  it('can promote an IMAGE stage as FILE via overrideContentType (HEIC fallback)', async () => {
    const cid = randomUUID();
    const digest = 'b'.repeat(64);
    await messages.stageMedia(userId, threadId, ContentType.IMAGE, cid);
    const heic: OutboundFilePayload = {
      digest,
      url: `/uploads/msg-assets/bb/bb/${digest}`,
      size: 9,
      family: 'FILE',
      name: 'photo.heic',
      mimeType: 'image/heic',
    };
    const result = await messages.markOutboundFileSucceeded(
      cid,
      randomUUID(),
      0,
      digest,
      heic,
      userId,
      ContentType.FILE,
    );
    expect(result?.message.contentType).toBe('FILE');
  });

  it('a GALLERY batch promotes only once after every file lands, with N messageAsset rows', async () => {
    const cid = randomUUID();
    await messages.stageMedia(userId, threadId, ContentType.GALLERY, cid, 2);
    const d1 = '1'.repeat(64);
    const d2 = '2'.repeat(64);

    // First file: barrier not yet met → no promote.
    const r1 = await messages.markOutboundFileSucceeded(
      cid,
      randomUUID(),
      0,
      d1,
      filePayload(d1),
      userId,
    );
    expect(r1).toBeNull();

    // Second file: barrier met → promote. Content is the digest-sorted GALLERY items.
    const r2 = await messages.markOutboundFileSucceeded(
      cid,
      randomUUID(),
      1,
      d2,
      filePayload(d2),
      userId,
    );
    expect(r2?.newlyPromoted).toBe(true);
    expect(r2?.message.contentType).toBe('GALLERY');
    const items = (JSON.parse(r2!.message.content) as { items: unknown[] })
      .items;
    expect(items).toHaveLength(2);

    // One Message, two messageAsset rows (one per digest).
    const [{ value }] = await database.db
      .select({ value: count() })
      .from(message)
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.creator, userId),
          eq(message.contentType, 'GALLERY'),
        ),
      );
    expect(value).toBe(1);
    const assets = await database.db
      .select({ digest: messageAsset.digest })
      .from(messageAsset)
      .where(
        and(
          eq(messageAsset.threadId, threadId),
          inArray(messageAsset.digest, [d1, d2]),
        ),
      );
    expect(assets.map((a) => a.digest).sort()).toEqual([d1, d2]);
  });

  it('counts repeated digest selections as distinct logical gallery parts', async () => {
    const cid = randomUUID();
    const digest = '3'.repeat(64);
    await messages.stageMedia(userId, threadId, ContentType.GALLERY, cid, 2);

    expect(
      await messages.markOutboundFileSucceeded(
        cid,
        randomUUID(),
        0,
        digest,
        filePayload(digest),
        userId,
      ),
    ).toBeNull();
    const result = await messages.markOutboundFileSucceeded(
      cid,
      randomUUID(),
      1,
      digest,
      filePayload(digest),
      userId,
    );
    const items = (JSON.parse(result!.message.content) as { items: unknown[] })
      .items;
    expect(items).toHaveLength(2);

    const stored = await database.db.query.message.findFirst({
      where: eq(message.clientMessageId, cid),
      columns: { id: true },
    });
    const assets = await database.db
      .select({ digest: messageAsset.digest })
      .from(messageAsset)
      .where(eq(messageAsset.messageId, stored!.id));
    expect(assets).toEqual([{ digest }]);
  });
});
