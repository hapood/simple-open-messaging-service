/**
 * One-time migration: move every group avatar that currently points at /uploads/shards/... (a CAS
 * chat-media URL, from before the dedicated avatar folder) into uploads/avatars/ via the real sharp
 * multi-size avatar pipeline, and point Group.avatar at the new URL.
 *
 * WHY: the per-object media-authz gate (bootstrap.ts) authorizes /uploads/shards/ by thread
 * membership. A group avatar has no owning Message, so any group avatar still on shards/ would 401
 * in every group list/header once the gate ships. Avatars now live in uploads/avatars/ (outside the
 * gate's shards/ scope). This script moves the pre-existing ones so nothing breaks at deploy.
 *
 * WHAT IT DOES per matching group:
 *   1. read the shard file bytes,
 *   2. saveAvatars(buf) → writes uploads/avatars/<base>-<size>.webp, returns the representative URL,
 *   3. update Group.avatar to that URL,
 *   4. mediaAsset.decrement(digest) → the shard's ref (bumped at the original /upload) drops to 0,
 *      so a later `POST admin/media/gc` reaps the now-orphan shard file.
 *
 * Idempotent: groups whose avatar is already /uploads/avatars/ (or legacy flat, or empty) are skipped.
 * Dry-run with MIGRATE_DRY_RUN=1 to preview without writing.
 *
 *   npx tsx scripts/migrate-group-avatars.ts
 *   MIGRATE_DRY_RUN=1 npx tsx scripts/migrate-group-avatars.ts
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../src/prisma.service.js';
import { UploadService } from '../src/upload/upload.service.js';
import { MediaAssetService } from '../src/upload/media-asset.service.js';

/** Matches a CAS shard URL and captures the 64-hex digest. */
const SHARD_RE = /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\./;

/** Minimal DI context — just the three services this script needs. Avoids booting the full AppModule
 *  (no SSE/federation/scheduler side effects) for a one-shot migration. */
@Module({
  providers: [UploadService, MediaAssetService, PrismaService],
})
class MigrationModule {}

async function main() {
  const dryRun = process.env.MIGRATE_DRY_RUN === '1';
  const app = await NestFactory.createApplicationContext(MigrationModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const upload = app.get(UploadService);
  const mediaAsset = app.get(MediaAssetService);

  const groups = await prisma.group.findMany({});
  let migrated = 0;
  let skipped = 0;
  let missing = 0;

  for (const g of groups) {
    const m = SHARD_RE.exec(g.avatar);
    if (!m) {
      skipped++; // already avatars/, legacy flat, or empty — nothing to do
      continue;
    }
    const digest = m[1];
    const shardPath = join(upload.uploadDir, g.avatar.slice('/uploads/'.length));
    let buf: Buffer;
    try {
      buf = await readFile(shardPath);
    } catch {
      console.warn(`[missing] Group ${g.id}: shard file not on disk (${shardPath}); leaving avatar as-is`);
      missing++;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] Group ${g.id}: would migrate ${digest.slice(0, 8)}… → uploads/avatars/`);
      migrated++;
      continue;
    }
    const newUrl = await upload.saveAvatars(buf);
    await prisma.group.update({ where: { id: g.id }, data: { avatar: newUrl } });
    await mediaAsset.decrement(digest);
    migrated++;
    console.log(`[ok] Group ${g.id}: ${digest.slice(0, 8)}… → ${newUrl}`);
  }

  console.log(
    `\nDone${dryRun ? ' (dry-run)' : ''}: migrated=${migrated}, skipped(non-shard)=${skipped}, missing(file)=${missing}, total groups=${groups.length}`,
  );
  await app.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
