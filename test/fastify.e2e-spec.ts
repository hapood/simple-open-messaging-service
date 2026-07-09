import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import http from 'node:http';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { BusinessCode } from '../src/common/business-code';
import { makePng } from './federation-harness';

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

/** Grant `userId` read access to a CAS digest by linking it to a P2P thread they're an active member
 *  of — exactly what writeMsgToThread does on a real send. Used by the serving tests so they can
 *  exercise @fastify/static BEHIND the per-object gate without the full send-message round-trip. */
async function authorizeDigest(
  prisma: PrismaService,
  userId: number,
  digest: string,
): Promise<void> {
  const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
  await prisma.threadParticipant.create({
    data: { userId, threadId: thread.id },
  });
  const msg = await prisma.message.create({
    data: { contentType: 'IMAGE', content: '', threadId: thread.id, creator: userId },
  });
  await prisma.mediaMessage.create({
    data: { messageId: msg.id, threadId: thread.id, digest },
  });
}

describe('Fastify adapter surfaces (docs / upload / SSE)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let token2: string;
  let userAId: number;
  let userBId: number;
  let avatarPng: Buffer;
  let authzPng: Buffer;
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
      .send({ account: 'fastify', name: 'Fastify', password: 'Pass1234' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'fastify', password: 'Pass1234' });
    token = login.body.data.access_token;
    // Second local user for the per-object media-authz tests (the non-member).
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'fastify2', name: 'Fastify2', password: 'Pass1234' });
    const login2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'fastify2', password: 'Pass1234' });
    token2 = login2.body.data.access_token;
    userAId = (await prisma.user.findFirst({ where: { account: 'fastify' } }))!
      .id;
    userBId = (await prisma.user.findFirst({ where: { account: 'fastify2' } }))!
      .id;
    // A sharp-valid PNG for the avatar endpoint (saveAvatars DECODES via sharp; the hand-written
    // PNG_1X1 used for the raw /upload tests has a header sharp's libpng rejects).
    avatarPng = await makePng(200);
    // A DISTINCT PNG for the authz test so its CAS digest is not pre-authorized by the earlier
    // image-upload test (PNG_1X1 dedupes to the same digest across tests).
    authzPng = await makePng(150);
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
    // The per-object gate further requires a MediaMessage row tying this digest to a thread the caller
    // is in; authorize it (a real send would write that row in writeMsgToThread).
    const digest = res.body.data.url
      .slice('/uploads/shards/'.length)
      .split('/')
      .pop()!
      .replace(/\.png$/, '');
    await authorizeDigest(prisma, userAId, digest);
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
    // Authorize the digest for the uploader so the per-object gate permits the GET (see image test).
    const digest = res.body.data.url
      .slice('/uploads/shards/'.length)
      .split('/')
      .pop()!
      .replace(/\.mp4$/, '');
    await authorizeDigest(prisma, userAId, digest);
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

  it('authorizes /uploads/shards/ by thread membership (member 200, non-member 403)', async () => {
    // A uploads an image → a CAS shard url embedding the digest.
    const up = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', authzPng, 'authz.png')
      .field('w', '1')
      .field('h', '1');
    expect(up.body.code).toBe(0);
    const url: string = up.body.data.url;
    const digest = url
      .slice('/uploads/shards/'.length)
      .split('/')
      .pop()!
      .replace(/\.\w+$/, '');

    // Before any message references the digest there is no MediaMessage row, so even the uploader
    // is denied — the gate is purely row-driven, never "logged-in ⇒ allowed".
    const preA = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`);
    expect(preA.status).toBe(403);

    // Create a P2P thread with A as the SOLE active participant (B is not a member).
    const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
    await prisma.threadParticipant.create({
      data: { userId: userAId, threadId: thread.id },
    });

    // A sends an IMAGE message → writeMsgToThread writes the MediaMessage authz row in-tx.
    const send = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId: thread.id,
        contentType: 'IMAGE',
        content: JSON.stringify({ url, w: 1, h: 1, size: PNG_1X1.length }),
      });
    expect(send.body.code).toBe(0);

    // The MediaMessage row now links digest → this thread.
    const mm = await prisma.mediaMessage.findFirst({ where: { digest } });
    expect(mm).not.toBeNull();
    expect(mm?.threadId).toBe(thread.id);

    // A (active member) may now read it; B (non-member) is still forbidden.
    const aGet = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`);
    expect(aGet.status).toBe(200);
    const bGet = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token2}`);
    expect(bGet.status).toBe(403);
  });

  it('serves avatars at /uploads/avatars/ to ANY authed user (auth-n only, gate-exempt)', async () => {
    const up = await request(app.getHttpServer())
      .post('/api/v1/upload/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', avatarPng, 'av.png');
    expect(up.body.code).toBe(0);
    expect(up.body.data.avatar).toMatch(
      /^\/uploads\/avatars\/.+-(?:32|64|128|256|512)\.webp$/,
    );
    const avatarUrl: string = up.body.data.avatar;
    // Avatars live outside shards/, so the per-object gate never applies — any authed user reads them
    // (they render cross-thread in lists/search/federation).
    const aGet = await request(app.getHttpServer())
      .get(avatarUrl)
      .set('Authorization', `Bearer ${token}`);
    expect(aGet.status).toBe(200);
    const bGet = await request(app.getHttpServer())
      .get(avatarUrl)
      .set('Authorization', `Bearer ${token2}`);
    expect(bGet.status).toBe(200);
  });

  it('rejects a forged Group.avatar pointing at /uploads/shards/ or an external URL', async () => {
    // The @IsValidAvatarPath DTO guard guarantees no group avatar can ever sit under the gated shards/
    // path (which would 401 under thread-membership authz) or reference an external URL the server
    // does not control. ValidationPipe → HTTP 200 + VALIDATION_FAILED (code 10000).
    const forgedShard = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'forged',
        avatar:
          '/uploads/shards/aa/bb/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png',
      });
    expect(forgedShard.body.code).toBe(BusinessCode.VALIDATION_FAILED);

    const forgedExternal = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'forged2', avatar: 'https://evil.example/g.webp' });
    expect(forgedExternal.body.code).toBe(BusinessCode.VALIDATION_FAILED);
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
