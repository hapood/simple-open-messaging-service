import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';

// Verifies the HTTP/2-over-TLS path itself: boots the app on a FastifyAdapter({http2,https})
// with a self-signed cert and drives it with node's http2 client. This is the one feature the
// h1.1 e2e cannot cover. It also exercises the SSE stream over h2 — the place where emitting a
// Connection header would crash Node http2 ("HTTP/1 Connection specific headers are forbidden").

const tmp = mkdtempSync(join(tmpdir(), 'socs-h2-'));

function h2Request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false, // self-signed cert
    });
    const req = client.request({
      ':method': method,
      ':path': path,
      'content-type': body ? 'application/json' : undefined,
      ...headers,
    });
    let status = 0;
    const hdrs: http2.IncomingHttpHeaders = {};
    let chunks = '';
    req.on('response', (h) => {
      status = h[':status'] as number;
      Object.assign(hdrs, h);
    });
    req.on('data', (c: Buffer) => {
      chunks += c.toString();
    });
    req.on('end', () => {
      client.close();
      resolve({ status, headers: hdrs, body: chunks });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('HTTP/2 over TLS', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let port: number;
  let token: string;

  beforeAll(async () => {
    // Self-signed cert for the localhost h2 server.
    const certPath = join(tmp, 'cert.pem');
    const keyPath = join(tmp, 'key.pem');
    if (!existsSync(certPath)) {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
    }
    const adapter = new FastifyAdapter({
      trustProxy: 1,
      http2: true,
      https: { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    port = (app.getHttpServer().address() as { port: number }).port;

    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
    );
    // Register + login over h2 (the server is TLS-only, so supertest/plain-http can't reach it).
    await h2Request(
      port,
      'POST',
      '/api/v1/user/register',
      JSON.stringify({ uniqName: 'h2user', name: 'H2 User', password: 'Pass1234' }),
    );
    const login = await h2Request(
      port,
      'POST',
      '/api/v1/auth/login',
      JSON.stringify({ uniqName: 'h2user', password: 'Pass1234' }),
    );
    token = JSON.parse(login.body).data.access_token;
  }, 30000);

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('negotiates HTTP/2 and serves Swagger UI', async () => {
    const res = await h2Request(port, 'GET', '/api/v1/docs');
    expect(res.status).toBe(200);
  });

  it('parses a JSON request body over h2', async () => {
    const res = await h2Request(
      port,
      'POST',
      '/api/v1/user/register',
      JSON.stringify({ uniqName: 'h2post', name: 'H2 Post', password: 'Pass1234' }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
  });

  it('opens the SSE stream over h2 without a Connection-header crash', async () => {
    // reply.hijack + reply.raw under h2; SseService must omit Connection: keep-alive or
    // Node http2 throws. The first written frame is the `: connected` comment.
    const firstFrame = await new Promise<string>((resolve, reject) => {
      const client = http2.connect(`https://127.0.0.1:${port}`, {
        rejectUnauthorized: false,
      });
      const req = client.request({
        ':method': 'GET',
        ':path': '/api/v1/events',
        authorization: `Bearer ${token}`,
      });
      req.on('data', (c: Buffer) => {
        resolve(c.toString());
        req.close();
        client.close();
      });
      req.on('error', reject);
      req.end();
    });
    expect(firstFrame).toContain(': connected');
  }, 10000);
});
