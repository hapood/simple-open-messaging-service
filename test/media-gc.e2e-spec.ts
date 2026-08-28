import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  forwardBundle,
  federatedMessageTombstone,
  mediaAsset,
  messageAsset,
  message,
  messageThread,
  pendingMedia,
  user,
} from '../src/database/schema';
import { UploadService } from '../src/upload/upload.service';
import { MediaAssetGcService } from '../src/admin/media-asset-gc.service';
import { makePng } from './federation-harness';

/**
 * Manual CAS cleanup derives liveness from non-deleted ordinary messages and active staging.
 * PENDING assets are never age-reaped and remain available for explicit administrator review.
 */
describe('Media asset garbage collection', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let upload: UploadService;
  let gc: MediaAssetGcService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    upload = app.get(UploadService);
    gc = app.get(MediaAssetGcService);
    await database.db.execute(
      sql`TRUNCATE TABLE "MediaAsset" RESTART IDENTITY`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Store a real shard file through CAS (refs=1); return its digest + absolute path. */
  async function seedAsset(
    content: string,
  ): Promise<{ digest: string; absPath: string }> {
    const { url } = await upload.saveFile(
      'application/octet-stream',
      'gc.bin',
      Buffer.from(content),
    );
    const digest = url
      .slice('/uploads/msg-assets/'.length)
      .split('/')
      .pop()!
      .replace(/\.bin$/, '');
    const absPath = join(
      upload.casDir,
      url.slice('/uploads/msg-assets/'.length),
    );
    return { digest, absPath };
  }

  it('lists pending federated deletions without mutating them', async () => {
    const { threadId } = await seedThreadAndUser();
    const [pending] = await database.db
      .insert(federatedMessageTombstone)
      .values({
        threadId,
        messageSeq: 7,
        authorityDomain: 'origin.test',
        sourceDomain: 'origin.test',
        remoteDeletionSeq: 42,
        type: 'USER_RETRACTION',
      })
      .returning();

    const result = await gc.listPendingFederatedDeletions(0, 20);

    expect(result.list).toContainEqual(
      expect.objectContaining({
        id: pending.id.toString(),
        originSeq: 7,
        authorityDomain: 'origin.test',
        sourceDomain: 'origin.test',
        remoteDeletionSeq: 42,
        matchedMessage: null,
      }),
    );
    expect(
      await database.db.query.federatedMessageTombstone.findFirst({
        where: eq(federatedMessageTombstone.id, pending.id),
      }),
    ).toBeDefined();
  });

  it('reaps a READY asset unused by messages or staging', async () => {
    const { digest, absPath } = await seedAsset('gc-orphan');
    expect(existsSync(absPath)).toBe(true); // file landed on disk
    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(absPath)).toBe(false); // shard file gone
    const tombstone = await database.db.query.mediaAsset.findFirst({
      where: eq(mediaAsset.digest, digest),
    });
    expect(tombstone?.isDeleted).toBe(true);
  });

  it('keeps an asset protected by active staging', async () => {
    const { digest, absPath } = await seedAsset('gc-live');
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        contentType: 'FILE',
        content: '{}',
        digest,
        clientMessageId: randomUUID(),
        updatedAt: new Date(),
      })
      .returning();
    expect(existsSync(absPath)).toBe(true);

    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBe(0);
    expect(existsSync(absPath)).toBe(true); // file kept
    const row = await database.db.query.mediaAsset.findFirst({
      where: eq(mediaAsset.digest, digest),
    });
    expect(row).not.toBeNull();
    expect(row?.isDeleted).toBe(false);
    // Cleanup so repeated runs / forks stay deterministic (the file is live, so GC won't take it).
    await database.db
      .delete(mediaAsset)
      .where(eq(mediaAsset.digest, digest))
      .catch(() => {});
    await unlink(absPath).catch(() => {});
    await database.db.delete(pendingMedia).where(eq(pendingMedia.id, stage.id));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId))
      .catch(() => {});
    await database.db
      .delete(user)
      .where(eq(user.id, userId))
      .catch(() => {});
  });

  it('revives a DELETED tombstone when the same bytes are uploaded again', async () => {
    const content = 'gc-reupload';
    const first = await seedAsset(content);
    await gc.gcOrphanedAssets();
    expect(existsSync(first.absPath)).toBe(false);

    const second = await seedAsset(content);
    expect(second.digest).toBe(first.digest);
    expect(existsSync(second.absPath)).toBe(true);
    expect(
      await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, first.digest),
      }),
    ).toMatchObject({ isDeleted: false });
  });

  it('keeps assets referenced by pending and failed staging for administrator review', async () => {
    const fresh = await seedAsset('gc-pending');
    const failed = await seedAsset('gc-failed');
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    const now = new Date();
    const stages = await database.db
      .insert(pendingMedia)
      .values([
        {
          threadId,
          creatorAccount: account,
          creatorDomain: domain,
          contentType: 'FILE',
          content: '{}',
          digest: fresh.digest,
          clientMessageId: randomUUID(),
          status: 'pending',
          updatedAt: now,
        },
        {
          threadId,
          creatorAccount: account,
          creatorDomain: domain,
          contentType: 'FILE',
          content: '{}',
          digest: failed.digest,
          clientMessageId: randomUUID(),
          status: 'failed',
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          updatedAt: now,
        },
      ])
      .returning({ id: pendingMedia.id });

    await gc.gcOrphanedAssets();

    for (const digest of [fresh.digest, failed.digest]) {
      await expect(
        database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        }),
      ).resolves.toMatchObject({ isDeleted: false });
    }

    await database.db.delete(pendingMedia).where(
      sql`${pendingMedia.id} IN (${sql.join(
        stages.map(({ id }) => sql`${id}`),
        sql`, `,
      )})`,
    );
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(user).where(eq(user.id, userId));
    await Promise.all([unlink(fresh.absPath), unlink(failed.absPath)]);
  });

  it('serializes maintenance tasks in memory and cooperatively cancels a running task', async () => {
    const task = gc.startTask('reconcile');
    expect(() => gc.startTask('gc')).toThrow('already running');

    expect(gc.cancelTask(task.id).status).toBe('cancelling');
    for (let i = 0; i < 100; i++) {
      const current = gc.getTask(task.id);
      if (['cancelled', 'completed', 'failed'].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gc.getTask(task.id)).toMatchObject({
      id: task.id,
      kind: 'reconcile',
      status: 'cancelled',
    });
  });

  it('detects and manually removes an unreachable forward bundle', async () => {
    const id = `01GC${String(Date.now()).padStart(22, '0').slice(-22)}`;
    const messages = [
      {
        id: 1,
        author: {
          displayName: 'GC fixture',
          account: 'gc',
          domain: 'local',
        },
        contentType: 'PURE_TEXT',
        content: 'orphan',
        sentAt: Date.now(),
      },
    ];
    await database.db.insert(forwardBundle).values({
      id,
      messages,
      messageCount: 1,
      assetCount: 0,
      totalBytes: 0n,
    });

    const inspected = await gc.inspectOrphanedForwardBundles();
    expect(inspected.orphanBundles).toBeGreaterThanOrEqual(1);
    const cleaned = await gc.gcOrphanedForwardBundles();
    expect(cleaned.orphanBundles).toBeGreaterThanOrEqual(1);
    expect(
      await database.db.query.forwardBundle.findFirst({
        where: eq(forwardBundle.id, id),
      }),
    ).toBeUndefined();
  });

  it('gcOrphanedAvatars reaps superseded avatars and keeps the live one', async () => {
    // Two avatars via the real pipeline — each writes 5 webp sizes to uploads/avatars/ under a unique
    // base (saveAvatars mints Date.now()+random, so identical bytes still produce distinct files).
    // makePng: a sharp-generated PNG (saveAvatars DECODES via sharp; hand-written base64 PNGs throw).
    const png = await makePng(123);
    const liveUrl = await upload.saveAvatars(png);
    const orphanUrl = await upload.saveAvatars(png);
    // `liveUrl` is the CURRENT avatar of a user → live; `orphanUrl` references nothing → expired.
    await database.db
      .insert(user)
      .values({
        account: 'avatar-gc-live',
        domain: 'local',
        sourceDomain: 'local',
        name: 'live',
        avatar: liveUrl,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [user.account, user.domain, user.sourceDomain],
        set: { avatar: liveUrl, updatedAt: new Date() },
      });
    const livePath = join(upload.uploadDir, liveUrl.slice('/uploads/'.length));
    const orphanPath = join(
      upload.uploadDir,
      orphanUrl.slice('/uploads/'.length),
    );
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);

    await gc.gcOrphanedAvatars();

    expect(existsSync(livePath)).toBe(true); // referenced by a User → kept
    expect(existsSync(orphanPath)).toBe(false); // superseded, referenced by nothing → reaped

    // Cleanup the live user so repeated runs / forks stay deterministic.
    await database.db
      .delete(user)
      .where(eq(user.account, 'avatar-gc-live'))
      .catch(() => {});
  });

  // ── PendingMedia stale-pending sweep ─────────────────────────────────────────────────────────
  // A staged media send whose upload/localize never completed (crash/abandon) leaves a PendingMedia
  // row created BEFORE the file write. The sweep reaps it past TTL — the orphan-cleanup handle that
  // did not exist before PendingMedia. Helper: seed a thread + user for the FKs.
  async function seedThreadAndUser(): Promise<{
    threadId: number;
    userId: number;
    account: string;
    domain: string;
  }> {
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account: `gc-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        hashPwd: 'x',
        name: 'gc',
        updatedAt: new Date(),
      })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    return {
      threadId: thread.id,
      userId: createdUser.id,
      account: createdUser.account,
      domain: createdUser.domain,
    };
  }

  it('gcStalePending removes staging but leaves space reclamation to manual GC', async () => {
    const { digest, absPath } = await seedAsset('stale-pending'); // file on disk + MediaAsset refs=1
    expect(existsSync(absPath)).toBe(true);
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    // Staged send that never promoted: PendingMedia(pending, digest) and NO MediaMessage.
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        contentType: 'FILE',
        content: '{}',
        digest,
        clientMessageId: randomUUID(),
        updatedAt: new Date(),
      })
      .returning();
    // Backdate past the TTL so the sweep reaps it now.
    await database.db
      .update(pendingMedia)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(pendingMedia.id, stage.id));

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(absPath)).toBe(true);
    expect(
      await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      }),
    ).toMatchObject({ isDeleted: false });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, stage.id),
      }),
    ).toBeUndefined(); // stage gone
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId))
      .catch(() => {});
    await database.db
      .delete(user)
      .where(eq(user.id, userId))
      .catch(() => {});
  });

  it('cleanInboxBatch recursively deletes quotes waiting on the abandoned target', async () => {
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    const originDomain = 'quote-gc.example';
    const [target, quote, nestedQuote] = await database.db
      .insert(pendingMedia)
      .values([
        {
          threadId,
          creatorAccount: account,
          creatorDomain: domain,
          contentType: 'FILE' as const,
          content: '{}',
          originSeq: 10,
          originDomain,
          direction: 'INBOUND' as const,
          updatedAt: new Date(),
        },
        {
          threadId,
          creatorAccount: account,
          creatorDomain: domain,
          contentType: 'PURE_TEXT' as const,
          content: JSON.stringify({ text: 'quote' }),
          originSeq: 11,
          originDomain,
          dependsOnOriginSeq: 10,
          direction: 'INBOUND' as const,
          fileCnt: 0,
          updatedAt: new Date(),
        },
        {
          threadId,
          creatorAccount: account,
          creatorDomain: domain,
          contentType: 'PURE_TEXT' as const,
          content: JSON.stringify({ text: 'nested quote' }),
          originSeq: 12,
          originDomain,
          dependsOnOriginSeq: 11,
          direction: 'INBOUND' as const,
          fileCnt: 0,
          updatedAt: new Date(),
        },
      ])
      .returning();

    await expect(gc.cleanInboxBatch(target.batchId)).resolves.toMatchObject({
      clearedBatch: true,
      clearedDependents: 2,
    });
    for (const stage of [target, quote, nestedQuote]) {
      expect(
        await database.db.query.pendingMedia.findFirst({
          where: eq(pendingMedia.id, stage.id),
        }),
      ).toBeUndefined();
    }

    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(user).where(eq(user.id, userId));
  });

  it('gcStalePending keeps the file when a committed MediaMessage references the digest', async () => {
    const { digest, absPath } = await seedAsset('stale-live');
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        contentType: 'FILE',
        content: '{}',
        digest,
        clientMessageId: randomUUID(),
        updatedAt: new Date(),
      })
      .returning();
    // A committed message DOES reference this digest (MediaMessage row) → the file is live.
    const [msg] = await database.db
      .insert(message)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        seq: 1,
        originSeq: 1,
        contentType: 'FILE',
        content: '{}',
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(messageAsset).values({
      messageId: msg.id,
      threadId,
      digest,
    });
    await database.db
      .update(pendingMedia)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(pendingMedia.id, stage.id));

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBeGreaterThanOrEqual(1); // the stale stage row is still swept
    expect(existsSync(absPath)).toBe(true); // but the file is KEPT (a live message references it)
    expect(
      await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      }),
    ).toBeDefined();
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, stage.id),
      }),
    ).toBeUndefined();
    // cleanup
    await database.db
      .delete(messageAsset)
      .where(eq(messageAsset.messageId, msg.id))
      .catch(() => {});
    await database.db
      .delete(message)
      .where(eq(message.id, msg.id))
      .catch(() => {});
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId))
      .catch(() => {});
    await database.db
      .delete(user)
      .where(eq(user.id, userId))
      .catch(() => {});
    await database.db
      .delete(mediaAsset)
      .where(eq(mediaAsset.digest, digest))
      .catch(() => {});
    await unlink(absPath).catch(() => {});
  });

  it('gcStalePending leaves fresh (in-flight) staged sends untouched', async () => {
    const { digest, absPath } = await seedAsset('stale-fresh');
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    // Just-created stage (createdAt = now) — within TTL → must not be reaped.
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        contentType: 'FILE',
        content: '{}',
        digest,
        clientMessageId: randomUUID(),
        updatedAt: new Date(),
      })
      .returning();

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBe(0);
    expect(existsSync(absPath)).toBe(true); // kept
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, stage.id),
      }),
    ).toBeDefined();
    // cleanup
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.id, stage.id))
      .catch(() => {});
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId))
      .catch(() => {});
    await database.db
      .delete(user)
      .where(eq(user.id, userId))
      .catch(() => {});
    await database.db
      .delete(mediaAsset)
      .where(eq(mediaAsset.digest, digest))
      .catch(() => {});
    await unlink(absPath).catch(() => {});
  });

  it('gcStalePending retains recent failed stages for recovery and eventually reaps them', async () => {
    const { threadId, userId, account, domain } = await seedThreadAndUser();
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorAccount: account,
        creatorDomain: domain,
        contentType: 'FILE',
        content: '{}',
        clientMessageId: randomUUID(),
        status: 'failed',
        failReason: 'invalid file type',
        updatedAt: new Date(),
      })
      .returning();

    expect((await gc.gcStalePending(1, 60 * 60 * 1000)).sweptRows).toBe(0);
    await database.db
      .update(pendingMedia)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(pendingMedia.id, stage.id));
    expect((await gc.gcStalePending(1, 60 * 60 * 1000)).sweptRows).toBe(1);
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, stage.id),
      }),
    ).toBeUndefined();
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId))
      .catch(() => {});
    await database.db
      .delete(user)
      .where(eq(user.id, userId))
      .catch(() => {});
  });
});
