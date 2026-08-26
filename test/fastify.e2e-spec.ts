import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import {
  DatabaseService,
  type Database,
} from '../src/database/database.service';
import {
  mediaAsset,
  messageAsset,
  message,
  messageThread,
  threadParticipant,
  user,
} from '../src/database/schema';
import { BusinessCode } from '../src/common/business-code';
import { makePng } from './federation-harness';
import { seedAcceptedRelationship, seedUserWithSession } from './seed';
import { MediaMetadataService } from '../src/upload/media-metadata.service';

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

async function createThread(database: Database, userId: number) {
  const now = new Date();
  const [peer] = await database
    .insert(user)
    .values({
      account: `peer-${randomUUID().slice(0, 8)}`,
      name: 'Peer',
      hashPwd: 'x',
      updatedAt: now,
    })
    .returning({ id: user.id });
  const [thread] = await database
    .insert(messageThread)
    .values({ type: 'P2P', updatedAt: now })
    .returning({ id: messageThread.id });
  await database.insert(threadParticipant).values([
    { userId, threadId: thread.id, updatedAt: now },
    { userId: peer.id, threadId: thread.id, updatedAt: now },
  ]);
  await seedAcceptedRelationship(database, userId, peer.id);
  return thread;
}

/** Grant `userId` read access to a CAS digest by linking it to a P2P thread they're an active member
 *  of — exactly what writeMsgToThread does on a real send. Used by the serving tests so they can
 *  exercise @fastify/static BEHIND the per-object gate without the full send-message round-trip. */
async function authorizeDigest(
  database: Database,
  userId: number,
  digest: string,
): Promise<{ threadId: number; seq: number }> {
  const now = new Date();
  const [thread] = await database
    .insert(messageThread)
    .values({ type: 'P2P', updatedAt: now })
    .returning({ id: messageThread.id });
  await database
    .insert(threadParticipant)
    .values({ userId, threadId: thread.id, updatedAt: now });
  // Allocate the per-thread seq the same way writeMsgToThread does (curSeq atomic increment), so the
  // direct create mirrors a real send. Locally-authored messages have no
  // federation origin sequence.
  const [advanced] = await database
    .update(messageThread)
    .set({ curSeq: 1 })
    .where(eq(messageThread.id, thread.id))
    .returning({ curSeq: messageThread.curSeq });
  const seq = advanced.curSeq;
  const [msg] = await database
    .insert(message)
    .values({
      contentType: 'IMAGE',
      content: JSON.stringify({}),
      threadId: thread.id,
      creator: userId,
      seq,
      updatedAt: now,
    })
    .returning({ id: message.id });
  await database
    .insert(messageAsset)
    .values({ messageId: msg.id, threadId: thread.id, digest });
  return { threadId: thread.id, seq };
}

