import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import http from 'node:http';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';

// Verifies the surfaces rewritten for the Express→Fastify migration that the auth e2e does
// not cover: Swagger UI on Fastify, the @fastify/multipart upload path (UploadService.consumeImage)
// + static serving of the result, and the SSE stream via reply.hijack()/reply.raw.

// Minimal valid 1×1 PNG (real PNG signature so UploadService.isImage's magic-number check passes).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Fastify adapter surfaces (docs / upload / SSE)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let port: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    // configureApp before listen(): it sets the global prefix (must precede route registration,
    // which listen() performs) and registers the multipart parser + static mounts. listen() then
    // runs init + Fastify ready() (initializing route-context lifecycle hooks).
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    port = (app.getHttpServer().address() as { port: number }).port;

    // Seed a user and grab an access token for the guarded routes below.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
    );
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ uniqName: 'fastify', password: 'Pass1234' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ uniqName: 'fastify', password: 'Pass1234' });
    token = login.body.data.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI on Fastify', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/docs');
    expect(res.status).toBe(200);
  });

  it('accepts a multipart image upload and serves it back at /uploads/', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'x.png')
      .field('w', '1')
      .field('h', '1');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(/^\/uploads\//);
    expect(res.body.data.w).toBe(1);
    expect(res.body.data.h).toBe(1);

    // The uploaded file is reachable via @fastify/static at the returned url.
    const file = await request(app.getHttpServer()).get(res.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
  });

  it('opens an SSE stream (reply.hijack + reply.raw) and emits the connected frame', async () => {
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/events',
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            resolve(chunk.toString());
            req.destroy();
            res.destroy();
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(firstChunk).toContain(': connected');
  }, 10000);
});
