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
  mediaAsset,
  mediaMessage,
  message,
  messageThread,
  pendingMedia,
  user,
} from '../src/database/schema';
import { UploadService } from '../src/upload/upload.service';
import { MediaAssetGcService } from '../src/admin/media-asset-gc.service';
import { makePng } from './federation-harness';

/**
 * Phase 5 garbage collection: verify refs<=0 rows are reaped (DB row + shard file) and refs>0 rows
 * are left untouched. Exercises the real CAS write path (saveFile → saveCas + upsertAndRef), then
 * simulates the future message-delete path by forcing refs to 0.
 */
describe('Media asset garbage collection (Phase 5)', () => {
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
      .slice('/uploads/shards/'.length)
      .split('/')
      .pop()!
      .replace(/\.bin$/, '');
    const absPath = join(upload.uploadDir, url.slice('/uploads/'.length));
    return { digest, absPath };
  }

  it('reaps a refs=0 asset — row deleted AND shard file unlinked', async () => {
    const { digest, absPath } = await seedAsset('gc-orphan');
    expect(existsSync(absPath)).toBe(true); // file landed on disk
    // Simulate the future message-delete path: refs → 0 (no real delete endpoint exists yet).
    await database.db
      .update(mediaAsset)
      .set({ refs: 0 })
      .where(eq(mediaAsset.digest, digest));

    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(absPath)).toBe(false); // shard file gone
    expect(
      await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      }),
    ).toBeUndefined(); // row gone
  });

  it('keeps a refs>0 asset — row AND file untouched', async () => {
    const { digest, absPath } = await seedAsset('gc-live'); // refs=1 from upsertAndRef
    expect(existsSync(absPath)).toBe(true);

    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBe(0);
    expect(existsSync(absPath)).toBe(true); // file kept
    const row = await database.db.query.mediaAsset.findFirst({
      where: eq(mediaAsset.digest, digest),
    });
    expect(row).not.toBeNull();
    expect(row?.refs).toBe(1);
    // Cleanup so repeated runs / forks stay deterministic (the file is live, so GC won't take it).
    await database.db
      .delete(mediaAsset)
      .where(eq(mediaAsset.digest, digest))
      .catch(() => {});
    await unlink(absPath).catch(() => {});
  });

  it('detects and manually removes an unreachable forward bundle', async () => {
    const id = `01GC${String(Date.now()).padStart(22, '0').slice(-22)}`;
    const manifest = {
      schemaVersion: 1,
      bundleId: id,
      depth: 1,
      children: [],
      messages: [
        {
          sender: {
            displayName: 'GC fixture',
            account: 'gc',
            domain: 'local',
          },
          contentType: 'PURE_TEXT',
          content: 'orphan',
          sentAt: Date.now(),
        },
      ],
    };
    await database.db.insert(forwardBundle).values({
      id,
      depth: 1,
      manifest,
      manifestDigest: '0'.repeat(64),
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
        hashPwd: 'x',
        name: 'live',
        isForeigner: false,
        avatar: liveUrl,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [user.account, user.domain],
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
  }> {
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account: `gc-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        hashPwd: 'x',
        name: 'gc',
        isForeigner: false,
        updatedAt: new Date(),
      })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    return { threadId: thread.id, userId: createdUser.id };
  }

  it('gcStalePending reaps an abandoned staged send (file + asset + stage) when no message committed', async () => {
    const { digest, absPath } = await seedAsset('stale-pending'); // file on disk + MediaAsset refs=1
    expect(existsSync(absPath)).toBe(true);
    const { threadId, userId } = await seedThreadAndUser();
    // Staged send that never promoted: PendingMedia(pending, digest) and NO MediaMessage.
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorId: userId,
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
    expect(existsSync(absPath)).toBe(false); // orphan file reaped
    expect(
      await database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      }),
    ).toBeUndefined(); // asset row gone
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

  it('gcStalePending keeps the file when a committed MediaMessage references the digest', async () => {
    const { digest, absPath } = await seedAsset('stale-live');
    const { threadId, userId } = await seedThreadAndUser();
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorId: userId,
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
        creator: userId,
        seq: 0,
        originSeq: 0,
        contentType: 'FILE',
        content: '{}',
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(mediaMessage).values({
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
      .delete(mediaMessage)
      .where(eq(mediaMessage.messageId, msg.id))
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
    const { threadId, userId } = await seedThreadAndUser();
    // Just-created stage (createdAt = now) — within TTL → must not be reaped.
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorId: userId,
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
    const { threadId, userId } = await seedThreadAndUser();
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorId: userId,
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
