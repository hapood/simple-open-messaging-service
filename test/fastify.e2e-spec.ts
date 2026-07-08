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

// Minimal ISO BMFF header: box size(4) + 'ftyp' + brand 'mp42' — enough for detectMedia to read the
// video-container signature (the e2e does not need a playable file, only a valid magic byte).
const MP4_MIN = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);
// 'OggS' signature — the ogg/opus container magic byte.
const OGG_MIN = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

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
    // MediaAsset (CAS ref counts) — start clean so dedup assertions are predictable.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "MediaAsset" RESTART IDENTITY',
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
    // CAS path: /uploads/shards/<2-hex>/<2-hex>/<64-hex-sha256>.<ext>
    expect(res.body.data.url).toMatch(
      /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/,
    );
    expect(res.body.data.w).toBe(1);
    expect(res.body.data.h).toBe(1);
    expect(res.body.data.size).toBe(PNG_1X1.length);

    // The uploaded file is reachable via @fastify/static at the returned url. /uploads/* is auth-gated
    // (AccessTokenValidator via the media_token cookie OR a Bearer header) — send the Bearer token.
    const file = await request(app.getHttpServer())
      .get(res.body.data.url)
      .set('Authorization', `Bearer ${token}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
  });

  it('dedupes identical image bytes to the same CAS path', async () => {
    // Two uploads of byte-identical content (different client filenames) must land on the same
    // sha256-keyed path — that is the whole point of content-addressed storage.
    const first = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'a.png')
      .field('w', '1')
      .field('h', '1');
    const second = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'b.png')
      .field('w', '1')
      .field('h', '1');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.url).toBe(first.body.data.url);
    expect(second.body.data.size).toBe(first.body.data.size);
    // refs reflects every upload of this digest (this test's two + the earlier upload test's one),
    // so assert a lower bound of 2 — the increment path is exercised.
    const digest = first.body.data.url
      .slice('/uploads/shards/'.length)
      .split('/')
      .pop()!
      .replace(/\.png$/, '');
    const asset = await prisma.mediaAsset.findUnique({ where: { digest } });
    expect(asset?.refs).toBeGreaterThanOrEqual(2);
  });

  it('accepts a video upload (magic-byte container check) and serves it inline', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload/video')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', MP4_MIN, 'clip.mp4');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(
      /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/,
    );
    expect(res.body.data.mimeType).toBe('video/mp4');
    expect(res.body.data.size).toBe(MP4_MIN.length);
    // Video is served INLINE (no Content-Disposition: attachment) so <video src> can stream-play.
    const file = await request(app.getHttpServer())
      .get(res.body.data.url)
      .set('Authorization', `Bearer ${token}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBeUndefined();
  });

  it('rejects a forged video upload (non-video bytes under /upload/video)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload/video')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('not a video, just text'), 'fake.mp4');
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe(0); // VALIDATION_FAILED — magic-byte gate rejected it
  });

  it('accepts an audio upload (ogg container)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload/audio')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', OGG_MIN, 'voice.ogg');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(/\.ogg$/);
    expect(res.body.data.mimeType).toBe('audio/ogg');
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
