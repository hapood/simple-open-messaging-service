import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { BusinessCode } from '../src/common/business-code';
import { seedUserWithSession } from './seed';
import {
  DiagnosticsService,
  DIAGNOSTICS_DIR,
} from '../src/diagnostics/diagnostics.service';
import { DiagnosticsGcService } from '../src/diagnostics/diagnostics-gc.service';

/**
 * End-to-end coverage for the diagnostics-reporting feature:
 *  - consumer multipart upload (POST /diagnostics/report) creates a row + writes the bundle to disk;
 *  - the per-user cool-down rate-limits a second report inside the window;
 *  - an unauthenticated request is rejected by the global SessionAuthGuard;
 *  - the admin list() JOIN returns reporter identity + search;
 *  - GC soft-deletes expired reports (and unlinks their file) + reaps orphan bundle files.
 *
 * The bundle files land in the shared data/diagnostics/ dir (per-fork isolation is DB-only); each test
 * uses unique content (→ unique sha256 filename) and records what it creates for afterAll cleanup.
 */
describe('diagnostics reporting e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let diag: DiagnosticsService;
  let gc: DiagnosticsGcService;
  const createdFiles: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    diag = app.get(DiagnosticsService);
    gc = app.get(DiagnosticsGcService);
    mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  });

  beforeEach(async () => {
    // CASCADE on User clears FK-linked rows; both listed for a clean slate per test.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DiagnosticsReport", "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    for (const f of createdFiles) {
      try {
        unlinkSync(f);
      } catch {
        // already gone (GC test removed it, or never written).
      }
    }
    await app.close();
  });

  /** POST a bundle as the seeded user. */
  function postReport(token: string, bundle: Buffer) {
    return request(app.getHttpServer())
      .post('/api/v1/diagnostics/report')
      .set('Authorization', `Bearer ${token}`)
      .attach('bundle', bundle, {
        filename: 'bundle.tar.gz',
        contentType: 'application/gzip',
      })
      .field('manifest', JSON.stringify({ app: '1.0.0', platform: 'android' }));
  }

  it('POST /diagnostics/report stores the bundle + a row (multipart, Bearer)', async () => {
    const user = await seedUserWithSession(app, 'diaguser', { name: 'Diag User' });
    const bundle = Buffer.from('fake-tar-gz-contents-1');
    const res = await postReport(user.token, bundle);
    expect(res.body.code).toBe(BusinessCode.OK);
    const id: number = res.body.data.id;
    expect(typeof id).toBe('number');

    const row = await prisma.diagnosticsReport.findUnique({ where: { id } });
    expect(row).toBeTruthy();
    expect(row!.reporterUserId).toBe(user.id);
    const digest = createHash('sha256').update(bundle).digest('hex');
    expect(row!.bundlePath).toBe(`${digest}.tar.gz`);
    const abs = join(DIAGNOSTICS_DIR, row!.bundlePath);
    expect(existsSync(abs)).toBe(true);
    createdFiles.push(abs);
  });

  it('rate-limits a second report inside the per-user window', async () => {
    const user = await seedUserWithSession(app, 'diagrl', { name: 'RL User' });
    const first = await postReport(user.token, Buffer.from('rl-bundle-1'));
    expect(first.body.code).toBe(BusinessCode.OK);
    createdFiles.push(
      join(
        DIAGNOSTICS_DIR,
        `${createHash('sha256').update(Buffer.from('rl-bundle-1')).digest('hex')}.tar.gz`,
      ),
    );
    const second = await postReport(user.token, Buffer.from('rl-bundle-2'));
    expect(second.body.code).toBe(BusinessCode.RATE_LIMITED);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/diagnostics/report')
      .attach('bundle', Buffer.from('noauth'), {
        filename: 'bundle.tar.gz',
        contentType: 'application/gzip',
      });
    expect(res.body.code).toBe(BusinessCode.UNAUTHENTICATED);
  });

  it('list() returns reporter identity and matches search', async () => {
    const user = await seedUserWithSession(app, 'diaglist', { name: 'Alice Lister' });
    await prisma.diagnosticsReport.create({
      data: {
        reporterUserId: user.id,
        bundlePath: 'list-only.tar.gz',
        bundleBytes: 10,
        manifest: { app: '1.0.0' },
      },
    });
    const { list, total } = await diag.list({ search: 'Alice' });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(
      list.some(
        (r) => r.reporter.account === 'diaglist' && r.reporter.name === 'Alice Lister',
      ),
    ).toBe(true);
  });

  it('gcExpiredReports soft-deletes old reports and unlinks their file', async () => {
    const user = await seedUserWithSession(app, 'diagx', { name: 'Expired' });
    const buf = Buffer.from('gc-old-bundle');
    const filename = `${createHash('sha256').update(buf).digest('hex')}.tar.gz`;
    const abs = join(DIAGNOSTICS_DIR, filename);
    writeFileSync(abs, buf);
    createdFiles.push(abs);
    const row = await prisma.diagnosticsReport.create({
      data: {
        reporterUserId: user.id,
        bundlePath: filename,
        bundleBytes: buf.length,
        manifest: {},
        createdAt: new Date(Date.now() - 100 * 86_400_000), // 100 days ago → past the 90d retention
      },
    });
    const res = await gc.gcExpiredReports(90);
    expect(res.rows).toBeGreaterThanOrEqual(1);
    const after = await prisma.diagnosticsReport.findUnique({ where: { id: row.id } });
    expect(after?.isDeleted).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });

  it('gcOrphanedBundles unlinks files with no row', async () => {
    // Unique name so concurrent forks (shared data/diagnostics/) never collide.
    const filename = `orphan-${process.pid}-${Date.now()}.tar.gz`;
    const abs = join(DIAGNOSTICS_DIR, filename);
    writeFileSync(abs, Buffer.from('orphan'));
    createdFiles.push(abs);
    expect(existsSync(abs)).toBe(true);
    const res = await gc.gcOrphanedBundles();
    expect(res.files).toBeGreaterThanOrEqual(1);
    expect(existsSync(abs)).toBe(false);
  });

  it('deleteReport soft-deletes a report + unlinks its file (+ hides it from list)', async () => {
    const user = await seedUserWithSession(app, 'diagdel', { name: 'Deleter' });
    const buf = Buffer.from('del-bundle');
    const filename = `${createHash('sha256').update(buf).digest('hex')}.tar.gz`;
    const abs = join(DIAGNOSTICS_DIR, filename);
    writeFileSync(abs, buf);
    createdFiles.push(abs);
    const row = await prisma.diagnosticsReport.create({
      data: {
        reporterUserId: user.id,
        bundlePath: filename,
        bundleBytes: buf.length,
        manifest: {},
      },
    });
    const out = await gc.deleteReport(row.id);
    expect(out).toEqual({ deleted: true, unlinked: true });
    const after = await prisma.diagnosticsReport.findUnique({ where: { id: row.id } });
    expect(after?.isDeleted).toBe(true);
    expect(existsSync(abs)).toBe(false);
    // list() filters isDeleted:false → the report is gone from the admin view.
    const { list } = await diag.list({});
    expect(list.some((r) => r.id === row.id)).toBe(false);
  });

  it('deleteReport is idempotent for a missing/already-deleted report', async () => {
    expect(await gc.deleteReport(999999)).toEqual({ deleted: false, unlinked: false });
  });
});
