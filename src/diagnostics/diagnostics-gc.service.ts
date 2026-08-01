import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readdir, unlink } from 'fs';
import { promisify } from 'util';
import { and, eq, lt, ne } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { diagnosticsReport } from '../database/schema.js';
import { DiagnosticsService } from './diagnostics.service.js';

const readdirAsync = promisify(readdir);
const unlinkAsync = promisify(unlink);

/** Default report retention (days). Configurable per-call; a SystemSetting hook can override later. */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Garbage collection for diagnostic bundles, mirroring MediaAssetGcService's shape. Uploaded blobs ARE
 * hard-deletable (unlike DB rows, which are soft-deleted), so expired reports both set isDeleted AND
 * unlink their file. A file shared by identical bundles (same sha256) is unlinked only once no remaining
 * row references it. Admin-triggered (POST admin/diagnostics/gc); a daily @Cron can be wired later,
 * matching the media-GC posture.
 */
@Injectable()
export class DiagnosticsGcService {
  private readonly logger = new Logger(DiagnosticsGcService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  /** Soft-delete reports older than retention + unlink their bundle when nothing else references it. */
  async gcExpiredReports(
    retentionDays = DEFAULT_RETENTION_DAYS,
  ): Promise<{ rows: number; files: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const expired = await this.database.db
      .select({
        id: diagnosticsReport.id,
        bundlePath: diagnosticsReport.bundlePath,
      })
      .from(diagnosticsReport)
      .where(
        and(
          lt(diagnosticsReport.createdAt, cutoff),
          eq(diagnosticsReport.isDeleted, false),
        ),
      );
    let files = 0;
    for (const { id, bundlePath } of expired) {
      await this.database.db
        .update(diagnosticsReport)
        .set({ isDeleted: true, updatedAt: new Date() })
        .where(eq(diagnosticsReport.id, id));
      if (await this.unlinkBundleIfUnreferenced(bundlePath, id)) files++;
    }
    this.logger.log(
      `gcExpiredReports: soft-deleted ${expired.length} row(s), unlinked ${files} file(s).`,
    );
    return { rows: expired.length, files };
  }

  /** Walk data/diagnostics/ and unlink any bundle file with no non-deleted row. Corrects drift (a row
   *  deleted without unlinking, or a half-written upload whose row insert failed). O(files). */
  async gcOrphanedBundles(): Promise<{ files: number }> {
    let entries: string[];
    try {
      entries = await readdirAsync(this.diagnostics.dir);
    } catch {
      return { files: 0 }; // dir not created yet — nothing to sweep.
    }
    let files = 0;
    for (const name of entries) {
      if (!name.endsWith('.tar.gz')) continue;
      const live = await this.database.db
        .select({ id: diagnosticsReport.id })
        .from(diagnosticsReport)
        .where(
          and(
            eq(diagnosticsReport.bundlePath, name),
            eq(diagnosticsReport.isDeleted, false),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (live) continue;
      try {
        await unlinkAsync(this.diagnostics.bundleAbsPath(name));
        files++;
      } catch {
        // already gone — concurrent sweep.
      }
    }
    this.logger.log(`gcOrphanedBundles: unlinked ${files} orphan file(s).`);
    return { files };
  }

  /** Soft-delete ONE report (admin per-row delete) + unlink its bundle when nothing else references
   *  it. Idempotent — a missing/already-deleted row returns { deleted: false }. Reuses the same
   *  reference guard as {@link gcExpiredReports} so an identical sha256 bundle shared with another row
   *  is never yanked. */
  async deleteReport(
    id: number,
  ): Promise<{ deleted: boolean; unlinked: boolean }> {
    const row = await this.database.db
      .select({
        id: diagnosticsReport.id,
        bundlePath: diagnosticsReport.bundlePath,
      })
      .from(diagnosticsReport)
      .where(
        and(
          eq(diagnosticsReport.id, id),
          eq(diagnosticsReport.isDeleted, false),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!row) return { deleted: false, unlinked: false };
    await this.database.db
      .update(diagnosticsReport)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(eq(diagnosticsReport.id, row.id));
    const unlinked = await this.unlinkBundleIfUnreferenced(
      row.bundlePath,
      row.id,
    );
    this.logger.log(`deleteReport: soft-deleted #${id}, unlinked=${unlinked}.`);
    return { deleted: true, unlinked };
  }

  /** Flag rows whose bundle file is missing on disk as archived (manual deletion / FS loss). */
  async reconcileDiagnostics(): Promise<{ flagged: number }> {
    const rows = await this.database.db
      .select({
        id: diagnosticsReport.id,
        bundlePath: diagnosticsReport.bundlePath,
      })
      .from(diagnosticsReport)
      .where(
        and(
          eq(diagnosticsReport.isDeleted, false),
          ne(diagnosticsReport.status, 'archived'),
        ),
      );
    let flagged = 0;
    for (const { id, bundlePath } of rows) {
      if (existsSync(this.diagnostics.bundleAbsPath(bundlePath))) continue;
      await this.database.db
        .update(diagnosticsReport)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(diagnosticsReport.id, id));
      flagged++;
    }
    this.logger.log(
      `reconcileDiagnostics: flagged ${flagged} missing-file row(s) archived.`,
    );
    return { flagged };
  }

  /** Unlink a bundle file ONLY when no other non-deleted row references it (so identical sha256 bundles
   *  shared between reports don't yank a live report's file). */
  private async unlinkBundleIfUnreferenced(
    bundlePath: string,
    excludingId: number,
  ): Promise<boolean> {
    const other = await this.database.db
      .select({ id: diagnosticsReport.id })
      .from(diagnosticsReport)
      .where(
        and(
          eq(diagnosticsReport.bundlePath, bundlePath),
          eq(diagnosticsReport.isDeleted, false),
          ne(diagnosticsReport.id, excludingId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (other) return false;
    try {
      await unlinkAsync(this.diagnostics.bundleAbsPath(bundlePath));
      return true;
    } catch {
      return false; // already gone.
    }
  }
}
