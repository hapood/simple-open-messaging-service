import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
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
  let prisma: PrismaService;
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
    prisma = app.get(PrismaService);
    upload = app.get(UploadService);
    gc = app.get(MediaAssetGcService);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "MediaAsset" RESTART IDENTITY');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Store a real shard file through CAS (refs=1); return its digest + absolute path. */
  async function seedAsset(content: string): Promise<{ digest: string; absPath: string }> {
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
    await prisma.mediaAsset.update({ where: { digest }, data: { refs: 0 } });

    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(absPath)).toBe(false); // shard file gone
    expect(await prisma.mediaAsset.findUnique({ where: { digest } })).toBeNull(); // row gone
  });

  it('keeps a refs>0 asset — row AND file untouched', async () => {
    const { digest, absPath } = await seedAsset('gc-live'); // refs=1 from upsertAndRef
    expect(existsSync(absPath)).toBe(true);

    const result = await gc.gcOrphanedAssets();

    expect(result.reapedRows).toBe(0);
    expect(existsSync(absPath)).toBe(true); // file kept
    const row = await prisma.mediaAsset.findUnique({ where: { digest } });
    expect(row).not.toBeNull();
    expect(row?.refs).toBe(1);
    // Cleanup so repeated runs / forks stay deterministic (the file is live, so GC won't take it).
    await prisma.mediaAsset.delete({ where: { digest } }).catch(() => {});
    await unlink(absPath).catch(() => {});
  });

  it('gcOrphanedAvatars reaps superseded avatars and keeps the live one', async () => {
    // Two avatars via the real pipeline — each writes 5 webp sizes to uploads/avatars/ under a unique
    // base (saveAvatars mints Date.now()+random, so identical bytes still produce distinct files).
    // makePng: a sharp-generated PNG (saveAvatars DECODES via sharp; hand-written base64 PNGs throw).
    const png = await makePng(123);
    const liveUrl = await upload.saveAvatars(png);
    const orphanUrl = await upload.saveAvatars(png);
    // `liveUrl` is the CURRENT avatar of a user → live; `orphanUrl` references nothing → expired.
    await prisma.user.upsert({
      where: { account_domain: { account: 'avatar-gc-live', domain: 'local' } },
      create: {
        account: 'avatar-gc-live',
        domain: 'local',
        hashPwd: 'x',
        name: 'live',
        isForeigner: false,
        avatar: liveUrl,
      },
      update: { avatar: liveUrl },
    });
    const livePath = join(upload.uploadDir, liveUrl.slice('/uploads/'.length));
    const orphanPath = join(upload.uploadDir, orphanUrl.slice('/uploads/'.length));
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);

    await gc.gcOrphanedAvatars();

    expect(existsSync(livePath)).toBe(true); // referenced by a User → kept
    expect(existsSync(orphanPath)).toBe(false); // superseded, referenced by nothing → reaped

    // Cleanup the live user so repeated runs / forks stay deterministic.
    await prisma.user
      .delete({
        where: { account_domain: { account: 'avatar-gc-live', domain: 'local' } },
      })
      .catch(() => {});
  });

  // ── PendingMedia stale-pending sweep ─────────────────────────────────────────────────────────
  // A staged media send whose upload/localize never completed (crash/abandon) leaves a PendingMedia
  // row created BEFORE the file write. The sweep reaps it past TTL — the orphan-cleanup handle that
  // did not exist before PendingMedia. Helper: seed a thread + user for the FKs.
  async function seedThreadAndUser(): Promise<{ threadId: number; userId: number }> {
    const user = await prisma.user.create({
      data: { account: `gc-${randomUUID().replace(/-/g, '').slice(0, 8)}`, hashPwd: 'x', name: 'gc', isForeigner: false },
    });
    const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
    return { threadId: thread.id, userId: user.id };
  }

  it('gcStalePending reaps an abandoned staged send (file + asset + stage) when no message committed', async () => {
    const { digest, absPath } = await seedAsset('stale-pending'); // file on disk + MediaAsset refs=1
    expect(existsSync(absPath)).toBe(true);
    const { threadId, userId } = await seedThreadAndUser();
    // Staged send that never promoted: PendingMedia(pending, digest) and NO MediaMessage.
    const stage = await prisma.pendingMedia.create({
      data: {
        threadId, creatorId: userId, contentType: 'FILE', content: '{}',
        digest, clientMessageId: randomUUID(),
      },
    });
    // Backdate past the TTL so the sweep reaps it now.
    await prisma.pendingMedia.update({
      where: { id: stage.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(absPath)).toBe(false); // orphan file reaped
    expect(await prisma.mediaAsset.findUnique({ where: { digest } })).toBeNull(); // asset row gone
    expect(await prisma.pendingMedia.findUnique({ where: { id: stage.id } })).toBeNull(); // stage gone
    await prisma.messageThread.delete({ where: { id: threadId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it('gcStalePending keeps the file when a committed MediaMessage references the digest', async () => {
    const { digest, absPath } = await seedAsset('stale-live');
    const { threadId, userId } = await seedThreadAndUser();
    const stage = await prisma.pendingMedia.create({
      data: {
        threadId, creatorId: userId, contentType: 'FILE', content: '{}',
        digest, clientMessageId: randomUUID(),
      },
    });
    // A committed message DOES reference this digest (MediaMessage row) → the file is live.
    const msg = await prisma.message.create({
      data: {
        threadId, creator: userId, seq: 0, originSeq: 0,
        contentType: 'FILE', content: '{}',
      },
    });
    await prisma.mediaMessage.create({ data: { messageId: msg.id, threadId, digest } });
    await prisma.pendingMedia.update({
      where: { id: stage.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBeGreaterThanOrEqual(1); // the stale stage row is still swept
    expect(existsSync(absPath)).toBe(true); // but the file is KEPT (a live message references it)
    expect(await prisma.mediaAsset.findUnique({ where: { digest } })).not.toBeNull();
    expect(await prisma.pendingMedia.findUnique({ where: { id: stage.id } })).toBeNull();
    // cleanup
    await prisma.mediaMessage.delete({ where: { messageId: msg.id } }).catch(() => {});
    await prisma.message.delete({ where: { id: msg.id } }).catch(() => {});
    await prisma.messageThread.delete({ where: { id: threadId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.mediaAsset.delete({ where: { digest } }).catch(() => {});
    await unlink(absPath).catch(() => {});
  });

  it('gcStalePending leaves fresh (in-flight) staged sends untouched', async () => {
    const { digest, absPath } = await seedAsset('stale-fresh');
    const { threadId, userId } = await seedThreadAndUser();
    // Just-created stage (createdAt = now) — within TTL → must not be reaped.
    const stage = await prisma.pendingMedia.create({
      data: {
        threadId, creatorId: userId, contentType: 'FILE', content: '{}',
        digest, clientMessageId: randomUUID(),
      },
    });

    const result = await gc.gcStalePending(60 * 60 * 1000);

    expect(result.sweptRows).toBe(0);
    expect(existsSync(absPath)).toBe(true); // kept
    expect(await prisma.pendingMedia.findUnique({ where: { id: stage.id } })).not.toBeNull();
    // cleanup
    await prisma.pendingMedia.delete({ where: { id: stage.id } }).catch(() => {});
    await prisma.messageThread.delete({ where: { id: threadId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.mediaAsset.delete({ where: { digest } }).catch(() => {});
    await unlink(absPath).catch(() => {});
  });
});
