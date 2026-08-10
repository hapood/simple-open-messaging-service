import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  discoveryChange,
  discoveryTarget,
  federatedPeer,
  federationServeCursor,
  messageThread,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationMessageFeedGcService } from '../src/federation/federation-message-feed-gc.service.js';
import { BusinessCode } from '../src/common/business-code.js';

describe('FederationMessageFeedGcService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let cursor: FederationCursorService;
  let gc: FederationMessageFeedGcService;
  const peerDomain = 'gc-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    cursor = new FederationCursorService(database);
    gc = new FederationMessageFeedGcService(database);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer", "DiscoveryTarget" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await mod.close();
  });

  async function seedChanges(count: number) {
    const now = new Date();
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'trusted',
    });
    const [author] = await database.db
      .insert(user)
      .values({
        account: 'alice',
        name: 'Alice',
        isForeigner: false,
        domain: 'local',
        updatedAt: now,
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning({ id: messageThread.id });
    const [audience] = await database.db
      .insert(threadAudience)
      .values({ targetDomain: peerDomain, threadId: thread.id })
      .returning({ id: threadAudience.id });
    await cursor.initializePeer(peerDomain, 0n);
    const target = await database.db.query.discoveryTarget.findFirst({
      where: eq(discoveryTarget.targetDomain, peerDomain),
    });
    await database.db.execute(sql`
      INSERT INTO "Message" (seq, "contentType", content, "threadId", creator, "updatedAt")
      SELECT value, 'PURE_TEXT', '{"text":"gc"}', ${thread.id}, ${author.id}, CURRENT_TIMESTAMP
      FROM generate_series(1, ${count}) AS value
    `);
    await database.db.execute(sql`
      WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY id)::bigint AS "changeId"
        FROM "Message"
        WHERE "threadId" = ${thread.id}
      )
      INSERT INTO "DiscoveryChange" ("targetId", "changeId", "audienceId", "threadId", "messageId")
      SELECT ${target!.id}, numbered."changeId", ${audience.id}, ${thread.id}, numbered.id
      FROM numbered
    `);
    await database.db
      .update(discoveryTarget)
      .set({ allocatedThrough: BigInt(count) })
      .where(eq(discoveryTarget.id, target!.id));
    return { targetId: target!.id };
  }

  it('physically deletes acknowledged changes without breaking retry at the acknowledged cursor', async () => {
    const { targetId } = await seedChanges(5);
    await cursor.servePage(peerDomain, 0n, async () => ({
      value: null,
      scannedThrough: 3n,
    }));
    await cursor.servePage(peerDomain, 3n, async () => ({
      value: null,
      scannedThrough: 5n,
    }));

    await gc.runOnce();
    expect(
      await database.db
        .select({ changeId: discoveryChange.changeId })
        .from(discoveryChange)
        .where(eq(discoveryChange.targetId, targetId)),
    ).toEqual([{ changeId: 4n }, { changeId: 5n }]);
    await expect(
      cursor.servePage(peerDomain, 3n, async () => ({
        value: 'retry',
        scannedThrough: 5n,
      })),
    ).resolves.toEqual({ value: 'retry', scannedThrough: 5n });
  });

  it('halves an over-limit target and atomically advances its retained floor', async () => {
    const { targetId } = await seedChanges(10_001);
    await gc.runOnce();
    const remaining = await database.db.execute<{
      count: number;
      minimum: bigint;
    }>(sql`
      SELECT COUNT(*)::int AS count, MIN("changeId") AS minimum
      FROM "DiscoveryChange"
      WHERE "targetId" = ${targetId}
    `);
    expect(remaining.rows[0]?.count).toBe(5_001);
    expect(BigInt(remaining.rows[0]!.minimum)).toBe(5_001n);
    const serve = await database.db.query.federationServeCursor.findFirst({
      where: eq(federationServeCursor.peerDomain, peerDomain),
    });
    expect(serve).toMatchObject({
      startChangeId: 5_000n,
      acknowledgedThrough: 5_000n,
      lastServedThrough: 5_000n,
    });
    await expect(
      cursor.servePage(peerDomain, 0n, async () => ({
        value: null,
        scannedThrough: 0n,
      })),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MISSED_CURSOR_INVALID,
      data: {
        availableCursor: '5000',
        startChangeId: '5000',
        allocatedThrough: '10001',
      },
    });
  });

  it('does not run when another process holds the global GC singleton lock', async () => {
    const { targetId } = await seedChanges(2);
    const lockClient = await database.pool.connect();
    try {
      await lockClient.query(
        `SELECT pg_advisory_lock(hashtextextended('federation-message-feed-gc', 0))`,
      );
      await database.db
        .update(federationServeCursor)
        .set({ acknowledgedThrough: 2n, lastServedThrough: 2n })
        .where(eq(federationServeCursor.peerDomain, peerDomain));
      await gc.runOnce();
      const rows = await database.db
        .select({ changeId: discoveryChange.changeId })
        .from(discoveryChange)
        .where(eq(discoveryChange.targetId, targetId));
      expect(rows).toHaveLength(2);
    } finally {
      await lockClient.query(
        `SELECT pg_advisory_unlock(hashtextextended('federation-message-feed-gc', 0))`,
      );
      lockClient.release();
    }
  });
});
