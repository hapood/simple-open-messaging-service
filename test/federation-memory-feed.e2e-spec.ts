import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federationMessageDelivery,
  federationMessageFeedAllocation,
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
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../src/federation/federation-audience.js';

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
    const [audience] = await database.db
      .insert(threadAudience)
      .values({
        targetDomain: peerDomain,
        threadId: thread.id,
        messageScannedThroughSeq: -1,
      })
      .returning();
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
    return { cursor, audience, stored, thread, alice, bob };
  }

  it('rebuilds, serves and durably advances the current audience', async () => {
    const { cursor, audience } = await seed();
    const memory = new FederationMemoryFeedService(database);
    const feed = new FederationMessageFeedService(cursor, memory);

    await Promise.all([
      memory.fill(peerDomain),
      memory.offerCommitted(peerDomain, audience.threadId, 0),
    ]);
    const first = await feed.serve(peerDomain, 0n);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      feedId: '1',
      seq: 0,
      contentType: 'PURE_TEXT',
    });

    const final = await feed.serve(peerDomain, 1n);
    expect(final.messages).toEqual([]);
    const [advanced] = await database.db
      .select()
      .from(threadAudience)
      .where(eq(threadAudience.id, audience.id));
    expect(advanced.messageScannedThroughSeq).toBe(0);
    expect(
      await database.db
        .select()
        .from(federationMessageFeedAllocation),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(federationMessageDelivery),
    ).toHaveLength(1);

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
    expect(first.messages[0].feedId).toBe('1');

    const restarted = new FederationMessageFeedService(
      cursor,
      new FederationMemoryFeedService(database),
    );
    const replay = await restarted.serve(peerDomain, 0n);
    expect(replay.messages).toHaveLength(1);
    expect(replay.messages[0]).toMatchObject({ seq: 0, feedId: '1' });
  });

  it('reopens the same audience at the latest committed thread boundary', async () => {
    const { thread, stored } = await seed();
    await database.db.transaction((tx) =>
      closeFederatedAudienceInTx(tx, peerDomain, thread.id),
    );
    await database.db.insert(message).values({
      seq: 1,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'gap' }),
      threadId: thread.id,
      creator: stored.creator,
      updatedAt: new Date(),
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, thread.id));
    await database.db.transaction((tx) =>
      openFederatedAudienceInTx(tx, peerDomain, thread.id),
    );

    const [audience] = await database.db
      .select()
      .from(threadAudience)
      .where(eq(threadAudience.targetDomain, peerDomain));
    expect(audience).toMatchObject({
      threadId: thread.id,
      deliverThroughChangeId: null,
      messageScannedThroughSeq: 1,
    });
  });

  it('bounds a fill turn and rotates to another audience on the next turn', async () => {
    const { cursor, stored, thread, alice, bob } = await seed();
    await database.db.execute(sql`
      INSERT INTO "Message" (seq, "contentType", content, "threadId", creator, "updatedAt")
      SELECT value, 'PURE_TEXT', '{"text":"bulk"}', ${thread.id}, ${stored.creator}, CURRENT_TIMESTAMP
      FROM generate_series(1, 600) AS value
    `);
    await database.db
      .update(messageThread)
      .set({ curSeq: 600 })
      .where(eq(messageThread.id, thread.id));

    const now = new Date();
    const [otherThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning();
    await database.db.insert(threadParticipant).values([
      {
        userId: alice.id,
        threadId: otherThread.id,
        joinedAt: now,
        updatedAt: now,
      },
      {
        userId: bob.id,
        threadId: otherThread.id,
        joinedAt: now,
        updatedAt: now,
      },
    ]);
    await database.db.insert(threadAudience).values({
      targetDomain: peerDomain,
      threadId: otherThread.id,
      messageScannedThroughSeq: -1,
    });
    await database.db.insert(message).values({
      seq: 0,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'other thread' }),
      threadId: otherThread.id,
      creator: alice.id,
      updatedAt: now,
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: 0 })
      .where(eq(messageThread.id, otherThread.id));

    const memory = new FederationMemoryFeedService(database);
    await expect(memory.fillQuantum(peerDomain, 200)).resolves.toEqual({
      state: FederationFeedFillState.NEEDS_FILL,
      work: 200,
    });
    expect(memory.size(peerDomain)).toBe(200);

    await expect(memory.fillQuantum(peerDomain, 200)).resolves.toMatchObject({
      state: FederationFeedFillState.NEEDS_FILL,
      work: 200,
    });
    expect((await memory.readAfter(peerDomain, 200n, 1))[0]).toMatchObject({
      feedId: 201n,
      threadId: otherThread.id,
    });
    expect(await cursor.readAllocatedThrough(peerDomain)).toBe(400n);
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
    expect(await cursor.readAllocatedThrough(peerDomain)).toBe(10_000n);
    expect(memory.size(peerDomain)).toBe(9_800);
    expect(memory.state(peerDomain)).toBe(FederationFeedFillState.NEEDS_FILL);
  });
});
