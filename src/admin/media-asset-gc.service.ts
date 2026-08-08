import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';
import { join } from 'path';
import { mkdir, readFile, readdir, rename, stat, unlink } from 'fs';
import { promisify } from 'util';
import { and, asc, count, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  forwardBundle,
  forwardBundleAsset,
  forwardBundleDependency,
  fileSyncProgress,
  mediaAsset,
  pendingMedia,
  user,
} from '../database/schema.js';
import { MediaAssetService } from '../upload/media-asset.service.js';
import { UploadService } from '../upload/upload.service.js';
import { parseAvatarBase } from '../upload/avatar-path.js';
import { formatSseFrame, initSseResponse } from '../common/sse-stream.js';

const readdirAsync = promisify(readdir);
const statAsync = promisify(stat);
const unlinkAsync = promisify(unlink);
const readFileAsync = promisify(readFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);

/** A PendingMedia(pending) row older than this is a crashed/abandoned send or localization — reclaim
 *  it (and its orphan file, if any). Generous: a normal upload/localize completes in seconds; this
 *  only sweeps sends that never finished across a long window. */
const STALE_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const STALE_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for multi-device recovery
const STALE_ASSET_PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for interrupted CAS writes
/** A `.complete` marker younger than this may belong to a publish still finishing in another
 *  process — salvage skips it so it never races a live saveCasFromStream (design doc §12.6). */
const SALVAGE_FRESH_GUARD_MS = 30 * 1000;
const PROGRESS_THROTTLE_MS = 300;

export type MediaGcTaskKind = 'gc' | 'reconcile';
export type MediaGcTaskStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface MediaGcProgress {
  id: string;
  kind: MediaGcTaskKind;
  status: MediaGcTaskStatus;
  phase: string;
  directory: string | null;
  file: string | null;
  fileSize: string | null;
  scannedFiles: number;
  scannedBytes: string;
  deletedFiles: number;
  deletedBytes: string;
  startedAt: string;
  finishedAt: string | null;
  result?: GcResult | ReconcileResult;
  error?: string;
}

interface ProgressClient {
  res: ServerResponse;
  ping: NodeJS.Timeout;
}

interface TaskContext {
  task: MediaGcProgress;
  cancelled: () => boolean;
  update: (patch: Partial<MediaGcProgress>, immediate?: boolean) => void;
}

export interface GcResult {
  /** MediaAsset rows flipped from live (isDeleted=false) to reaped (isDeleted=true). */
  reapedRows: number;
  /** Shard files actually unlinked (may be < reapedRows if a file was already missing). */
  reapedFiles: number;
  /** Crashed CAS publishes recovered: `.complete` markers whose publishReady + rename were finished. */
  salvagedFiles: number;
  /** Stale tmp artifacts removed (abandoned `.part`/`.resume.json` without a `.complete`, old `*.tmp`). */
  sweptTmp: number;
}

export interface ForwardBundleGcResult {
  orphanBundles: number;
  orphanAssets: number;
  orphanBytes: string;
}

export interface ReconcileResult {
  /** Crashed CAS publishes recovered before the disk/DB repair scan. */
  salvagedFiles: number;
  deletedOrphanFiles: number;
  deletedTombstoneFiles: number;
  /** Live (isDeleted=false) rows whose shard file is missing on disk, marked isDeleted. */
  markedMissing: number;
}

/**
 * Manual garbage collection for content-addressed media. A MediaAsset row is live (isDeleted=false)
 * iff referenced by a non-deleted MessageAsset or an in-flight staging row (PendingMedia /
 * FileSyncProgress); forward bundles deliberately do not retain blobs.
 *
 * Two tiers:
 *  - {@link gcOrphanedAssets}: salvage crashed CAS publishes, flip unreachable live blobs to isDeleted
 *    and unlink the shard files, then sweep stale tmp artifacts.
 *  - {@link reconcileShards}: salvage crashed CAS publishes, then bounded-batch disk/database repair.
 *
 * GC scans ONLY uploads/cas/ (shards) + uploads/cas/tmp/ (transient ingest artifacts). Avatars are
 * never touched — they have no MediaAsset row; avatar overwrite-delete is owned by
 * UploadService.deleteByUrl. `clearHistory` only changes a per-user watermark and therefore never
 * affects media liveness.
 */
