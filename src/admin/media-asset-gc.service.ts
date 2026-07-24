import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { readdir, stat, unlink } from 'fs';
import { promisify } from 'util';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { parseAvatarBase } from '../upload/avatar-path.js';

const readdirAsync = promisify(readdir);
const statAsync = promisify(stat);
const unlinkAsync = promisify(unlink);

/** A PendingMedia(pending) row older than this is a crashed/abandoned send or localization — reclaim
 *  it (and its orphan file, if any). Generous: a normal upload/localize completes in seconds; this
 *  only sweeps sends that never finished across a long window. */
const STALE_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface GcResult {
  /** MediaAsset rows deleted (refs <= 0). */
  reapedRows: number;
  /** Shard files actually unlinked (may be < reapedRows if a file was already missing). */
  reapedFiles: number;
  /** Stale *.tmp files removed (crash leftovers from saveCas's tmp+rename). */
  sweptTmp: number;
  /** Stale PendingMedia(pending) rows reclaimed (abandoned/crashed sends + localizations past TTL). */
  sweptPending: number;
  /** Orphan shard files reaped via the stale-pending sweep (file written but the message never committed). */
  reapedPendingFiles: number;
}

/**
 * Garbage collection for content-addressed media (Phase 5). The `refs` count on MediaAsset is the
 * authoritative liveness signal: every upload bumps it, a future message-delete path will decrement
 * it, and `refs <= 0` means nothing references the file anymore.
 *
 * Two tiers:
 *  - {@link gcOrphanedAssets} (primary, cheap, indexed): delete rows WHERE refs <= 0 + their shard
 *    file + sweep stale tmp files. This is the daily-cron / manual-trigger path.
 *  - {@link reconcileShards} (corrective, O(files)): walk uploads/shards/ and delete any file whose
 *    digest has no MediaAsset row. Corrects refs drift the cheap scan can't see (e.g. a bug that
 *    deleted a row without unlinking, or vice versa). Run monthly, not on the hot path.
 *
 * GC scans ONLY uploads/shards/. Avatars are never
 * touched — they have no MediaAsset row; avatar overwrite-delete is owned by UploadService.deleteByUrl.
 * `clearHistory` (per-user clearedAt watermark) does NOT decrement refs (confirmed it never touches
 * Message rows or files), so clearing a conversation never reclaims its media.
 */
@Injectable()
export class MediaAssetGcService {
  private readonly logger = new Logger(MediaAssetGcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
  ) {}

  /** Primary GC: reap MediaAsset rows with refs <= 0 + their shard file, sweep stale tmp, and reap
   *  stale PendingMedia(pending) staging rows (abandoned/crashed sends + localizations past TTL) along
   *  with any orphan file they point at. */
  async gcOrphanedAssets(): Promise<GcResult> {
    const orphans = await this.prisma.mediaAsset.findMany({
      where: { refs: { lte: 0 } },
      select: { digest: true },
    });
    let reapedFiles = 0;
    for (const { digest } of orphans) {
      if (await this.reapDigest(digest)) reapedFiles++;
      await this.prisma.mediaAsset.delete({ where: { digest } }).catch(() => {
        // row already gone (concurrent GC) — nothing to do.
      });
    }
    const sweptTmp = await this.sweepTmp();
    const pending = await this.gcStalePending(STALE_PENDING_TTL_MS);
    const result: GcResult = {
      reapedRows: orphans.length,
      reapedFiles,
      sweptTmp,
      sweptPending: pending.sweptRows,
      reapedPendingFiles: pending.reapedFiles,
    };
    this.logger.log(
      `gcOrphanedAssets: reaped ${result.reapedRows} row(s), ${reapedFiles} file(s), swept ${sweptTmp} tmp, ${pending.sweptRows} stale stage(s) (${pending.reapedFiles} file(s)).`,
    );
    return result;
  }

