import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { and, count, eq, inArray, or } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  account as accountTable,
  messageAsset,
  message,
  messageThread,
  relationshipPair,
  pendingMedia,
  account as user,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums';
import { MessageService } from '../src/message/message.service';
import { UserQuotaService } from '../src/quota/user-quota.service';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service';
import { userQuotaDailyUsage } from '../src/database/schema';
import { BusinessCode } from '../src/common/business-code';
import type { OutboundFilePayload } from '../src/upload/file-content';
import { seedAcceptedRelationship } from './seed';
import { createTestApp } from './support/app';

/**
 * Local media send staging (Phase 7 barrier model): a media message is NOT committed as a Message until
 * every file in its batch has landed. Exercises MessageService.stageMedia (message-level intent +
 * fileCnt) + markOutboundFileSucceeded / promoteOutboundBatchIfReady (the FileSyncProgress barrier +
 * DELETE win-guard) directly against the real DB.
 *
 * Federated stage→localize→commit is covered by federation.e2e-spec.ts; the orphan/stale-pending GC
 * cleanup is owned by the corresponding transfer lifecycle.
 */
describe('Local media send staging (PendingMedia, Phase 7)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let messages: MessageService;
  let userQuota: UserQuotaService;
  let userIntents: UserIntentService;

  let threadId: number;
  let userId: number;
  let userAccount: string;
  let inviteTargetIds: number[];

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    messages = app.get(MessageService);
    userQuota = app.get(UserQuotaService);
    userIntents = app.get(UserIntentService);

    const now = new Date();
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account: `st-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        updatedAt: now,
      })
      .returning({ id: user.id, account: user.account });
    userId = createdUser.id;
    userAccount = createdUser.account;
    inviteTargetIds = (
      await database.db
        .insert(user)
        .values(
          [1, 2, 3].map((n) => ({
            account: `st-target-${n}-${randomUUID().slice(0, 8)}`,
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
    await seedAcceptedRelationship(
      database.db,
      userId,
      inviteTargetIds[2],
      threadId,
    );
  });

  afterAll(async () => {
    await database.pool
      .query('DELETE FROM "AccountThreadState" WHERE "threadId" = $1', [
        threadId,
      ])
      .catch(() => {});
    await database.pool
      .query('DELETE FROM "MessageThread" WHERE id = $1', [threadId])
      .catch(() => {});
    await database.pool
      .query('DELETE FROM "Account" WHERE id = ANY($1)', [
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

  it('admits the request inside the intent transaction: fresh and refreshed requests charge, exhaustion rolls back', async () => {
    await userQuota.setPolicy(userId, { dailyRequestLimit: 2 });
    const targetAccounts: string[] = [];
    for (const id of inviteTargetIds.slice(0, 2)) {
      const target = await database.db.query.account.findFirst({
        where: eq(user.id, id),
        columns: { account: true, domain: true },
      });
      if (!target) throw new Error('invite target is missing');
      targetAccounts.push(target.account);
    }
    const requestWithAdmission = (targetAccount: string, note: string) =>
      userIntents.execute(
        {
          userId,
          decision: 'REQUESTED',
          target: { account: targetAccount, domain: 'local' },
          note,
        },
        { admissionInTx: (tx) => userQuota.tick(userId, 'requests', tx) },
      );

    // The fresh request consumes the daily tick...
    await expect(
      requestWithAdmission(targetAccounts[0], ''),
    ).resolves.toMatchObject({ status: 'APPLIED' });
    // ...and so does a refreshed duplicate: admission runs whenever the
    // composed statement applies (the legacy created-only slot is retired).
    await expect(
      requestWithAdmission(targetAccounts[0], 'updated'),
    ).resolves.toMatchObject({ status: 'APPLIED' });
    // The next admission exceeds the limit and rolls the intent back together
    // with its tick.
    await expect(
      requestWithAdmission(targetAccounts[1], ''),
    ).rejects.toMatchObject({ bizCode: BusinessCode.QUOTA_EXCEEDED });

    const usage = await database.db.query.userQuotaDailyUsage.findFirst({
      where: and(eq(userQuotaDailyUsage.userId, userId), eq(userQuotaDailyUsage.category, 'requests')),
    });
    expect(usage?.count).toBe(2);
    const rolledBackPair = await database.db.query.relationshipPair.findFirst({
      where: or(
        and(
          eq(relationshipPair.endpointAType, 'USER'),
          eq(relationshipPair.endpointAAccount, userAccount),
          eq(relationshipPair.endpointADomain, 'local'),
          eq(relationshipPair.endpointBType, 'USER'),
          eq(relationshipPair.endpointBAccount, targetAccounts[1]),
          eq(relationshipPair.endpointBDomain, 'local'),
        ),
        and(
          eq(relationshipPair.endpointAType, 'USER'),
          eq(relationshipPair.endpointAAccount, targetAccounts[1]),
          eq(relationshipPair.endpointADomain, 'local'),
          eq(relationshipPair.endpointBType, 'USER'),
          eq(relationshipPair.endpointBAccount, userAccount),
          eq(relationshipPair.endpointBDomain, 'local'),
        ),
      ),
    });
    expect(rolledBackPair).toBeUndefined();
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
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.creatorAccount, userAccount),
          eq(message.creatorDomain, 'local'),
        ),
      )
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
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.creatorAccount, userAccount),
          eq(message.creatorDomain, 'local'),
        ),
      );
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
          eq(message.creatorAccount, userAccount),
          eq(message.creatorDomain, 'local'),
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
