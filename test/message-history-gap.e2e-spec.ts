import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMessageDigest } from './support/message-fixture.js';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationThreadHistoryGap,
  message,
  messageThread,
  accountThreadState,
  deletedMessage,
} from '../src/database/schema.js';
import { ContentType } from '../src/database/enums.js';
import {
  seedAcceptedRelationship,
  seedSession,
  seedUser,
  seedFederatedPeerNamespace,
} from './seed.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('client message history gaps', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let threadId: number;
  let viewerId: number;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
    const viewer = await seedUser(app, 'viewer');
    const peer = await seedUser(app, 'peer');
    viewerId = viewer.id;
    sessionToken = await seedSession(app, viewerId, 'app');
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 50, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, viewerId, peer.id, threadId);
    await database.db.insert(message).values(
      withMessageDigest([
        {
          threadId,
          seq: 11,
          originSeq: 1,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'before gap' }),
          creatorAccount: 'peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 36,
          originSeq: 26,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'after gap' }),
          creatorAccount: 'peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    await database.db.insert(federationThreadHistoryGap).values({
      threadId,
      namespaceId: 0,
      startSeq: 5,
      endSeq: 25,
      messageSeqOffset: 10,
      recoverable: true,
    });
  });

  function queryMessages(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ threadId, ...body });
  }

  it('documents tombs as query-only responses with no content field', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/docs-json',
    );
    if (process.env.SOMS_TEST_OPENAPI_PATH) {
      await (
        await import('node:fs/promises')
      ).writeFile(
        process.env.SOMS_TEST_OPENAPI_PATH,
        JSON.stringify(response.body),
      );
    }
    const schemas = response.body.components.schemas;
    expect(schemas.MessageResponseDto.properties).toHaveProperty('originSeq');
    expect(schemas.MessageResponseDto.properties).toHaveProperty(
      'publisherNamespaceId',
    );
    expect(schemas.MessageQueryPageDto.properties).toHaveProperty(
      'resolvedAnchorSeq',
    );
    expect(schemas.MessageQueryPageDto.properties.messages.items.oneOf).toEqual(
      [
        { $ref: '#/components/schemas/MessageResponseDto' },
        { $ref: '#/components/schemas/MessageTombResponseDto' },
      ],
    );
    expect(schemas.MessageTombResponseDto.properties.contentType.enum).toEqual([
      'TOMB',
    ]);
    expect(schemas.MessageTombResponseDto.properties).not.toHaveProperty(
      'content',
    );
    expect(
      schemas.MessageResponseDto.properties.contentType.enum,
    ).not.toContain('TOMB');
  });

  it('returns body-free tomb slots in both directions with stable pagination and gap coordinates', async () => {
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx.insert(deletedMessage).values([
        { threadId, messageSeq: 11, deletionSeq: 1, type: 'USER_RETRACTION' },
        {
          threadId,
          messageSeq: 36,
          deletionSeq: 2,
          type: 'MODERATION_REMOVAL',
        },
      ]);
      await tx
        .update(message)
        .set({ isDeleted: true })
        .where(eq(message.threadId, threadId));
    });
    const first = await queryMessages({ after: 0, through: 50, take: 1 });
    expect(first.body.data).toMatchObject({
      scannedThrough: 11,
      hasMore: true,
    });
    const tomb = first.body.data.messages[0];
    expect(tomb).toMatchObject({
      threadId,
      seq: 11,
      contentType: 'TOMB',
      isDeleted: true,
      creator: {
        account: 'peer',
        namespaceId: 0,
      },
      deletionType: 'USER_RETRACTION',
    });
    expect(Object.keys(tomb).sort()).toEqual(
      [
        'threadId',
        'seq',
        'profileRev',
        'creator',
        'createdAt',
        'updatedAt',
        'contentType',
        'isDeleted',
        'deletionType',
      ].sort(),
    );
    const second = await queryMessages({ after: 11, through: 50, take: 1 });
    expect(second.body.data).toMatchObject({
      scannedThrough: 50,
      hasMore: false,
      messages: [
        { seq: 36, contentType: 'TOMB', deletionType: 'MODERATION_REMOVAL' },
      ],
      gaps: [{ startSeq: 15, endSeq: 35, recoverable: true }],
    });
    const reverse = await queryMessages({ before: 51, through: 1, take: 1 });
    expect(reverse.body.data).toMatchObject({
      scannedThrough: 36,
      hasMore: true,
      messages: [{ seq: 36, contentType: 'TOMB' }],
    });
    const tail = await queryMessages({ before: 36, through: 1, take: 1 });
    expect(tail.body.data).toMatchObject({
      scannedThrough: 1,
      hasMore: false,
      messages: [{ seq: 11, contentType: 'TOMB' }],
    });
  });

  it('keeps live enrichment separate and does not expose deleted media content', async () => {
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx.insert(deletedMessage).values({
        threadId,
        messageSeq: 11,
        deletionSeq: 1,
        type: 'USER_RETRACTION',
      });
      await tx
        .update(message)
        .set({
          isDeleted: true,
          contentType: ContentType.IMAGE,
          content: JSON.stringify({
            privateBody: 'must not be parsed or returned',
          }),
        })
        .where(eq(message.seq, 11));
    });
    const result = await queryMessages({ after: 0, through: 50, take: 10 });
    expect(
      result.body.data.messages.map(
        (row: { contentType: string }) => row.contentType,
      ),
    ).toEqual(['TOMB', 'PURE_TEXT']);
    expect(result.body.data.messages[0]).not.toHaveProperty('content');
    expect(result.body.data.messages[0]).not.toHaveProperty('mediaStatus');
    expect(result.body.data.messages[1]).toHaveProperty('content');
  });

  it('resolves origin anchors to local coordinates without exposing quote digests', async () => {
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      'anchor.example.test',
    );
    await database.db
      .update(message)
      .set({
        publisherNamespaceId: namespaceId,
        originSeq: 26,
        content: JSON.stringify({
          text: 'reply',
          quote: { seq: 1, namespaceId, digest: 'd'.repeat(64) },
        }),
      })
      .where(eq(message.seq, 36));
    const result = await queryMessages({
      anchorNamespaceId: namespaceId,
      anchorOriginSeq: 26,
      take: 1,
    });
    expect(result.body.code).toBe(0);
    expect(result.body.data.resolvedAnchorSeq).toBe(36);
    expect(result.body.data.messages[0].seq).toBe(36);
    const localAlias = await queryMessages({
      anchorNamespaceId: 0,
      anchorOriginSeq: 36,
      take: 1,
    });
    expect(localAlias.body.data.resolvedAnchorSeq).toBe(36);
    expect(JSON.parse(result.body.data.messages[0].content).quote).toEqual({
      namespaceId,
      originSeq: 1,
    });
    const [stored] = await database.db
      .select({ content: message.content })
      .from(message)
      .where(eq(message.seq, 36));
    expect(JSON.parse(stored.content).quote.digest).toBe('d'.repeat(64));
    await database.db
      .update(accountThreadState)
      .set({ messageVisibleThroughSeq: 20 })
      .where(eq(accountThreadState.accountId, viewerId));
    const hidden = await queryMessages({
      anchorNamespaceId: namespaceId,
      anchorOriginSeq: 26,
      take: 1,
    });
    expect(hidden.body.data.resolvedAnchorSeq).toBeNull();
    expect(hidden.body.data.messages).toEqual([]);
  });

  it('resolves a local tomb anchor while keeping the tomb contract local-only', async () => {
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx.insert(deletedMessage).values({
        threadId,
        messageSeq: 36,
        deletionSeq: 1,
        type: 'USER_RETRACTION',
      });
      await tx
        .update(message)
        .set({ isDeleted: true })
        .where(eq(message.seq, 36));
    });
    const result = await queryMessages({ anchorSeq: 36, take: 1 });
    expect(result.body.code).toBe(0);
    expect(result.body.data.resolvedAnchorSeq).toBe(36);
    expect(result.body.data.messages[0]).toMatchObject({
      seq: 36,
      contentType: 'TOMB',
    });
    expect(result.body.data.messages[0]).not.toHaveProperty('originSeq');
    expect(result.body.data.messages[0]).not.toHaveProperty('content');
  });

  it('clips the backward endpoint while validating the starting cursor', async () => {
    const bootstrap = await queryMessages({});
    expect(bootstrap.body.code).toBe(30006);
    const { resumeAfter, resumeBefore } = bootstrap.body.data;
    const invalid = await queryMessages({
      before: resumeAfter + 1,
      through: 0,
      take: 50,
    });
    expect(invalid.body.code).toBe(30006);
    const valid = await queryMessages({
      before: resumeBefore,
      through: 0,
      take: 50,
    });
    expect(valid.body.code).toBe(0);
    expect(
      valid.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([36, 11]);
    expect(valid.body.data.scannedThrough).toBe(resumeAfter + 1);
  });

  it('clips backward history to the cleared boundary instead of rejecting its endpoint', async () => {
    await database.db
      .update(messageThread)
      .set({ clearedSeq: 10 })
      .where(eq(messageThread.id, threadId));
    const response = await queryMessages({ before: 51, through: 0, take: 50 });
    expect(response.body.code).toBe(0);
    expect(response.body.data.scannedThrough).toBe(11);
    expect(
      response.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([36, 11]);
  });

  it('returns the full locally translated gap when only part intersects the scan', async () => {
    const response = await queryMessages({ after: 10, through: 20, take: 10 });

    expect(response.body.code).toBe(0);
    expect(
      response.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([11]);
    expect(response.body.data.gaps).toEqual([
      { startSeq: 15, endSeq: 35, recoverable: true },
    ]);
    expect(response.body.data).toMatchObject({
      scannedThrough: 20,
      hasMore: false,
    });
  });

  it('clips a full gap to the participant visibility window', async () => {
    await database.db
      .update(accountThreadState)
      .set({ messageVisibleThroughSeq: 30 })
      .where(eq(accountThreadState.accountId, viewerId));

    const response = await queryMessages({ after: 10, through: 20, take: 10 });

    expect(response.body.code).toBe(0);
    expect(response.body.data.gaps).toEqual([
      { startSeq: 15, endSeq: 30, recoverable: true },
    ]);
  });
});
