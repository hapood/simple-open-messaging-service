import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { messageAsset, message } from '../src/database/schema';
import { LinkPreviewService } from '../src/link-preview/link-preview.service.js';
import { registerAndLogin } from './federation-test-helpers';
import {
  waitForAcceptedDurableTask,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';
import { findP2PRelationship } from './seed.js';

/**
 * LINK message send contract (single instance). The client sends only the URL; the server rebuilds the
 * card via LinkPreviewService (mocked here to avoid real outbound OG fetches), validates the assembled
 * JSON with parseLinkContent, and — because the card's og:image is a CAS shard URL — writeMsgToThread's
 * extractDigests writes MessageAsset authz rows so /uploads/msg-assets/* admits thread readers. Pins
 * load-bearing behaviors at once: server-authoritative content rebuild, the stored-content form check,
 * and the auto authz row (the federated receiver's localizeMedia relies on that same digest).
 */
describe('LINK message send (single instance)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let baseUrl: string;

  // A fake card the mocked LinkPreviewService built with two shared-CAS assets.
  const DIGEST = 'a'.repeat(64);
  const CARD = {
    url: 'https://example.com/page',
    title: 'Example Page',
    description: 'A page about things.',
    image: `/uploads/msg-assets/aa/aa/${DIGEST}`,
    favicon: `/uploads/msg-assets/bb/bb/${'b'.repeat(64)}`,
  };
  let generatedCard: {
    url: string;
    title: string;
    description: string;
    image?: string;
    favicon?: string;
  } = CARD;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LinkPreviewService)
      .useValue({
        consumeGeneration: () => ({ ...generatedCard }),
        buildCardContent: async () => ({ ...generatedCard }),
        finishGeneration: () => undefined,
      })
      .compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    const address = (
      app.getHttpServer() as { address: () => { port: number } | string | null }
    ).address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('rebuilds the card server-side and links every card CAS asset', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const bob = await registerAndLogin(appLike, 'bob', 'Bob');

    // Alice befriends Bob → both get the P2P thread.
    const invite = await request(baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ account: 'bob', domain: 'local' });
    expect(invite.body.code).toBe(0);
    await waitForLocalRelationshipRequest(
      database.db,
      invite.body.data.taskId,
      alice.id,
      bob.id,
    );
    const accept = await request(baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ account: alice.account, domain: 'local' });
    await waitForAcceptedDurableTask(database.db, accept.body);
    const threadId = (await findP2PRelationship(database.db, alice.id, bob.id))
      .pair?.threadId;
    if (threadId === null || threadId === undefined)
      throw new Error('friend acceptance completed without a P2P thread');

    // Alice sends a LINK message — only the bare URL on the wire.
    const send = await request(baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        threadId,
        content: 'https://example.com/page',
        contentType: 'LINK',
      });
    expect(send.status).toBe(200);
    expect(send.body.code).toBe(0); // parseLinkContent passed (else VALIDATION_FAILED)

    // The stored content is the SERVER-REBUILT card (not the bare URL the client sent).
    const [storedMessage] = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, threadId))
      .orderBy(desc(message.seq))
      .limit(1);
    expect(storedMessage).toBeDefined();
    expect(storedMessage.contentType).toBe('LINK');
    expect(JSON.parse(storedMessage.content)).toEqual({
      ...CARD,
      image: `${CARD.image}?threadId=${threadId}&seq=${storedMessage.seq}`,
      favicon: `${CARD.favicon}?threadId=${threadId}&seq=${storedMessage.seq}`,
    });
    expect(await countMessageAssets(database, threadId)).toBe(2);
  });

  it('stores required empty metadata when the page has no usable metadata', async () => {
    // Missing metadata is valid, but required fields remain present as empty strings.
    generatedCard = {
      url: 'https://example.com/bare',
      title: '',
      description: '',
    };

    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice2', 'Alice2');
    const bob = await registerAndLogin(appLike, 'bob2', 'Bob2');
    const invite = await request(baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ account: 'bob2', domain: 'local' })
      .expect((res) => expect(res.body.code).toBe(0));
    await waitForLocalRelationshipRequest(
      database.db,
      invite.body.data.taskId,
      alice.id,
      bob.id,
    );
    const accept = await request(baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ account: alice.account, domain: 'local' });
    await waitForAcceptedDurableTask(database.db, accept.body);
    const threadId = (await findP2PRelationship(database.db, alice.id, bob.id))
      .pair?.threadId;
    if (threadId === null || threadId === undefined)
      throw new Error('friend acceptance completed without a P2P thread');

    const send = await request(baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        threadId,
        content: 'https://example.com/bare',
        contentType: 'LINK',
      });
    expect(send.body.code).toBe(0);

    const [storedMessage] = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, threadId))
      .orderBy(desc(message.seq))
      .limit(1);
    expect(JSON.parse(storedMessage.content)).toEqual({
      url: 'https://example.com/bare',
      title: '',
      description: '',
    });
    // No image → no shard digest → no MediaMessage authz row.
    expect(await countMessageAssets(database, threadId)).toBe(0);
  });
});

async function countMessageAssets(
  database: DatabaseService,
  threadId: number,
): Promise<number> {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)::int` })
    .from(messageAsset)
    .where(eq(messageAsset.threadId, threadId));
  return row.count;
}
