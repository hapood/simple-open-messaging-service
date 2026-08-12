import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federationAudienceEpoch,
  federationThreadCheckpoint,
  message,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationMemoryFeedService } from '../src/federation/federation-memory-feed.service.js';
import { FederationFeedFillState } from '../src/federation/federation-memory-feed.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';

describe('bounded in-memory federation message feed', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  const peerDomain = 'memory-feed.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await mod.close();
  });

  async function seed() {
    const now = new Date();
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
    const [alice, bob] = await database.db
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
        userId: alice.id,
        threadId: thread.id,
        joinedAt: now,
        updatedAt: now,
      },
      {
        userId: bob.id,
        threadId: thread.id,
        joinedAt: now,
        updatedAt: now,
      },
    ]);
    await database.db
      .insert(threadAudience)
      .values({ targetDomain: peerDomain, threadId: thread.id });
    const [epoch] = await database.db
      .select()
      .from(federationAudienceEpoch)
      .where(eq(federationAudienceEpoch.peerDomain, peerDomain));
    expect(epoch.fromSeq).toBe(0);
    const [stored] = await database.db
      .insert(message)
      .values({
        seq: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'hello' }),
        threadId: thread.id,
        creator: alice.id,
        updatedAt: now,
      })
      .returning();
    await database.db
      .update(messageThread)
      .set({ curSeq: 0 })
      .where(eq(messageThread.id, thread.id));
    const cursor = new FederationCursorService(database);
    await cursor.initializePeer(peerDomain, 0n);
    return { cursor, epoch, stored, thread };
  }

  it('rebuilds, serves and durably checkpoints an audience epoch', async () => {
    const { cursor, epoch } = await seed();
    const memory = new FederationMemoryFeedService(database);
    const feed = new FederationMessageFeedService(cursor, memory);

    await Promise.all([
      memory.fill(peerDomain),
      memory.offerCommitted(peerDomain, epoch.threadId, 0),
    ]);
    const first = await feed.serve(peerDomain, 0n);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      changeId: '1',
      seq: 0,
      contentType: 'PURE_TEXT',
    });

    const final = await feed.serve(peerDomain, 1n);
    expect(final.messages).toEqual([]);
    const [checkpoint] = await database.db
      .select()
      .from(federationThreadCheckpoint)
      .where(eq(federationThreadCheckpoint.epochId, epoch.id));
    expect(checkpoint.acknowledgedSeq).toBe(0);

    const restarted = new FederationMemoryFeedService(database);
    await restarted.fill(peerDomain);
    expect(restarted.size(peerDomain)).toBe(0);
  });

  it('rebases unacknowledged memory entries after restart without losing the message', async () => {
    const { cursor } = await seed();
    const firstProcess = new FederationMessageFeedService(
      cursor,
      new FederationMemoryFeedService(database),
    );
    const first = await firstProcess.serve(peerDomain, 0n);
    expect(first.messages[0].changeId).toBe('1');

    const restarted = new FederationMessageFeedService(
      cursor,
      new FederationMemoryFeedService(database),
    );
    const replay = await restarted.serve(peerDomain, 0n);
    expect(replay.messages).toHaveLength(1);
    expect(replay.messages[0]).toMatchObject({ seq: 0, changeId: '2' });
  });

  it('closes and reopens immutable audience epochs at thread seq boundaries', async () => {
    const { thread } = await seed();
    await database.db
      .update(threadAudience)
      .set({ deliverThroughChangeId: 0n })
      .where(eq(threadAudience.targetDomain, peerDomain));
    await database.db
      .update(threadAudience)
      .set({ deliverThroughChangeId: null })
      .where(eq(threadAudience.targetDomain, peerDomain));

    const epochs = await database.db
      .select()
      .from(federationAudienceEpoch)
      .where(eq(federationAudienceEpoch.peerDomain, peerDomain));
    expect(epochs).toHaveLength(2);
    expect(epochs[0]).toMatchObject({
      threadId: thread.id,
      fromSeq: 0,
      throughSeq: 0,
    });
    expect(epochs[1]).toMatchObject({
      threadId: thread.id,
      fromSeq: 1,
      throughSeq: null,
    });
  });

  it('freezes at 10,000 and resumes filling only after peer acknowledgement', async () => {
    const { cursor, stored, thread } = await seed();
    await database.db.execute(sql`
      INSERT INTO "Message" (seq, "contentType", content, "threadId", creator, "updatedAt")
      SELECT value, 'PURE_TEXT', '{"text":"bulk"}', ${thread.id}, ${stored.creator}, CURRENT_TIMESTAMP
      FROM generate_series(1, 10000) AS value
    `);
    await database.db
      .update(messageThread)
      .set({ curSeq: 10_000 })
      .where(eq(messageThread.id, thread.id));

    const memory = new FederationMemoryFeedService(database);
    expect(await memory.fill(peerDomain)).toBe(FederationFeedFillState.FULL);
    expect(memory.size(peerDomain)).toBe(10_000);
    expect(await cursor.readAllocatedThrough(peerDomain)).toBe(10_000n);

    const feed = new FederationMessageFeedService(cursor, memory);
    const first = await feed.serve(peerDomain, 0n, 200);
    expect(first.messages).toHaveLength(200);
    const second = await feed.serve(peerDomain, 200n, 200);
    expect(second.messages).toHaveLength(200);
    expect(await cursor.readAllocatedThrough(peerDomain)).toBe(10_001n);
    expect(memory.size(peerDomain)).toBe(9_801);
    expect(memory.state(peerDomain)).toBe(FederationFeedFillState.CAUGHT_UP);
  });
});