  /**
   * Reap stale PendingMedia(pending) rows — staged media sends/localizations that never committed (a
   * crash between stage and promote, or a localize that hung) past `ttlMs`. This is the orphan-cleanup
   * handle that did not exist before PendingMedia: the staging row, created BEFORE the file write,
   * makes an abandoned upload attributable and reclaimable instead of a mystery file on disk.
   *
   * For each stale stage: if it carries a digest, reap the shard file + MediaAsset row ONLY when no
   * committed MediaMessage references that digest (a committed message keeps the file live). A stage
   * without a digest (the upload never wrote a file) just drops the row. The TTL protects fresh
   * in-flight sends from ever being reaped.
   */
  async gcStalePending(
    ttlMs: number,
  ): Promise<{ sweptRows: number; reapedFiles: number }> {
    const cutoff = new Date(Date.now() - ttlMs);
    const stale = await this.prisma.pendingMedia.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true, digest: true },
    });
    let reapedFiles = 0;
    for (const { id, digest } of stale) {
      if (digest) {
        // Reap the file only if NO committed message references this digest — a MediaMessage row means
        // the file is live (some other send/localize committed and is using it).
        const inUse = await this.prisma.mediaMessage.findFirst({
          where: { digest },
          select: { messageId: true },
        });
        if (!inUse) {
          if (await this.reapDigest(digest)) reapedFiles++;
          await this.prisma.mediaAsset
            .deleteMany({ where: { digest } })
            .catch(() => {
              // row already gone — nothing to do.
            });
        }
      }
      await this.prisma.pendingMedia.delete({ where: { id } }).catch(() => {
        // row already gone (concurrent sweep) — nothing to do.
      });
    }
    this.logger.log(
      `gcStalePending: swept ${stale.length} stale stage(s), reaped ${reapedFiles} orphan file(s).`,
    );
    return { sweptRows: stale.length, reapedFiles };
  }

  /** Walk uploads/shards/ and delete any file whose digest has no MediaAsset row. Corrects refs drift.
   *  O(files) — run sparingly (monthly). Skips *.tmp (those are swept by gcOrphanedAssets). */
  async reconcileShards(): Promise<number> {
    const shardsDir = join(this.upload.uploadDir, 'shards');
    const referenced = new Set(
      (await this.prisma.mediaAsset.findMany({ select: { digest: true } })).map((r) => r.digest),
    );
    let reaped = 0;
    try {
      for (const a of await readdirAsync(shardsDir, { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        const aDir = join(shardsDir, a.name);
        for (const b of await readdirAsync(aDir, { withFileTypes: true })) {
          if (!b.isDirectory()) continue;
          const bDir = join(aDir, b.name);
          for (const name of await readdirAsync(bDir)) {
            if (name.endsWith('.tmp') || name.includes('.tmp.')) continue;
            const dot = name.lastIndexOf('.');
            const digest = dot > 0 ? name.slice(0, dot) : name;
            if (!referenced.has(digest)) {
              await unlinkAsync(join(bDir, name)).catch(() => {});
              reaped++;
            }
          }
        }
      }
    } catch {
      // shards dir missing — nothing to reconcile.
    }
    this.logger.log(`reconcileShards: reaped ${reaped} unreferenced file(s).`);
    return reaped;
  }

  /** Storage overview for the media page. `db` is the authoritative content size from MediaAsset
   *  (deduped by digest); `onDisk` walks uploads/shards/ to break bytes down by extension and surface
   *  drift vs the table. O(files) — fine for a manually triggered admin read. */
  async stats() {
    const agg = await this.prisma.mediaAsset.aggregate({
      _sum: { bytes: true },
      _count: true,
    });
    const reclaimable = await this.prisma.mediaAsset.count({
      where: { refs: { lte: 0 } },
    });

    const shardsDir = join(this.upload.uploadDir, 'shards');
    const byExt = new Map<string, { files: number; bytes: bigint }>();
    let shardFiles = 0;
    let shardBytes = 0n;
    try {
      for (const a of await readdirAsync(shardsDir, { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        const aDir = join(shardsDir, a.name);
        for (const b of await readdirAsync(aDir, { withFileTypes: true })) {
          if (!b.isDirectory()) continue;
          const bDir = join(aDir, b.name);
          for (const name of await readdirAsync(bDir)) {
            const s = await statAsync(join(bDir, name)).catch(() => null);
            if (!s) continue;
            const dot = name.lastIndexOf('.');
            const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '(none)';
            const bucket = byExt.get(ext) ?? { files: 0, bytes: 0n };
            bucket.files++;
            bucket.bytes += BigInt(s.size);
            byExt.set(ext, bucket);
            shardFiles++;
            shardBytes += BigInt(s.size);
          }
        }
      }
    } catch {
      // shards dir missing → empty onDisk breakdown.
    }

    return {
      db: { bytes: agg._sum.bytes ?? 0n, assetCount: agg._count, reclaimable },
      onDisk: {
        files: shardFiles,
        bytes: shardBytes,
        byExt: [...byExt.entries()]
          .map(([ext, v]) => ({ ext, files: v.files, bytes: v.bytes }))
          .sort((x, y) => (x.bytes > y.bytes ? -1 : x.bytes < y.bytes ? 1 : 0)),
      },
    };
  }

  /**
   * Reap orphaned AVATARS — files under uploads/avatars/ whose `<base>` is not the current avatar of
   * any User. "Expired" = no longer referenced, NOT a time-based TTL. One rule covers every orphan
   * source:
   *  - superseded-on-replace (avatar changes no longer delete the old files — see UploadService),
   *  - deleted-user avatars (no User row references them).
   * The multi-size family ([32,64,128,256,512]) is handled by keying on `<base>`: all 5 sizes of a
   * live base are kept, all 5 of a dead base are swept together. NEVER touches uploads/shards/ (that
   * is gcOrphanedAssets' domain via MediaAsset.refs).
   */
  async gcOrphanedAvatars(): Promise<{ sweptFiles: number }> {
    // Live `<base>` set from the two avatar columns. parseAvatarBase strips the size + path, so all 5
    // sizes of one logical avatar collapse to one key.
    // Group avatars live on the `!`-User rows now (Group table abolished), so this single User query
    // covers both people and group avatars.
    const users = await this.prisma.user.findMany({
      where: { NOT: { avatar: '' } },
      select: { avatar: true },
    });
    const live = new Set<string>();
    for (const r of users) {
      const base = parseAvatarBase(r.avatar);
      if (base) live.add(base);
    }

    // Orphan sweep: uploads/avatars/<base>-<size>.webp whose base is not live.
    const swept = await this.sweepAvatarDir(
      join(this.upload.uploadDir, 'avatars'),
      live,
    );

    this.logger.log(`gcOrphanedAvatars: swept ${swept} orphaned avatar file(s).`);
    return { sweptFiles: swept };
  }

  /** Sweep one avatar directory: unlink every `<base>-<size>.webp` whose base is not live. */
  private async sweepAvatarDir(dir: string, live: Set<string>): Promise<number> {
    let swept = 0;
    try {
      for (const name of await readdirAsync(dir)) {
        const base = parseAvatarBase(name); // bare filename → AVATAR_FILE_RE
        if (base && !live.has(base)) {
          await unlinkAsync(join(dir, name)).catch(() => {});
          swept++;
        }
      }
    } catch {
      // dir missing — nothing to sweep.
    }
    return swept;
  }

  /** Delete the shard file(s) for a digest. The on-disk ext is NOT stored on MediaAsset, so glob
   *  `<digest>.*` inside its 2-level bucket. Returns true if any file was removed. */
  private async reapDigest(digest: string): Promise<boolean> {
    const dir = join(
      this.upload.uploadDir,
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
    );
    let removed = false;
    try {
      for (const name of await readdirAsync(dir)) {
        if (name.startsWith(`${digest}.`)) {
          await unlinkAsync(join(dir, name)).catch(() => {});
          removed = true;
        }
      }
    } catch {
      // bucket dir missing — file already gone.
    }
    return removed;
  }

  /** Recursively remove stale `*.tmp` / `*.tmp.*` files under shards/ (left by a crash between
   *  saveCas's tmp write and its atomic rename). */
  private async sweepTmp(): Promise<number> {
    const shardsDir = join(this.upload.uploadDir, 'shards');
    let swept = 0;
    const sweep = async (dir: string): Promise<void> => {
      try {
        for (const entry of await readdirAsync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await sweep(full);
          } else if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp.')) {
            await unlinkAsync(full).catch(() => {});
            swept++;
          }
        }
      } catch {
        // dir missing — nothing to sweep.
      }
    };
    await sweep(shardsDir);
    return swept;
  }
}
