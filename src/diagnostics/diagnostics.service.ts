import { accountProfileFields } from '../user/account-profile.js';
import { Injectable, HttpStatus } from '@nestjs/common';
import { existsSync, mkdir, writeFile, rename } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { and, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { diagnosticsReport, account as user } from '../database/schema.js';
import type { JsonValue } from '../database/json.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { AdminListDiagnosticsDto } from './diagnostics.dto.js';
import { dataDirectory } from '../common/data-directory.js';

const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);

/** Storage dir for diagnostic bundles, aligned with the uploads + logs data buckets. */
export const DIAGNOSTICS_DIR = dataDirectory('diagnostics');

/** Per-user report cool-down: one bundle per window. Generous (a user debugging with support reports a
 *  few times), tight enough that a runaway client loop can't flood the table. */
const REPORT_WINDOW_MS = 5 * 60 * 1000;

/** Hard per-bundle cap beneath the global @fastify/multipart ceiling. The Rust side ships a gzip tar of
 *  text logs (~1-2 MiB typical; the rotation cap is ~6 MiB), so this is generous headroom. */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export interface DiagnosticsListItem {
  id: number;
  reporter: { id: number; name: string; account: string; avatar: string };
  bundleBytes: number;
  manifest: JsonValue;
  status: string;
  createdAt: Date;
}

/**
 * Diagnostic-bundle ingestion + admin read. The bundle is a client-built gzip tar (Rust logs + a
 * webview console capture + a manifest); this service owns multipart draining, per-user rate-limiting,
 * content-addressed atomic storage (mirrors UploadService.saveCas, minus the refcount — GC unlinks only
 * when no row references the file), and the admin list/download resolution.
 */
@Injectable()
export class DiagnosticsService {
  constructor(private readonly database: DatabaseService) {}

  /** The on-disk directory holding bundle files (DiagnosticsGcService walks it). */
  readonly dir = DIAGNOSTICS_DIR;

  /** Absolute path of a bundle filename under the diagnostics dir. */
  bundleAbsPath(filename: string): string {
    return join(this.dir, filename);
  }

