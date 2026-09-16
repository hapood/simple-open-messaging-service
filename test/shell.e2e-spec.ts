import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_DIR } from '../src/shell/shell.service';
import { BusinessCode } from '../src/common/business-code';
import { createTestApp } from './support/app';

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
 * `shell-bundle` may hold a bundle from a prior image build (or nothing at all on a dev machine),
 * so neither is a sound fixture source.
 */
describe('Shell dynamic-update endpoints (GET /api/v1/shell/*)', () => {
  let app: NestFastifyApplication;
  let shellDir: string;

  const webVersion = '0.0.1';
  // Arbitrary bytes — the server STREAMS the bundle verbatim (tar integrity is the shell's job, not the
  // server's), so the roundtrip only needs bytes whose sha256 we know.
  const bundleBytes = Buffer.from(
    'pretend-this-is-a-gzip-tarball-of-the-web-spa-browser-build',
  );
  const sha256 = createHash('sha256').update(bundleBytes).digest('hex');

  beforeAll(async () => {
    shellDir = mkdtempSync(join(tmpdir(), 'soms-shell-e2e-'));
    writeFileSync(join(shellDir, `soms-web-${webVersion}.tar.gz`), bundleBytes);
    writeFileSync(
      join(shellDir, 'manifest.json'),
      JSON.stringify({ webVersion, sha256 }),
    );

    ({ app } = await createTestApp((builder) => {
      builder.overrideProvider(SHELL_DIR).useValue(shellDir);
    }));
  });

  afterAll(async () => {
    await app.close();
    if (shellDir) rmSync(shellDir, { recursive: true, force: true });
  });

  it('compat reports the server version (the shell decides compatibility, not the server)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/shell/compat');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(typeof res.body.data.serverVersion).toBe('string');
    expect(res.body.data.serverVersion.length).toBeGreaterThan(0);
    // The server carries no shell floor — compat is just a version report; the shell owns the decision.
    expect(res.body.data).not.toHaveProperty('compatible');
    expect(res.body.data).not.toHaveProperty('minShellVersion');
  });

  it('is reachable WITHOUT auth — @Public() opts out of the global SessionAuthGuard', async () => {
    // No Authorization header. A non-@Public route would be 401/UNAUTHENTICATED; the serverVersion below
    // proves the request reached the handler, not the auth guard.
    const res = await request(app.getHttpServer()).get('/api/v1/shell/compat');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(typeof res.body.data.serverVersion).toBe('string');
  });

  it('web-manifest returns the descriptor the shell integrity-verifies against', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/shell/web-manifest',
    );
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data).toMatchObject({
      webVersion,
      sha256,
      downloadUrl: '/api/v1/shell/web-bundle',
    });
    // No shell floor on the manifest either — compatibility is shell-owned.
    expect(res.body.data).not.toHaveProperty('minShellVersion');
  });

  it('web-bundle streams raw application/gzip bytes whose sha256 matches the manifest (NOT an ApiResult envelope)', async () => {
    // A custom parser collects the raw response bytes into a Buffer — the default superagent parsers
    // would UTF-8-decode binary, corrupting the sha256.
    const res = await request(app.getHttpServer())
      .get('/api/v1/shell/web-bundle')
      .buffer(true)
      // supertest 7's .parse union type mismatches the (stream, cb) parser it
      // actually calls at runtime; the cast documents that, nothing more.
      .parse(((stream: IncomingMessage, cb: (err: Error | null, body: unknown) => void) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
        stream.on('error', cb);
      }) as never);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="soms-web-${webVersion}.tar.gz"`,
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    // Raw bytes, not {code,message,data} — proves the @Res() send bypassed SerializeInterceptor.
    expect((res.body as Buffer).equals(bundleBytes)).toBe(true);
    expect(
      createHash('sha256')
        .update(res.body as Buffer)
        .digest('hex'),
    ).toBe(sha256);
  });

  it('rate-limits the manifest route past its ceiling (ThrottleGuard → HTTP 429 + RATE_LIMITED)', async () => {
    // web-manifest is @Throttle(30, 60): 30/minute per IP. Burst past it and assert the guard trips.
    // Run LAST so its bucket exhaustion does not perturb the functional manifest test above (which
    // made exactly 1 request). After 30 allowed requests the 31st+ are throttled; 40 here guarantees
    // the transition regardless of that single prior request.
    const N = 40;
    const responses = [];
    for (let i = 0; i < N; i++) {
      responses.push(
        await request(app.getHttpServer()).get('/api/v1/shell/web-manifest'),
      );
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