describe('Fastify adapter surfaces (docs / upload / SSE)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let token: string;
  let token2: string;
  let userAId: number;
  let avatarPng: Buffer;
  let authzPng: Buffer;
  let port: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MediaMetadataService)
      .useValue({
        fromBuffer: vi.fn(
          async (
            _input: Buffer,
            intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
          ) =>
            intent === 'IMAGE'
              ? { w: 1, h: 1 }
              : intent === 'VIDEO'
                ? { w: 1, h: 1, duration: 1 }
                : intent === 'AUDIO'
                  ? { duration: 1 }
                  : {},
        ),
      })
      .compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    // configureApp before listen(): it sets the global prefix (must precede route registration,
    // which listen() performs) and registers the multipart parser + static mounts. listen() then
    // runs init + Fastify ready() (initializing route-context lifecycle hooks).
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    port = (app.getHttpServer().address() as { port: number }).port;

    // Seed two local users + sessions directly (registration is closed; the spec needs authenticated
    // users, not the login flow). userAId is the member for the per-object media-authz tests.
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    // MediaAsset (CAS ref counts) — start clean so dedup assertions are predictable.
    await database.pool.query('TRUNCATE TABLE "MediaAsset" RESTART IDENTITY');
    const userA = await seedUserWithSession(app, 'fastify', {
      name: 'Fastify',
    });
    token = userA.token;
    userAId = userA.id;
    // Second local user for the per-object media-authz tests (the non-member).
    token2 = (await seedUserWithSession(app, 'fastify2', { name: 'Fastify2' }))
      .token;
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

  async function stageMedia(contentType: 'IMAGE' | 'VIDEO' | 'AUDIO') {
    const thread = await createThread(database.db, userAId);
    const clientMessageId = randomUUID();
    const staged = await request(app.getHttpServer())
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${token}`)
      .send({ threadId: thread.id, contentType, clientMessageId });
    expect(staged.body.code).toBe(0);
    return { thread, clientMessageId };
  }

  it('serves Swagger UI on Fastify', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/docs');
    expect(res.status).toBe(200);
  });

  it('accepts a multipart image upload and serves it back at /uploads/', async () => {
    const { clientMessageId } = await stageMedia('IMAGE');
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', PNG_1X1, 'x.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE')
      .field('w', '1')
      .field('h', '1');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    // CAS path contains only the sha256 identity; presentation metadata stays in the message.
    expect(res.body.data.url).toMatch(
      /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );
    expect(res.body.data.w).toBe(1);
    expect(res.body.data.h).toBe(1);
    expect(res.body.data.size).toBe(PNG_1X1.length);

    // The uploaded file is reachable via @fastify/static at the returned url. /uploads/* is auth-gated
    // (AccessTokenValidator via the media_token cookie OR a Bearer header) — send the Bearer token.
    // The per-object gate further requires a MediaMessage row tying this digest to a thread the caller
    // is in; authorize it (a real send would write that row in writeMsgToThread).
    const digest = res.body.data.url
      .slice('/uploads/msg-assets/'.length)
      .split('/')
      .pop()!
      .replace(/\.png$/, '');
    const context = await authorizeDigest(database.db, userAId, digest);
    const file = await request(app.getHttpServer())
      .get(
        `${res.body.data.url}?threadId=${context.threadId}&seq=${context.seq}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/octet-stream');
  });

  it('dedupes concurrent identical uploads and atomically counts both references', async () => {
    // Two uploads of byte-identical content (different client filenames) must land on the same
    // sha256-keyed path — that is the whole point of content-addressed storage.
    const [firstStage, secondStage] = await Promise.all([
      stageMedia('IMAGE'),
      stageMedia('IMAGE'),
    ]);
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/upload')
        .set('Authorization', `Bearer ${token}`)
        .set('x-client-message-id', firstStage.clientMessageId)
        .attach('file', PNG_1X1, 'a.png')
        .field('partId', randomUUID())
        .field('position', '0')
        .field('intent', 'IMAGE')
        .field('w', '1')
        .field('h', '1'),
      request(app.getHttpServer())
        .post('/api/v1/upload')
        .set('Authorization', `Bearer ${token}`)
        .set('x-client-message-id', secondStage.clientMessageId)
        .attach('file', PNG_1X1, 'b.png')
        .field('partId', randomUUID())
        .field('position', '0')
        .field('intent', 'IMAGE')
        .field('w', '1')
        .field('h', '1'),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.url).toBe(first.body.data.url);
    expect(second.body.data.size).toBe(first.body.data.size);
    const digest = first.body.data.url
      .slice('/uploads/msg-assets/'.length)
      .split('/')
      .pop()!
      .replace(/\.png$/, '');
    const [asset] = await database.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.digest, digest))
      .limit(1);
    expect(asset?.isDeleted).toBe(false);
  });

  it('promotes a staged IMAGE send on upload and persists size in Message.content', async () => {
    // The staged-send → upload → promote flow: POST /send-media records the intent, then POST /upload
    // carrying the same x-client-message-id promotes it to a real Message whose content is the server-
    // authored {url,w,h,size}. `size` (the real buffer length from saveCas) MUST land in the persisted
    // content — parseImageContent reads it back to render the meta bar; drop it and every reloaded /
    // SSE-echoed / received image renders "unknown size".
    const thread = await createThread(database.db, userAId);
    const cid = randomUUID();

    const stage = await request(app.getHttpServer())
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId: thread.id,
        contentType: 'IMAGE',
        clientMessageId: cid,
      });
    expect(stage.body.code).toBe(0);

    const up = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', cid)
      .attach('file', PNG_1X1, 'promote.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE')
      .field('w', '2')
      .field('h', '2');
    expect(up.status).toBe(200);
    expect(up.body.code).toBe(0);
    expect(up.body.data.size).toBe(PNG_1X1.length);

    const [msg] = await database.db
      .select()
      .from(message)
      .where(eq(message.clientMessageId, cid))
      .limit(1);
    expect(msg).toBeDefined();
    const content = JSON.parse(msg!.content);
    expect(content.url).toBe(
      `${up.body.data.url}?threadId=${thread.id}&seq=${msg!.seq}`,
    );
    expect(content.w).toBe(1);
    expect(content.h).toBe(1);
    // The regression: size was omitted from the promote payload, so the persisted content lacked it.
    expect(content.size).toBe(PNG_1X1.length);
  });

  it('promotes an unsupported chat image as FILE without failing the upload', async () => {
    const thread = await createThread(database.db, userAId);
    const cid = randomUUID();
    const heic = Buffer.from('unsupported-heic-fixture');

    const stage = await request(app.getHttpServer())
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId: thread.id,
        contentType: 'IMAGE',
        clientMessageId: cid,
      });
    expect(stage.body.code).toBe(0);

    const up = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', cid)
      .attach('file', heic, {
        filename: 'phone.heic',
        contentType: 'image/heic',
      })
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE')
      .field('w', '4032')
      .field('h', '3024');
    expect(up.status).toBe(200);
    expect(up.body.code).toBe(0);
    expect(up.body.data.name).toBe('phone.heic');
    expect(up.body.data.mimeType).toBe('image/heic');
    expect(up.body.data.size).toBe(heic.length);
    expect(up.body.data.url).toMatch(
      /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );

    const [msg] = await database.db
      .select()
      .from(message)
      .where(eq(message.clientMessageId, cid))
      .limit(1);
    expect(msg?.contentType).toBe('FILE');
    expect(JSON.parse(msg!.content)).toMatchObject({
      name: up.body.data.name,
      mimeType: up.body.data.mimeType,
      size: up.body.data.size,
      url: expect.stringContaining(`?threadId=${thread.id}&seq=${msg!.seq}`),
    });

    const download = await request(app.getHttpServer())
      .get(JSON.parse(msg!.content).url)
      .set('Authorization', `Bearer ${token}`);
    expect(download.status).toBe(200);
    // The CAS response is presentation-neutral; the FILE message name is applied by the frontend's
    // download API rather than being encoded in the shared blob response.
    expect(download.headers['content-disposition']).toBeUndefined();
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('promotes a corrupt claimed PNG as FILE instead of rejecting the upload', async () => {
    const thread = await createThread(database.db, userAId);
    const cid = randomUUID();
    const corrupt = Buffer.from('not-really-a-png');

    await request(app.getHttpServer())
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId: thread.id,
        contentType: 'IMAGE',
        clientMessageId: cid,
      });
    const up = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', cid)
      .attach('file', corrupt, {
        filename: 'broken.png',
        contentType: 'image/png',
      })
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE');

    expect(up.status).toBe(200);
    expect(up.body.code).toBe(0);
    expect(up.body.data.name).toBe('broken.png');
    expect(up.body.data.mimeType).toBe('image/png');
    const [msg] = await database.db
      .select()
      .from(message)
      .where(eq(message.clientMessageId, cid))
      .limit(1);
    expect(msg?.contentType).toBe('FILE');
    expect(JSON.parse(msg!.content)).toMatchObject({
      name: up.body.data.name,
      mimeType: up.body.data.mimeType,
      size: up.body.data.size,
      url: expect.stringContaining(`?threadId=${thread.id}&seq=${msg!.seq}`),
    });
  });

  it('accepts a video upload (magic-byte container check) and serves it inline', async () => {
    const { clientMessageId } = await stageMedia('VIDEO');
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', MP4_MIN, 'clip.mp4')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'VIDEO');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(
      /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );
    expect(res.body.data.mimeType).toBe('video/mp4');
    expect(res.body.data.size).toBe(MP4_MIN.length);
    // Video is served INLINE (no Content-Disposition: attachment) so <video src> can stream-play.
    // Authorize the digest for the uploader so the per-object gate permits the GET (see image test).
    const digest = res.body.data.url
      .slice('/uploads/msg-assets/'.length)
      .split('/')
      .pop()!
      .replace(/\.mp4$/, '');
    const context = await authorizeDigest(database.db, userAId, digest);
    const file = await request(app.getHttpServer())
      .get(
        `${res.body.data.url}?threadId=${context.threadId}&seq=${context.seq}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBeUndefined();
  });

  it('rejects forged video bytes for a staged VIDEO intent', async () => {
    const { clientMessageId } = await stageMedia('VIDEO');
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', Buffer.from('not a video, just text'), 'fake.mp4')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'VIDEO');
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe(0); // VALIDATION_FAILED — magic-byte gate rejected it
  });

  it('accepts an audio upload (ogg container)', async () => {
    const { clientMessageId } = await stageMedia('AUDIO');
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', OGG_MIN, 'voice.ogg')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'AUDIO');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(
      /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );
    expect(res.body.data.mimeType).toBe('audio/ogg');
  });

  it('authorizes /uploads/msg-assets/ by thread membership (member 200, non-member 404)', async () => {
    // A uploads an image → a CAS shard url embedding the digest.
    const { thread, clientMessageId } = await stageMedia('IMAGE');
    const up = await request(app.getHttpServer())
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', authzPng, 'authz.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE')
      .field('w', '1')
      .field('h', '1');
    expect(up.body.code).toBe(0);
    const url: string = up.body.data.url;
    const digest = url
      .slice('/uploads/msg-assets/'.length)
      .split('/')
      .pop()!
      .replace(/\.\w+$/, '');

    // Before any message references the digest there is no MediaMessage row, so even the uploader
    // is denied — the gate is purely row-driven, never "logged-in ⇒ allowed".
    const preA = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`);
    expect(preA.status).toBe(404);

    const [promoted] = await database.db
      .select({ seq: message.seq })
      .from(message)
      .where(eq(message.clientMessageId, clientMessageId))
      .limit(1);
    const contextualUrl = `${url}?threadId=${thread.id}&seq=${promoted.seq}`;

    // The MediaMessage row now links digest → this thread.
    const [mm] = await database.db
      .select()
      .from(messageAsset)
      .where(eq(messageAsset.digest, digest))
      .limit(1);
    expect(mm).toBeDefined();
    expect(mm?.threadId).toBeGreaterThan(0);

    // A (active member) may now read it; B (non-member) is still forbidden.
    const aGet = await request(app.getHttpServer())
      .get(contextualUrl)
      .set('Authorization', `Bearer ${token}`);
    expect(aGet.status).toBe(200);
    const bGet = await request(app.getHttpServer())
      .get(contextualUrl)
      .set('Authorization', `Bearer ${token2}`);
    expect(bGet.status).toBe(404);
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

  it('rejects a forged Group.avatar pointing at /uploads/cas/ or an external URL', async () => {
    // The @IsValidAvatarPath DTO guard guarantees no group avatar can ever sit under the gated shards/
    // path (which would 401 under thread-membership authz) or reference an external URL the server
    // does not control. ValidationPipe → HTTP 200 + VALIDATION_FAILED (code 10000).
    const forgedShard = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'forged',
        avatar:
          '/uploads/cas/aa/bb/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