  /**
   * Consume the multipart upload (field `bundle` = the tar.gz, field `manifest` = JSON string). Drains
   * each part inside the loop — the same backpressure invariant as UploadService.consumeSingle: the
   * parser can only advance past a file part by reading it through, so deferring toBuffer() past the
   * loop stalls parts() forever once the body spans one read chunk.
   */
  async consumeBundle(
    req: FastifyRequest,
  ): Promise<{ buffer: Buffer; manifest: JsonValue }> {
    let bundle: Buffer | undefined;
    let manifestRaw: string | undefined;
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        if (part.fieldname === 'manifest') manifestRaw = String(part.value);
        continue;
      }
      // Single-file contract: only the `bundle` part is kept; drain any other file parts so the
      // parser can advance.
      if (part.fieldname !== 'bundle' || bundle) {
        part.file.resume();
        continue;
      }
      let buf: Buffer;
      try {
        buf = await part.toBuffer();
      } catch {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'bundle too large',
        );
      }
      if (buf.length > MAX_BUNDLE_BYTES) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'bundle too large',
        );
      }
      bundle = buf;
    }
    if (!bundle) {
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'no bundle');
    }
    // Best-effort manifest: the client sends a JSON object; a missing/invalid one degrades to {} so a
    // buggy client can still report (the bundle itself is the valuable payload).
    let manifest: JsonValue;
    try {
      const parsed = manifestRaw ? JSON.parse(manifestRaw) : null;
      manifest =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as JsonValue)
          : {};
    } catch {
      manifest = {};
    }
    return { buffer: bundle, manifest };
  }

  /** One report per user per window — the authenticated abuse ceiling (the route @Throttle covers the
   *  IP-burst tier). Mirrors OtpLoginService's account-dimension check. */
  private async enforceReportWindow(userId: number): Promise<void> {
    const latest = await this.database.db
      .select({ createdAt: diagnosticsReport.createdAt })
      .from(diagnosticsReport)
      .where(
        and(
          eq(diagnosticsReport.reporterUserId, userId),
          eq(diagnosticsReport.isDeleted, false),
        ),
      )
      .orderBy(desc(diagnosticsReport.createdAt))
      .limit(1)
      .then((rows) => rows[0]);
    if (!latest) return;
    const elapsed = Date.now() - latest.createdAt.getTime();
    if (elapsed < REPORT_WINDOW_MS) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'diagnostics report rate-limited; please retry shortly',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfter: Math.ceil((REPORT_WINDOW_MS - elapsed) / 1000) },
      );
    }
  }

  /** Persist a bundle + its row. sha256-addressed filename + atomic tmp+rename publish (mirrors
   *  UploadService.saveCas, without the refcount upsert). Returns the new report id. */
  async storeReport(
    userId: number,
    buffer: Buffer,
    manifest: JsonValue,
  ): Promise<{ id: number }> {
    await this.enforceReportWindow(userId);
    await mkdirAsync(this.dir, { recursive: true });
    const digest = createHash('sha256').update(buffer).digest('hex');
    const filename = `${digest}.tar.gz`;
    const abs = this.bundleAbsPath(filename);
    // Skip the write if an identical bundle already exists (concurrent/duplicate upload) — the row is
    // still created, and GC unlinks the shared file only once no row references it.
    if (!existsSync(abs)) {
      const tmp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFileAsync(tmp, buffer);
      await renameAsync(tmp, abs);
    }
    const [row] = await this.database.db
      .insert(diagnosticsReport)
      .values({
        reporterUserId: userId,
        bundlePath: filename,
        bundleBytes: buffer.length,
        manifest,
        updatedAt: new Date(),
      })
      .returning({ id: diagnosticsReport.id });
    if (!row) throw new Error('diagnostics report insert returned no row');
    return row;
  }

  /** Admin list: JOIN reporter (name/account/avatar) so reports from different users are
   *  distinguishable at a glance; search matches reporter name/account. */
  async list(
    dto: AdminListDiagnosticsDto,
  ): Promise<{ list: DiagnosticsListItem[]; total: number }> {
    const filters: SQL[] = [eq(diagnosticsReport.isDeleted, false)];
    if (dto.search) {
      const pattern = `%${dto.search}%`;
      filters.push(
        or(
          ilike(accountProfileFields(user).name, pattern),
          ilike(user.account, pattern),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          id: diagnosticsReport.id,
          reporter: {
            id: user.id,
            name: accountProfileFields(user).name,
            account: user.account,
            avatar: accountProfileFields(user).avatar,
          },
          bundleBytes: diagnosticsReport.bundleBytes,
          manifest: diagnosticsReport.manifest,
          status: diagnosticsReport.status,
          createdAt: diagnosticsReport.createdAt,
        })
        .from(diagnosticsReport)
        .innerJoin(user, eq(user.id, diagnosticsReport.reporterUserId))
        .where(where)
        .orderBy(desc(diagnosticsReport.createdAt))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 20),
      this.database.db
        .select({ value: count() })
        .from(diagnosticsReport)
        .innerJoin(user, eq(user.id, diagnosticsReport.reporterUserId))
        .where(where)
        .then((rows) => rows[0]?.value ?? 0),
    ]);
    return {
      list: rows.map((r) => ({
        id: r.id,
        reporter: r.reporter,
        bundleBytes: r.bundleBytes,
        manifest: r.manifest as JsonValue,
        status: r.status,
        createdAt: r.createdAt,
      })),
      total,
    };
  }

  /** Resolve a report id to its bundle's absolute path. Throws NOT_FOUND for a missing/archived row OR
   *  a row whose file is gone on disk (e.g. an archived bundle after reconcile) — so download gets a
   *  clean 404 instead of a 500 from a missing-file createReadStream. */
  async resolveBundlePath(id: number): Promise<string> {
    const row = await this.database.db
      .select({ bundlePath: diagnosticsReport.bundlePath })
      .from(diagnosticsReport)
      .where(
        and(
          eq(diagnosticsReport.id, id),
          eq(diagnosticsReport.isDeleted, false),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!row) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'diagnostics report not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const abs = this.bundleAbsPath(row.bundlePath);
    if (!existsSync(abs)) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'diagnostics bundle file missing',
        HttpStatus.NOT_FOUND,
      );
    }
    return abs;
  }

  /** Mark a report viewed (best-effort — a missing row was GC'd concurrently). */
  async markViewed(id: number): Promise<void> {
    await this.database.db
      .update(diagnosticsReport)
      .set({ status: 'viewed', updatedAt: new Date() })
      .where(
        and(
          eq(diagnosticsReport.id, id),
          eq(diagnosticsReport.isDeleted, false),
        ),
      )
      .catch(() => {
        // row gone — nothing to mark.
      });
  }
}
