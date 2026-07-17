import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { SHELL_DIR } from '../src/shell/shell.service';
import { BusinessCode } from '../src/common/business-code';

/**
 * Shell dynamic-update surface — the unauthenticated routes (`GET /shell/compat`, `/shell/web-manifest`,
 * `/shell/web-bundle`) the Tauri shell hits BEFORE it has a session. The unit spec (shell.service.spec)
 * covers the pure compat logic; THIS spec covers the HTTP layer it can't:
 *   - the ApiResult envelope + the global `/api/v1` prefix,
 *   - `@Public()` reachability (no SessionAuthGuard, no auth header),
 *   - the streamed-gzip bundle (`@Res()` send bypasses SerializeInterceptor — the body is raw bytes,
 *     NOT `{code,message,data}`) with a sha256 roundtrip against the manifest,
 *   - the per-route rate limit (ThrottleGuard → HTTP 429 + RATE_LIMITED).
 *
 * `SHELL_DIR` is overridden with a temp dir so manifest/bundle tests are hermetic: the repo's real
 * `data/shell` may hold a bundle from a prior image build (or nothing at all on a dev machine),
 * so neither is a sound fixture source.
 */
describe('Shell dynamic-update endpoints (GET /api/v1/shell/*)', () => {
  let app: INestApplication;
  let shellDir: string;

  const webVersion = '0.0.1';
  // Arbitrary bytes — the server STREAMS the bundle verbatim (tar integrity is the shell's job, not the
  // server's), so the roundtrip only needs bytes whose sha256 we know.
  const bundleBytes = Buffer.from('pretend-this-is-a-gzip-tarball-of-the-web-spa-browser-build');
  const sha256 = createHash('sha256').update(bundleBytes).digest('hex');

  beforeAll(async () => {
    shellDir = mkdtempSync(join(tmpdir(), 'soms-shell-e2e-'));
    writeFileSync(join(shellDir, `soms-web-${webVersion}.tar.gz`), bundleBytes);
    writeFileSync(join(shellDir, 'manifest.json'), JSON.stringify({ webVersion, sha256 }));

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SHELL_DIR)
      .useValue(shellDir)
      .compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    // configureApp before listen(): sets the global prefix (must precede route registration, which
    // listen() performs) + registers multipart/static/cookie. Mirrors test/fastify.e2e-spec.ts.
    await configureApp(app, adapter);
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    if (shellDir) rmSync(shellDir, { recursive: true, force: true });
  });

  it('compat accepts a shell at/above the floor (HTTP 200 + OK + compatible:true)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/shell/compat?version=99.0.0');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.compatible).toBe(true);
    expect(res.body.data.minShellVersion).toBe('0.1.0');
    expect(typeof res.body.data.serverVersion).toBe('string');
  });

  it('compat rejects an older shell but stays HTTP 200 + OK (compatible is in-band, not an HTTP error)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/shell/compat?version=0.0.1');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.compatible).toBe(false);
    expect(res.body.data.minShellVersion).toBe('0.1.0');
  });

  it('is reachable WITHOUT auth — @Public() opts out of the global SessionAuthGuard', async () => {
    // No Authorization header. A non-@Public route would be 401/UNAUTHENTICATED; the missing-version
    // rejection below proves the request reached the handler (compatible:false), not the auth guard.
    const res = await request(app.getHttpServer()).get('/api/v1/shell/compat');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.compatible).toBe(false);
  });

  it('web-manifest returns the descriptor the shell integrity-verifies against', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/shell/web-manifest');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data).toMatchObject({
      webVersion,
      sha256,
      minShellVersion: '0.1.0',
      downloadUrl: '/api/v1/shell/web-bundle',
    });
  });

  it('web-bundle streams raw application/gzip bytes whose sha256 matches the manifest (NOT an ApiResult envelope)', async () => {
    // A custom parser collects the raw response bytes into a Buffer — the default superagent parsers
    // would UTF-8-decode binary, corrupting the sha256.
    const res = await request(app.getHttpServer())
      .get('/api/v1/shell/web-bundle')
      .buffer(true)
      .parse((stream: IncomingMessage, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
        stream.on('error', cb);
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="soms-web-${webVersion}.tar.gz"`,
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    // Raw bytes, not {code,message,data} — proves the @Res() send bypassed SerializeInterceptor.
    expect((res.body as Buffer).equals(bundleBytes)).toBe(true);
    expect(createHash('sha256').update(res.body as Buffer).digest('hex')).toBe(sha256);
  });

  it('rate-limits the manifest route past its ceiling (ThrottleGuard → HTTP 429 + RATE_LIMITED)', async () => {
    // web-manifest is @Throttle(30, 60): 30/minute per IP. Burst past it and assert the guard trips.
    // Run LAST so its bucket exhaustion does not perturb the functional manifest test above (which
    // made exactly 1 request). After 30 allowed requests the 31st+ are throttled; 40 here guarantees
    // the transition regardless of that single prior request.
    const N = 40;
    const responses = [];
    for (let i = 0; i < N; i++) {
      responses.push(await request(app.getHttpServer()).get('/api/v1/shell/web-manifest'));
    }
    const codes = responses.map((r) => r.body?.code);

    // Early requests are allowed (the first of this burst is the 2nd overall — still ≤ 30).
    expect(codes[0]).toBe(BusinessCode.OK);
    // After the ceiling: HTTP 429 + RATE_LIMITED (ThrottleGuard's HttpException(429) → AllExceptionsFilter).
    const last = responses[N - 1];
    expect(last.status).toBe(429);
    expect(last.body.code).toBe(BusinessCode.RATE_LIMITED);
    // The transition OK → RATE_LIMITED occurred somewhere in the burst.
    expect(codes).toContain(BusinessCode.RATE_LIMITED);
  });
});
