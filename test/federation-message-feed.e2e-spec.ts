import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationMemoryFeedService } from '../src/federation/federation-memory-feed.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';

describe('FederationMessageFeedService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let cursor: FederationCursorService;
  let memory: FederationMemoryFeedService;
  let service: FederationMessageFeedService;
  const peerDomain = 'missed-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    cursor = new FederationCursorService(database);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer", "MediaAsset" RESTART IDENTITY CASCADE',
    );
    memory = new FederationMemoryFeedService(database);
    service = new FederationMessageFeedService(cursor, memory);
  });

  afterAll(async () => {
    await mod.close();
  });

  async function seedP2pChange() {
    const now = new Date();
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'trusted',
    });
    const [author, remote] = await database.db
      .insert(user)
      .values([
        {
          account: 'alice',
          name: 'Alice',
          isForeigner: false,
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'bob',
          name: 'Bob',
          isForeigner: true,
          domain: peerDomain,
          updatedAt: now,
        },
      ])
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning();
    await database.db.insert(threadParticipant).values([
      {
        userId: author.id,
        threadId: thread.id,
        joinedAt: now,
        updatedAt: now,
      },
      {
        userId: remote.id,
        threadId: thread.id,
        joinedAt: now,
        updatedAt: now,
      },
    ]);
    await database.db
      .insert(threadAudience)
      .values({ targetDomain: peerDomain, threadId: thread.id });
    const [msg] = await database.db
      .insert(message)
      .values({
        seq: 0,
        contentType: 'IMAGE',
        content: JSON.stringify({ url: '/uploads/cas/aa/file.png' }),
        threadId: thread.id,
        creator: author.id,
        updatedAt: now,
        originSeq: 0,
      })
      .returning();
    await database.db
      .update(messageThread)
      .set({ curSeq: 0 })
      .where(eq(messageThread.id, thread.id));
    await database.db.insert(mediaAsset).values({
      digest: 'a'.repeat(64),
      bytes: 123n,
      status: 'READY',
    });
    await database.db.insert(messageAsset).values({
      messageId: msg.id,
      threadId: thread.id,
      digest: 'a'.repeat(64),
    });

    await cursor.initializePeer(peerDomain, 0n);
    return { author, msg, thread };
  }

  it('returns bodies and asset descriptors from the memory feed', async () => {
    await seedP2pChange();
    const page = await service.serve(peerDomain, 0n);

    expect(page).toMatchObject({
      scannedThrough: '1',
      allocatedThrough: '1',
      hasMore: false,
      degradation: null,
      messages: [
        {
          changeId: '1',
          thread: {
            type: 'P2P',
            participants: expect.arrayContaining([
              { account: 'alice', domain: process.env.SOMS_DOMAIN },
              { account: 'bob', domain: peerDomain },
            ]),
          },
          author: { account: 'alice', domain: process.env.SOMS_DOMAIN },
          seq: 0,
          originSeq: 0,
          contentType: 'IMAGE',
          assets: [{ digest: 'a'.repeat(64), bytes: '123', status: 'READY' }],
        },
      ],
    });
  });

  it('enforces the hard page-size bound', async () => {
    await expect(service.serve(peerDomain, 0n, 201)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('binds each signed peer to only its own discovery target', async () => {
    await seedP2pChange();
    const otherPeer = 'other-peer.test';
    await database.db.insert(federatedPeer).values({
      domain: otherPeer,
      trustLevel: 'trusted',
    });
    await cursor.initializePeer(otherPeer, 0n);

    const [allocated, isolated] = await Promise.all([
      service.serve(peerDomain, 0n),
      service.serve(otherPeer, 0n),
    ]);

    expect(allocated.messages).toHaveLength(1);
    expect(isolated).toEqual({
      messages: [],
      scannedThrough: '0',
      allocatedThrough: '0',
      hasMore: false,
      degradation: null,
    });
  });

  it('skips deleted messages while acknowledging their allocated change ids', async () => {
    const { msg } = await seedP2pChange();
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.id, msg.id));

    const page = await service.serve(peerDomain, 0n);

    expect(page).toEqual({
      messages: [],
      scannedThrough: '1',
      allocatedThrough: '1',
      hasMore: false,
      degradation: null,
    });
  });

  it('paginates surviving messages by memory change id', async () => {
    const { author, thread } = await seedP2pChange();
    const now = new Date();
    await database.db
      .insert(message)
      .values([
        {
          seq: 1,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'second' }),
          threadId: thread.id,
          creator: author.id,
          updatedAt: now,
          originSeq: 1,
        },
        {
          seq: 2,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'third' }),
          threadId: thread.id,
          creator: author.id,
          updatedAt: now,
          originSeq: 2,
        },
      ])
      .returning();
    await database.db
      .update(messageThread)
      .set({ curSeq: 2 })
      .where(eq(messageThread.id, thread.id));

    const first = await service.serve(peerDomain, 0n, 2);
    const second = await service.serve(peerDomain, 2n, 2);

    expect(first.messages.map((item) => item.changeId)).toEqual(['1', '2']);
    expect(first).toMatchObject({
      scannedThrough: '2',
      allocatedThrough: '3',
      hasMore: true,
    });
    expect(second.messages.map((item) => item.changeId)).toEqual(['3']);
    expect(second).toMatchObject({
      scannedThrough: '3',
      allocatedThrough: '3',
      hasMore: false,
    });
  });
});
