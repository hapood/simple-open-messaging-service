import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
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
      where: { uniqName_domain: { uniqName: 'avatar-gc-live', domain: 'local' } },
      create: {
        uniqName: 'avatar-gc-live',
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
        where: { uniqName_domain: { uniqName: 'avatar-gc-live', domain: 'local' } },
      })
      .catch(() => {});
  });
});
