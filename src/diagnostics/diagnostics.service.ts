import { Injectable, HttpStatus } from '@nestjs/common';
import { existsSync, mkdir, writeFile, rename } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma.service.js';
import { Prisma } from '../prisma/generated/client.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { AdminListDiagnosticsDto } from './diagnostics.dto.js';

const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);

/** Storage dir for diagnostic bundles, aligned with the data/uploads + data/logs convention
 *  (process.cwd()/data/<bucket>). Created on first write. */
export const DIAGNOSTICS_DIR = join(process.cwd(), 'data', 'diagnostics');

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
  manifest: Prisma.JsonValue;
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
  constructor(private readonly prisma: PrismaService) {}

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
  ): Promise<{ buffer: Buffer; manifest: Prisma.InputJsonValue }> {
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
        throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'bundle too large');
      }
      if (buf.length > MAX_BUNDLE_BYTES) {
        throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'bundle too large');
      }
      bundle = buf;
    }
    if (!bundle) {
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'no bundle');
    }
    // Best-effort manifest: the client sends a JSON object; a missing/invalid one degrades to {} so a
    // buggy client can still report (the bundle itself is the valuable payload).
    let manifest: Prisma.InputJsonValue;
    try {
      const parsed = manifestRaw ? JSON.parse(manifestRaw) : null;
      manifest =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Prisma.InputJsonValue)
          : {};
    } catch {
      manifest = {};
    }
    return { buffer: bundle, manifest };
  }

  /** One report per user per window — the authenticated abuse ceiling (the route @Throttle covers the
   *  IP-burst tier). Mirrors OtpLoginService's account-dimension check. */
  private async enforceReportWindow(userId: number): Promise<void> {
    const latest = await this.prisma.diagnosticsReport.findFirst({
      where: { reporterUserId: userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
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
    manifest: Prisma.InputJsonValue,
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
    const row = await this.prisma.diagnosticsReport.create({
      data: {
        reporterUserId: userId,
        bundlePath: filename,
        bundleBytes: buffer.length,
        manifest,
      },
    });
    return { id: row.id };
  }

  /** Admin list: JOIN reporter (name/account/avatar) so reports from different users are
   *  distinguishable at a glance; search matches reporter name/account. */
  async list(
    dto: AdminListDiagnosticsDto,
  ): Promise<{ list: DiagnosticsListItem[]; total: number }> {
    const where: Prisma.DiagnosticsReportWhereInput = { isDeleted: false };
    if (dto.search) {
      where.reporter = {
        OR: [{ name: { contains: dto.search } }, { account: { contains: dto.search } }],
      };
    }
    const [rows, total] = await Promise.all([
      this.prisma.diagnosticsReport.findMany({
        where,
        include: {
          reporter: { select: { id: true, name: true, account: true, avatar: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: dto.skip ?? 0,
        take: dto.take ?? 20,
      }),
      this.prisma.diagnosticsReport.count({ where }),
    ]);
    return {
      list: rows.map((r) => ({
        id: r.id,
        reporter: r.reporter,
        bundleBytes: r.bundleBytes,
        manifest: r.manifest,
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
    const row = await this.prisma.diagnosticsReport.findFirst({
      where: { id, isDeleted: false },
      select: { bundlePath: true },
    });
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
    await this.prisma.diagnosticsReport
      .updateMany({ where: { id, isDeleted: false }, data: { status: 'viewed' } })
      .catch(() => {
        // row gone — nothing to mark.
      });
  }
}
