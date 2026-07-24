import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { LinkPreviewService } from '../src/link-preview/link-preview.service.js';
import { registerAndLogin } from './federation-test-helpers';

/**
 * LINK message send contract (single instance). The client sends only the URL; the server rebuilds the
 * card via LinkPreviewService (mocked here to avoid real outbound OG fetches), validates the assembled
 * JSON with parseLinkContent, and — because the card's og:image is a CAS shard URL — writeMsgToThread's
 * extractDigests writes a MediaMessage authz row so /uploads/shards/* admits thread readers. Pins three
 * load-bearing behaviors at once: server-authoritative content rebuild, the stored-content form check,
 * and the auto authz row (the federated receiver's localizeMedia relies on that same digest).
 */
describe('LINK message send (single instance)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  // A fake card the mocked LinkPreviewService "built" — the og:image is the thumbnail's sha256 DIGEST
  // (the form the real service stores in the DB; the wire serializer inlines the base64 on read).
  const DIGEST = 'a'.repeat(64);
  const CARD = {
    url: 'https://example.com/page',
    title: 'Example Page',
    description: 'A page about things.',
    siteName: 'Example',
    image: DIGEST,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LinkPreviewService)
      .useValue({ buildCardContent: async () => ({ ...CARD }) })
      .compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    const address = (
      app.getHttpServer() as { address: () => { port: number } | string | null }
    ).address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('rebuilds the card server-side from the URL and stores the og:image digest (not base64) in content', async () => {
    const appLike = { baseUrl, prisma };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const bob = await registerAndLogin(appLike, 'bob', 'Bob');

    // Alice befriends Bob → both get the P2P thread.
    await request(baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ toUserId: bob.id })
      .expect((res) => expect(res.body.code).toBe(0));
    const invite = await prisma.invite.findFirst({
      where: { kind: 'FRIEND', fromUserId: alice.id, toUserId: bob.id },
    });
    const accept = await request(baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ inviteId: invite!.id.toString() });
    const threadId: number = accept.body.data.threadId;

    // Alice sends a LINK message — only the bare URL on the wire.
    const send = await request(baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ threadId, content: 'https://example.com/page', contentType: 'LINK' });
    expect(send.status).toBe(200);
    expect(send.body.code).toBe(0); // parseLinkContent passed (else VALIDATION_FAILED)

    // The stored content is the SERVER-REBUILT card (not the bare URL the client sent).
    const msg = await prisma.message.findFirst({
      where: { threadId },
      orderBy: { seq: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.contentType).toBe('LINK');
    // The DB stores the image DIGEST (small) — NOT the base64 (the wire serializer inlines it on read).
    expect(JSON.parse(msg!.content)).toEqual(CARD);
    expect((JSON.parse(msg!.content) as { image: string }).image).toBe(DIGEST);
    // LINK no longer touches CAS: no MediaMessage authz row (the thumbnail is inlined, not a shard).
    expect(await prisma.mediaMessage.count({ where: { threadId } })).toBe(0);
  });

  it('degrades to a bare-link card when the page has no usable metadata (no MediaMessage row)', async () => {
    // Swap the mock to a bare card (no image → no shard URL → no authz row).
    (app.get(LinkPreviewService) as { buildCardContent: unknown }).buildCardContent = async () => ({
      url: 'https://example.com/bare',
    });

    const appLike = { baseUrl, prisma };
    const alice = await registerAndLogin(appLike, 'alice2', 'Alice2');
    const bob = await registerAndLogin(appLike, 'bob2', 'Bob2');
    await request(baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ toUserId: bob.id })
      .expect((res) => expect(res.body.code).toBe(0));
    const invite = await prisma.invite.findFirst({
      where: { kind: 'FRIEND', fromUserId: alice.id, toUserId: bob.id },
    });
    const accept = await request(baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ inviteId: invite!.id.toString() });
    const threadId: number = accept.body.data.threadId;

    const send = await request(baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ threadId, content: 'https://example.com/bare', contentType: 'LINK' });
    expect(send.body.code).toBe(0);

    const msg = await prisma.message.findFirst({
      where: { threadId },
      orderBy: { seq: 'desc' },
    });
    expect(JSON.parse(msg!.content)).toEqual({ url: 'https://example.com/bare' });
    // No image → no shard digest → no MediaMessage authz row.
    expect(await prisma.mediaMessage.count({ where: { threadId } })).toBe(0);
  });
});