@Injectable()
export class MediaAssetGcService {
  private readonly logger = new Logger(MediaAssetGcService.name);
  private gcRunning = false;
  private currentTask: MediaGcProgress | null = null;
  private readonly progressClients = new Map<string, Set<ProgressClient>>();
  private lastProgressEmitAt = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly mediaAsset: MediaAssetService,
  ) {}

  startTask(kind: MediaGcTaskKind): MediaGcProgress {
    if (this.gcRunning) {
      throw new ConflictException(
        'a media maintenance task is already running',
      );
    }
    const task: MediaGcProgress = {
      id: randomUUID(),
      kind,
      status: 'running',
      phase: 'starting',
      directory: null,
      file: null,
      fileSize: null,
      scannedFiles: 0,
      scannedBytes: '0',
      deletedFiles: 0,
      deletedBytes: '0',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.currentTask = task;
    this.gcRunning = true;
    void this.executeTask(task);
    return structuredClone(task);
  }

  getTask(id: string): MediaGcProgress {
    if (!this.currentTask || this.currentTask.id !== id) {
      throw new NotFoundException('media maintenance task not found');
    }
    return structuredClone(this.currentTask);
  }

  getCurrentTask(): MediaGcProgress | null {
    return this.currentTask ? structuredClone(this.currentTask) : null;
  }

  cancelTask(id: string): MediaGcProgress {
    const task = this.getMutableTask(id);
    if (task.status === 'running') {
      task.status = 'cancelling';
      task.phase = 'cancelling';
      this.emitProgress(task, true);
    }
    return structuredClone(task);
  }

  attachProgress(id: string, res: ServerResponse, origin?: string): void {
    const task = this.getMutableTask(id);
    const ping = initSseResponse(res, origin);
    if (['completed', 'cancelled', 'failed'].includes(task.status)) {
      res.write(formatSseFrame(this.progressEvent(task), task));
      clearInterval(ping);
      res.end();
      return;
    }
    const client = { res, ping };
    const clients = this.progressClients.get(id) ?? new Set<ProgressClient>();
    clients.add(client);
    this.progressClients.set(id, clients);
    res.write(formatSseFrame(this.progressEvent(task), task));
    res.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      if (clients.size === 0) this.progressClients.delete(id);
    });
  }

  private getMutableTask(id: string): MediaGcProgress {
    if (!this.currentTask || this.currentTask.id !== id) {
      throw new NotFoundException('media maintenance task not found');
    }
    return this.currentTask;
  }

  private async executeTask(task: MediaGcProgress): Promise<void> {
    const context: TaskContext = {
      task,
      cancelled: () => task.status === 'cancelling',
      update: (patch, immediate = false) => {
        Object.assign(task, patch);
        this.emitProgress(task, immediate);
      },
    };
    try {
      task.result =
        task.kind === 'gc'
          ? await this.gcOrphanedAssetsCore(context)
          : await this.reconcileShardsCore(context);
      task.status = context.cancelled() ? 'cancelled' : 'completed';
      task.phase = task.status;
    } catch (error) {
      task.status = 'failed';
      task.phase = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.taskLog(
        'error',
        task,
        'task-failed',
        'media maintenance task failed',
        undefined,
        undefined,
        error,
      );
    } finally {
      task.finishedAt = new Date().toISOString();
      this.gcRunning = false;
      this.emitProgress(task, true);
      this.closeProgressClientsLater(task.id);
    }
  }

  private emitProgress(task: MediaGcProgress, immediate = false): void {
    const now = Date.now();
    if (!immediate && now - this.lastProgressEmitAt < PROGRESS_THROTTLE_MS)
      return;
    this.lastProgressEmitAt = now;
    const frame = formatSseFrame(this.progressEvent(task), task);
    for (const client of this.progressClients.get(task.id) ?? []) {
      try {
        client.res.write(frame);
      } catch {
        // The response close handler removes the client.
      }
    }
  }

  private progressEvent(task: MediaGcProgress): string {
    return ['completed', 'cancelled', 'failed'].includes(task.status)
      ? task.status
      : 'progress';
  }

  private closeProgressClientsLater(id: string): void {
    setTimeout(() => {
      for (const client of this.progressClients.get(id) ?? []) {
        clearInterval(client.ping);
        client.res.end();
      }
      this.progressClients.delete(id);
    }, 100);
  }

  private taskLog(
    level: 'log' | 'error',
    task: MediaGcProgress,
    action: string,
    message: string,
    digest?: string,
    bytes?: bigint,
    error?: unknown,
  ): void {
    const record = {
      scope: 'media-gc',
      taskId: task.id,
      taskKind: task.kind,
      action,
      ...(digest ? { digest } : {}),
      ...(bytes !== undefined ? { bytes: String(bytes) } : {}),
      ...(error ? { err: error } : {}),
      msg: message,
    };
    if (level === 'error') this.logger.error(record);
    else this.logger.log(record);
  }

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.gcRunning) {
      throw new ConflictException(
        'a media maintenance task is already running',
      );
    }
    this.gcRunning = true;
    try {
      return await work();
    } finally {
      this.gcRunning = false;
    }
  }

  // ─── Download-inbox admin views (federation design doc §12.6/§12.7) ───────────────────────────
  // The former PENDING-asset terminate/list endpoints are obsolete: MediaAsset now holds only verified
  // blobs (isDeleted). In-flight localization state lives in FileSyncProgress, staged under PendingMedia.

  /** List every staged inbound media batch with its per-file FileSyncProgress state — the admin's view
   *  of the download inbox (what is stuck/failed/pending promotion). Read-only. Retry/clean are the
   *  companion actions; this is what the admin watches after triggering them. BigInt columns (id, byte
   *  counters) are stringified for JSON. */
  async listInboxState(): Promise<{
    batches: Array<{
      batchId: string;
      threadId: number;
      creatorId: number;
      originSeq: number | null;
      contentType: string;
      fileCnt: number;
      anyFailed: boolean;
      originDomain: string | null;
      updatedAt: Date;
      files: Array<{
        id: string;
        digest: string;
        kind: string;
        status: string;
        bytesTotal: string;
        bytesReceived: string;
        errorKind: string | null;
        updatedAt: Date;
      }>;
    }>;
  }> {
    const batches = await this.database.db.query.pendingMedia.findMany({
      where: eq(pendingMedia.direction, 'INBOUND'),
      orderBy: [desc(pendingMedia.updatedAt)],
    });
    if (batches.length === 0) return { batches: [] };
    const files = await this.database.db.query.fileSyncProgress.findMany({
      where: inArray(
        fileSyncProgress.batchId,
        batches.map((b) => b.batchId),
      ),
      orderBy: [asc(fileSyncProgress.id)],
    });
    const filesByBatch = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByBatch.get(f.batchId) ?? [];
      arr.push(f);
      filesByBatch.set(f.batchId, arr);
    }
    return {
      batches: batches.map((b) => ({
        batchId: b.batchId,
        threadId: b.threadId,
        creatorId: b.creatorId,
        originSeq: b.originSeq,
        contentType: b.contentType,
        fileCnt: b.fileCnt,
        anyFailed: b.anyFailed,
        originDomain: b.originDomain,
        updatedAt: b.updatedAt,
        files: (filesByBatch.get(b.batchId) ?? []).map((f) => ({
          id: f.id.toString(),
          digest: f.digest,
          kind: f.kind,
          status: f.status,
          bytesTotal: f.bytesTotal.toString(),
          bytesReceived: f.bytesReceived.toString(),
          errorKind: f.errorKind,
          updatedAt: f.updatedAt,
        })),
      })),
    };
  }

  /** Drop a staged inbound batch for good by deleting PendingMedia + FileSyncProgress in one tx.
   *  Shared CAS blobs and resumable temp artifacts are deliberately untouched: removing the task rows
   *  makes them unclaimed, and the ordinary GC/TTL paths decide when they are safe to reclaim. */
  async cleanInboxBatch(
    batchId: string,
  ): Promise<{ clearedBatch: boolean; fileRows: number; tempFiles: number }> {
    const clearedBatch = await this.database.db.transaction(async (tx) => {
      const files = await tx
        .delete(fileSyncProgress)
        .where(eq(fileSyncProgress.batchId, batchId))
        .returning({ id: fileSyncProgress.id });
      const gone = await tx
        .delete(pendingMedia)
        .where(eq(pendingMedia.batchId, batchId))
        .returning({ id: pendingMedia.id });
      return { clearedBatch: gone.length > 0, fileRows: files.length };
    });
    return { ...clearedBatch, tempFiles: 0 };
  }

  /** Find immutable bundles that are not reachable from any visible ForwardMessage root. This is
   * intentionally admin-triggered only: bundle retention must never depend on a background timer. */
  async inspectOrphanedForwardBundles(): Promise<ForwardBundleGcResult> {
    const ids = await this.findOrphanedForwardBundleIds();
    if (ids.length === 0) {
      return { orphanBundles: 0, orphanAssets: 0, orphanBytes: '0' };
    }
    const [aggregate] = await this.database.db
      .select({
        assetCount: sql<number>`coalesce(sum(${forwardBundle.assetCount}), 0)::int`,
        totalBytes: sql<bigint>`coalesce(sum(${forwardBundle.totalBytes}), 0)::bigint`,
      })
      .from(forwardBundle)
      .where(inArray(forwardBundle.id, ids));
    return {
      orphanBundles: ids.length,
      orphanAssets: aggregate.assetCount,
      orphanBytes: String(aggregate.totalBytes),
    };
  }

  /** Delete the currently unreachable closure and release exactly the CAS refs owned by its bundle
   * asset rows. A fresh reachability scan runs inside the transaction, so inspection is advisory and
   * cleanup never trusts a stale list supplied by the browser. */
  async gcOrphanedForwardBundles(): Promise<ForwardBundleGcResult> {
    return this.database.db.transaction(async (tx) => {
      const ids = await this.findOrphanedForwardBundleIds(tx);
      if (ids.length === 0) {
        return { orphanBundles: 0, orphanAssets: 0, orphanBytes: '0' };
      }
      const bundles = await tx
        .select({
          assetCount: forwardBundle.assetCount,
          totalBytes: forwardBundle.totalBytes,
        })
        .from(forwardBundle)
        .where(inArray(forwardBundle.id, ids));
      await tx
        .delete(forwardBundleDependency)
        .where(
          or(
            inArray(forwardBundleDependency.parentBundleId, ids),
            inArray(forwardBundleDependency.childBundleId, ids),
          ),
        );
      await tx
        .delete(forwardBundleAsset)
        .where(inArray(forwardBundleAsset.bundleId, ids));
      await tx.delete(forwardBundle).where(inArray(forwardBundle.id, ids));
      return {
        orphanBundles: bundles.length,
        orphanAssets: bundles.reduce((sum, row) => sum + row.assetCount, 0),
        orphanBytes: String(
          bundles.reduce((sum, row) => sum + row.totalBytes, 0n),
        ),
      };
    });
  }

  private async findOrphanedForwardBundleIds(
    client: Database | DatabaseTransaction = this.database.db,
  ): Promise<string[]> {
    const rows = await client.execute<{ id: string }>(sql`
      WITH RECURSIVE live(id) AS (
        SELECT DISTINCT fm."bundleId"
        FROM "ForwardMessage" fm
        UNION
        SELECT d."childBundleId"
        FROM "ForwardBundleDependency" d
        JOIN live l ON l.id = d."parentBundleId"
      )
      SELECT fb.id
      FROM "ForwardBundle" fb
      LEFT JOIN live l ON l.id = fb.id
      WHERE l.id IS NULL
    `);
    return rows.rows.map((row) => row.id);
  }

  /** Primary GC: salvage crashed CAS publishes, reap unreachable live (isDeleted=false) blobs, then
   *  sweep stale tmp artifacts. */
  async gcOrphanedAssets(): Promise<GcResult> {
    return this.runExclusive(() => this.gcOrphanedAssetsCore());
  }

  private async gcOrphanedAssetsCore(context?: TaskContext): Promise<GcResult> {
    // Recover crashed publishes FIRST so their blobs are live (and thus reachable/protected) before
    // the reap scan judges liveness — a salvaged blob still staged (FileSyncProgress SUCCEEDED) is
    // spared by the liveness clause; a salvaged orphan is reaped as normal.
    context?.update({ phase: 'salvaging-crashed-publishes' }, true);
    const salvagedFiles = context?.cancelled()
      ? 0
      : await this.salvageCompleteTmp(context);
    const result = await this.database.db.transaction(async (tx) => {
      let reapedRows = 0;
      let reapedFiles = 0;
      let deletedBytes = 0n;
      context?.update({ phase: 'finding-candidates' }, true);
      for (;;) {
        if (context?.cancelled()) break;
        const candidates = await tx.execute<{
          digest: string;
          bytes: string;
        }>(sql`
        SELECT asset.digest, asset.bytes::text AS bytes
        FROM "MediaAsset" asset
        WHERE asset."isDeleted" = false
          AND NOT EXISTS (
            SELECT 1 FROM "MessageAsset" mm
            JOIN "Message" message ON message.id = mm."messageId"
            WHERE mm.digest = asset.digest AND message."isDeleted" = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM "PendingMedia" pending
            WHERE pending.digest = asset.digest
              AND pending.status IN ('pending', 'failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "FileSyncProgress" fsp
            WHERE fsp.digest = asset.digest
              AND fsp.status IN ('PENDING', 'DOWNLOADING', 'SUCCEEDED', 'TOMBSTONED')
          )
        ORDER BY asset.digest
        LIMIT 500
      `);
        if (candidates.rows.length === 0) break;
        for (const { digest, bytes } of candidates.rows) {
          if (context?.cancelled()) break;
          const blobBytes = BigInt(bytes);
          context?.update({
            phase: 'deleting-assets',
            directory: `${digest.slice(0, 2)}/${digest.slice(2, 4)}`,
            file: digest,
            fileSize: bytes,
            scannedFiles: (context.task.scannedFiles ?? 0) + 1,
            scannedBytes: String(BigInt(context.task.scannedBytes) + blobBytes),
          });
          const claimed = await tx.execute<{ digest: string }>(sql`
          UPDATE "MediaAsset" asset
          SET "isDeleted" = true
          WHERE asset.digest = ${digest}
            AND asset."isDeleted" = false
            AND NOT EXISTS (
              SELECT 1 FROM "MessageAsset" mm
              JOIN "Message" message ON message.id = mm."messageId"
              WHERE mm.digest = asset.digest AND message."isDeleted" = false
            )
            AND NOT EXISTS (
              SELECT 1 FROM "PendingMedia" pending
              WHERE pending.digest = asset.digest
                AND pending.status IN ('pending', 'failed')
            )
            AND NOT EXISTS (
              SELECT 1 FROM "FileSyncProgress" fsp
              WHERE fsp.digest = asset.digest
                AND fsp.status IN ('PENDING', 'DOWNLOADING', 'SUCCEEDED', 'TOMBSTONED')
            )
          RETURNING digest
        `);
          if (!claimed.rows[0]) continue;
          if (await this.reapDigest(digest, context, blobBytes)) {
            reapedFiles++;
            deletedBytes += blobBytes;
            if (context) {
              context.update(
                {
                  deletedFiles: reapedFiles,
                  deletedBytes: String(deletedBytes),
                },
                true,
              );
              this.taskLog(
                'log',
                context.task,
                'delete-unreachable',
                'deleted unreachable CAS blob',
                digest,
                blobBytes,
              );
            }
          }
          reapedRows++;
        }
      }
      context?.update(
        { phase: 'sweeping-temporary-files', file: null, fileSize: null },
        true,
      );
      const sweptTmp = context?.cancelled() ? 0 : await this.sweepTmp();
      return { reapedRows, reapedFiles, sweptTmp };
    });
    this.logger.log(
      `gcOrphanedAssets: salvaged ${salvagedFiles}, reaped ${result.reapedRows} row(s), ${result.reapedFiles} file(s), swept ${result.sweptTmp} tmp.`,
    );
    return { ...result, salvagedFiles };
  }

  /**
   * Reap stale PendingMedia rows. Pending sends use `ttlMs`; failed sends use the longer
   * `failedTtlMs` recovery window. This is the orphan-cleanup
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
    failedTtlMs = STALE_FAILED_TTL_MS,
  ): Promise<{ sweptRows: number; reapedFiles: number }> {
    return this.runExclusive(() =>
      this.database.db.transaction(async (tx) => {
        const cutoff = new Date(Date.now() - ttlMs);
        const failedCutoff = new Date(Date.now() - failedTtlMs);
        const stale = await tx
          .select({ id: pendingMedia.id, digest: pendingMedia.digest })
          .from(pendingMedia)
          .where(
            and(
              or(
                and(
                  eq(pendingMedia.status, 'pending'),
                  lt(pendingMedia.createdAt, cutoff),
                ),
                and(
                  eq(pendingMedia.status, 'failed'),
                  lt(pendingMedia.createdAt, failedCutoff),
                ),
              ),
              sql`NOT EXISTS (
                SELECT 1 FROM "UploadSession" session
                 WHERE session."clientMessageId" = ${pendingMedia.clientMessageId}
                   AND session.status IN ('UPLOADING', 'COMPLETING')
              )`,
            ),
          );
        for (const { id } of stale) {
          await tx.delete(pendingMedia).where(eq(pendingMedia.id, id));
        }
        this.logger.log(
          `gcStalePending: swept ${stale.length} stale stage(s); blobs remain for manual space GC.`,
        );
        return { sweptRows: stale.length, reapedFiles: 0 };
      }),
    );
  }

  /** Disk/database consistency repair. Salvages crashed CAS publishes first, then walks uploads/cas/
   *  shards: deletes files with no/reaped MediaAsset row (sparing fresh in-flight writes), and marks
   *  old live rows whose shard is missing as isDeleted. O(files) — run sparingly (monthly). */
  async reconcileShards(): Promise<ReconcileResult> {
    return this.runExclusive(() => this.reconcileShardsCore());
  }

  private async reconcileShardsCore(
    context?: TaskContext,
  ): Promise<ReconcileResult> {
    // Recover crashed publishes before the disk/DB repair so the reverse pass does not mark a
    // salvageable live row (verified bytes, rename not yet finished) as missing.
    context?.update({ phase: 'salvaging-crashed-publishes' }, true);
    const salvagedFiles = context?.cancelled()
      ? 0
      : await this.salvageCompleteTmp(context);
    const txResult = await this.database.db.transaction(async (tx) => {
      const result = {
        deletedOrphanFiles: 0,
        deletedTombstoneFiles: 0,
        markedMissing: 0,
      };
      let scannedBytes = 0n;
      let deletedBytes = 0n;
      context?.update({ phase: 'scanning-disk' }, true);
      const processBatch = async (
        files: Array<{
          digest: string;
          path: string;
          bytes: bigint;
          mtimeMs: number;
        }>,
      ) => {
        if (files.length === 0) return;
        const rows = await tx
          .select({
            digest: mediaAsset.digest,
            isDeleted: mediaAsset.isDeleted,
          })
          .from(mediaAsset)
          .where(
            inArray(
              mediaAsset.digest,
              files.map((file) => file.digest),
            ),
          );
        const rowState = new Map(
          rows.map((row) => [row.digest, row.isDeleted] as const),
        );
        for (const file of files) {
          if (context?.cancelled()) return;
          scannedBytes += file.bytes;
          context?.update({
            phase: 'scanning-disk',
            directory: `${file.digest.slice(0, 2)}/${file.digest.slice(2, 4)}`,
            file: file.digest,
            fileSize: String(file.bytes),
            scannedFiles: context.task.scannedFiles + 1,
            scannedBytes: String(scannedBytes),
          });
          const isDeleted = rowState.get(file.digest);
          if (isDeleted === false) continue; // live row + file present → keep
          if (isDeleted === true) {
            // Reaped row but shard file still on disk → residue → unlink.
            const deleted = await this.unlinkReconcileFile(
              file,
              context,
              'delete-tombstone-residue',
            );
            if (deleted) {
              result.deletedTombstoneFiles++;
              deletedBytes += file.bytes;
            }
            if (context && deleted) {
              context.update(
                {
                  deletedFiles:
                    result.deletedOrphanFiles + result.deletedTombstoneFiles,
                  deletedBytes: String(deletedBytes),
                },
                true,
              );
              this.taskLog(
                'log',
                context.task,
                'delete-tombstone-residue',
                'deleted residual reaped CAS blob',
                file.digest,
                file.bytes,
              );
            }
            continue;
          }
          // No MediaAsset row. Spare files newer than the stale window — they may belong to an
          // in-flight publish (saveCas writes the file before the row; §12.4 makes this crash-safe
          // later). Older orphans are unlinked directly (no tombstone row to insert).
          if (Date.now() - file.mtimeMs < STALE_ASSET_PENDING_TTL_MS) continue;
          const deleted = await this.unlinkReconcileFile(
            file,
            context,
            'delete-orphan',
          );
          if (deleted) {
            result.deletedOrphanFiles++;
            deletedBytes += file.bytes;
          }
          if (context && deleted) {
            context.update(
              {
                deletedFiles:
                  result.deletedOrphanFiles + result.deletedTombstoneFiles,
                deletedBytes: String(deletedBytes),
              },
              true,
            );
            this.taskLog(
              'log',
              context.task,
              'delete-orphan',
              'deleted orphan CAS blob (no MediaAsset row)',
              file.digest,
              file.bytes,
            );
          }
        }
      };
      let batch: Array<{
        digest: string;
        path: string;
        bytes: bigint;
        mtimeMs: number;
      }> = [];
      try {
        for (const a of await readdirAsync(this.upload.casDir, {
          withFileTypes: true,
        })) {
          if (context?.cancelled()) break;
          if (!a.isDirectory()) continue;
          const aDir = join(this.upload.casDir, a.name);
          for (const b of await readdirAsync(aDir, { withFileTypes: true })) {
            if (context?.cancelled()) break;
            if (!b.isDirectory()) continue;
            const bDir = join(aDir, b.name);
            for (const digest of await readdirAsync(bDir)) {
              if (context?.cancelled()) break;
              if (!/^[0-9a-f]{64}$/.test(digest)) continue;
              const path = join(bDir, digest);
              const fileStat = await statAsync(path).catch(() => null);
              if (!fileStat) continue;
              batch.push({
                digest,
                path,
                bytes: BigInt(fileStat.size),
                mtimeMs: fileStat.mtimeMs,
              });
              if (batch.length >= 500) {
                await processBatch(batch);
                batch = [];
              }
            }
          }
        }
      } catch (error) {
        if (context && !this.isMissingFileError(error)) {
          this.taskLog(
            'error',
            context.task,
            'scan-cas-directory',
            'failed to scan CAS directory',
            undefined,
            undefined,
            error,
          );
        }
        // CAS directory missing — READY rows are corrected in the paged reverse pass below.
      }
      await processBatch(batch);
      if (context?.cancelled()) return result;
      context?.update(
        {
          phase: 'checking-ready-rows',
          directory: null,
          file: null,
          fileSize: null,
        },
        true,
      );
      // Only consider rows old enough that a DB-first publish's rename must have settled — a brand-new
      // live row whose shard is still landing (saveCasFromStream publishReady → rename) must not be
      // marked missing. Salvage has already recovered any older crashed publish.
      const missingCutoff = new Date(Date.now() - STALE_ASSET_PENDING_TTL_MS);
      let cursor = '';
      for (;;) {
        if (context?.cancelled()) break;
        const page = await tx.execute<{ digest: string }>(sql`
          SELECT digest FROM "MediaAsset"
          WHERE "isDeleted" = false
            AND digest > ${cursor}
            AND "createdAt" < ${missingCutoff}
          ORDER BY digest LIMIT 500
        `);
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          if (context?.cancelled()) break;
          context?.update({
            phase: 'checking-ready-rows',
            directory: `${row.digest.slice(0, 2)}/${row.digest.slice(2, 4)}`,
            file: row.digest,
            fileSize: null,
            scannedFiles: context.task.scannedFiles + 1,
          });
          const path = join(
            this.upload.casDir,
            row.digest.slice(0, 2),
            row.digest.slice(2, 4),
            row.digest,
          );
          const exists = await statAsync(path)
            .then(() => true)
            .catch(() => false);
          if (!exists) {
            await tx
              .update(mediaAsset)
              .set({ isDeleted: true })
              .where(
                and(
                  eq(mediaAsset.digest, row.digest),
                  eq(mediaAsset.isDeleted, false),
                ),
              );
            result.markedMissing++;
            if (context) {
              this.taskLog(
                'log',
                context.task,
                'mark-missing-deleted',
                'marked missing live CAS blob as isDeleted',
                row.digest,
              );
            }
          }
        }
        cursor = page.rows.at(-1)!.digest;
      }
      this.logger.log(`reconcileShards: ${JSON.stringify(result)}.`);
      return result;
    });
    return { ...txResult, salvagedFiles };
  }

  /** Storage overview for the media page. `db` is the authoritative content size from MediaAsset
   *  (deduped by digest); `onDisk` walks uploads/cas/ to break bytes down by extension and surface
   *  drift vs the table. O(files) — fine for a manually triggered admin read. */
  async stats() {
    const [agg, reclaimable] = await Promise.all([
      this.database.db
        .select({
          bytes: sql<bigint>`coalesce(sum(${mediaAsset.bytes}), 0)::bigint`,
          assetCount: count(),
          live: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = false)::int`,
          deleted: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = true)::int`,
        })
        .from(mediaAsset)
        .then(([row]) => row),
      this.database.db
        .execute<{ value: number }>(
          sql`
        SELECT count(*)::int AS value FROM "MediaAsset" asset
        WHERE asset."isDeleted" = false
          AND NOT EXISTS (
            SELECT 1 FROM "MessageAsset" mm
            JOIN "Message" message ON message.id = mm."messageId"
            WHERE mm.digest = asset.digest AND message."isDeleted" = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM "PendingMedia" pending
            WHERE pending.digest = asset.digest
              AND pending.status IN ('pending', 'failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "FileSyncProgress" fsp
            WHERE fsp.digest = asset.digest
              AND fsp.status IN ('PENDING', 'DOWNLOADING', 'SUCCEEDED', 'TOMBSTONED')
          )
      `,
        )
        .then((result) => result.rows[0]?.value ?? 0),
    ]);

    const shardsDir = this.upload.casDir;
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
            const ext = '(cas)';
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
      db: {
        bytes: BigInt(agg.bytes),
        assetCount: agg.assetCount,
        live: agg.live,
        deleted: agg.deleted,
        reclaimable,
      },
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
   * live base are kept, all 5 of a dead base are swept together. NEVER touches uploads/cas/ (that
   * is gcOrphanedAssets' domain).
   */
  async gcOrphanedAvatars(): Promise<{ sweptFiles: number }> {
    // Live `<base>` set from the two avatar columns. parseAvatarBase strips the size + path, so all 5
    // sizes of one logical avatar collapse to one key.
    // Group avatars live on the `!`-User rows now (Group table abolished), so this single User query
    // covers both people and group avatars.
    const users = await this.database.db
      .select({ avatar: user.avatar })
      .from(user)
      .where(ne(user.avatar, ''));
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

    this.logger.log(
      `gcOrphanedAvatars: swept ${swept} orphaned avatar file(s).`,
    );
    return { sweptFiles: swept };
  }

  /** Sweep one avatar directory: unlink every `<base>-<size>.webp` whose base is not live. */
  private async sweepAvatarDir(
    dir: string,
    live: Set<string>,
  ): Promise<number> {
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

  /** Delete the single extensionless blob for a digest. */
  private async reapDigest(
    digest: string,
    context?: TaskContext,
    bytes?: bigint,
  ): Promise<boolean> {
    const path = join(
      this.upload.casDir,
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest,
    );
    try {
      await unlinkAsync(path);
      return true;
    } catch (error) {
      if (context && !this.isMissingFileError(error)) {
        this.taskLog(
          'error',
          context.task,
          'delete-unreachable',
          'failed to delete CAS blob',
          digest,
          bytes,
          error,
        );
      }
      return false;
    }
  }

  private async unlinkReconcileFile(
    file: { digest: string; path: string; bytes: bigint },
    context: TaskContext | undefined,
    action: string,
  ): Promise<boolean> {
    try {
      await unlinkAsync(file.path);
      return true;
    } catch (error) {
      if (context && !this.isMissingFileError(error)) {
        this.taskLog(
          'error',
          context.task,
          action,
          'failed to delete CAS blob',
          file.digest,
          file.bytes,
          error,
        );
      }
      return false;
    }
  }

  private isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }

  /** Salvage crashed CAS publishes (design doc §12.4/§12.6). For each `.complete` marker in the CAS
   *  tmp dir, finish the publish that saveCasFromStream was interrupted before completing: idempotent
   *  publishReady + atomic rename of the verified `.part` into the shard. The marker is written after
   *  digest verification but before the DB-first publish/rename, so its presence means the bytes are
   *  verified and only the final landing was interrupted. Fresh markers (younger than
   *  SALVAGE_FRESH_GUARD_MS) are spared to avoid racing a publish still finishing. Returns the number
   *  of publishes completed. */
  private async salvageCompleteTmp(context?: TaskContext): Promise<number> {
    let salvaged = 0;
    const entries = await readdirAsync(this.upload.casTmpDir, {
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) return 0; // tmp dir missing — nothing to salvage.
    for (const entry of entries) {
      if (context?.cancelled()) break;
      if (!entry.isFile() || !entry.name.endsWith('.complete')) continue;
      const digest = entry.name.slice(0, -'.complete'.length);
      if (!/^[0-9a-f]{64}$/.test(digest)) continue;
      const complete = join(this.upload.casTmpDir, entry.name);
      const part = join(this.upload.casTmpDir, `${digest}.part`);
      const shardDir = join(
        this.upload.casDir,
        digest.slice(0, 2),
        digest.slice(2, 4),
      );
      const abs = join(shardDir, digest);
      const completeStat = await statAsync(complete).catch(() => null);
      if (!completeStat) continue;
      // A marker this fresh may belong to a publish still finishing — leave it for a later salvage.
      if (Date.now() - completeStat.mtimeMs < SALVAGE_FRESH_GUARD_MS) continue;

      // Publish already landed — just drop the stale marker (and any orphan part).
      const shardExists = await statAsync(abs)
        .then(() => true)
        .catch(() => false);
      if (shardExists) {
        await unlinkAsync(complete).catch(() => {});
        await unlinkAsync(part).catch(() => {});
        continue;
      }
      const partStat = await statAsync(part).catch(() => null);
      if (!partStat) {
        // Verified marker but no recoverable bytes and no shard — cannot complete. Drop the marker; a
        // live row left behind (if publishReady had run) is corrected by the reconcile reverse pass.
        await unlinkAsync(complete).catch(() => {});
        continue;
      }
      // Prefer the byte count recorded at verification; fall back to the part size.
      let bytes = BigInt(partStat.size);
      try {
        const meta = JSON.parse(await readFileAsync(complete, 'utf8')) as {
          bytes?: number;
        };
        if (Number.isSafeInteger(meta.bytes) && meta.bytes! >= 0)
          bytes = BigInt(meta.bytes!);
      } catch {
        // unreadable marker — keep the part-size fallback.
      }
      try {
        await mkdirAsync(shardDir, { recursive: true });
        await this.mediaAsset.publishReady(digest, bytes);
        await renameAsync(part, abs);
        await unlinkAsync(complete).catch(() => {});
        await unlinkAsync(
          join(this.upload.casTmpDir, `${digest}.resume.json`),
        ).catch(() => {});
        salvaged++;
        if (context) {
          context.update({
            phase: 'salvaging-crashed-publishes',
            directory: `${digest.slice(0, 2)}/${digest.slice(2, 4)}`,
            file: digest,
            fileSize: String(bytes),
          });
          this.taskLog(
            'log',
            context.task,
            'salvage-complete',
            'finished a crashed CAS publish from its .complete marker',
            digest,
            bytes,
          );
        }
      } catch (error) {
        if (context && !this.isMissingFileError(error)) {
          this.taskLog(
            'error',
            context.task,
            'salvage-complete',
            'failed to finish a crashed CAS publish',
            digest,
            bytes,
            error,
          );
        }
      }
    }
    return salvaged;
  }

  /** Sweep the CAS tmp dir: remove stale in-flight artifacts (design doc §12.6). A `.complete` marker
   *  is never swept here — salvage consumes it. A `.part`/`.resume.json` whose digest also has a
   *  `.complete` is owned by salvage and spared. A `.part`/`.resume.json` WITHOUT a `.complete` is an
   *  abandoned download (no progress for STALE_PENDING_TTL_MS) — unlinked. `*.tmp` crash leftovers from
   *  the buffer publish paths (saveCas/publishResumable) are likewise swept once stale. Fresh artifacts
   *  are spared so an active ingest is never swept mid-write. */
  private async sweepTmp(): Promise<number> {
    let swept = 0;
    const entries = await readdirAsync(this.upload.casTmpDir, {
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) return 0; // tmp dir missing — nothing to sweep.
    const completeDigests = new Set(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.complete'))
        .map((e) => e.name.slice(0, -'.complete'.length))
        .filter((d) => /^[0-9a-f]{64}$/.test(d)),
    );
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.complete')) continue; // salvage owns the marker
      const full = join(this.upload.casTmpDir, entry.name);
      // A `.part`/`.resume.json` belonging to a digest that also has a `.complete` is verified and
      // awaiting salvage — spare it.
      const trackedDigest = entry.name.endsWith('.part')
        ? entry.name.slice(0, -'.part'.length)
        : entry.name.endsWith('.resume.json')
          ? entry.name.slice(0, -'.resume.json'.length)
          : null;
      if (
        trackedDigest &&
        /^[0-9a-f]{64}$/.test(trackedDigest) &&
        completeDigests.has(trackedDigest)
      ) {
        continue;
      }
      const fileStat = await statAsync(full).catch(() => null);
      if (!fileStat) continue;
      if (now - fileStat.mtimeMs < STALE_PENDING_TTL_MS) continue;
      await unlinkAsync(full).catch(() => {});
      swept++;
    }
    return swept;
  }
}
