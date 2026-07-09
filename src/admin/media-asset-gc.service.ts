import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { readdir, unlink } from 'fs';
import { promisify } from 'util';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { parseAvatarBase } from '../upload/avatar-path.js';

const readdirAsync = promisify(readdir);
const unlinkAsync = promisify(unlink);

export interface GcResult {
  /** MediaAsset rows deleted (refs <= 0). */
  reapedRows: number;
  /** Shard files actually unlinked (may be < reapedRows if a file was already missing). */
  reapedFiles: number;
  /** Stale *.tmp files removed (crash leftovers from saveCas's tmp+rename). */
  sweptTmp: number;
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
 * GC scans ONLY uploads/shards/. Avatars (uploads/<base>-<size>.webp) and legacy flat files are never
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

  /** Primary GC: reap MediaAsset rows with refs <= 0 + their shard file, then sweep stale tmp. */
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
    const result: GcResult = { reapedRows: orphans.length, reapedFiles, sweptTmp };
    this.logger.log(
      `gcOrphanedAssets: reaped ${result.reapedRows} row(s), ${reapedFiles} file(s), swept ${sweptTmp} tmp.`,
    );
    return result;
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

  /**
   * Reap orphaned AVATARS — files under uploads/avatars/ (and legacy-flat uploads/<base>-<size>.webp)
   * whose `<base>` is not the current avatar of any User or Group. "Expired" = no longer referenced,
   * NOT a time-based TTL. One rule covers every orphan source:
   *  - superseded-on-replace (avatar changes no longer delete the old files — see UploadService),
   *  - deleted-user avatars (no User row references them),
   *  - dissolved-group avatars (no Group row references them).
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

    let swept = 0;
    // New location: uploads/avatars/<base>-<size>.webp.
    swept += await this.sweepAvatarDir(
      join(this.upload.uploadDir, 'avatars'),
      live,
    );
    // Legacy flat: uploads/<base>-<size>.webp (pre-folder-move). Only flat files in the root —
    // subdirs (avatars/, shards/) are skipped by the isDirectory() guard.
    swept += await this.sweepLegacyFlatAvatars(this.upload.uploadDir, live);

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

  /** Sweep flat avatar files in the uploads root (legacy location): skip subdirs, unlink orphans. */
  private async sweepLegacyFlatAvatars(dir: string, live: Set<string>): Promise<number> {
    let swept = 0;
    try {
      for (const entry of await readdirAsync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) continue; // only flat files; avatars/ + shards/ are subdirs
        const base = parseAvatarBase(entry.name);
        if (base && !live.has(base)) {
          await unlinkAsync(join(dir, entry.name)).catch(() => {});
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
