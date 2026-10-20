import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { account, clientStateFeed } from '../src/database/schema.js';
import { lockBusinessAccountsInTx } from '../src/common/locks/account-business-lock.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { SseService } from '../src/gateway/sse.service.js';
import { CallStateRegistry } from '../src/gateway/call-state.registry.js';

/** Request-head storage and range reads run against the isolated E2E database.
 * No AppModule or unfinished request provider is required. */
describe('ClientStateFeed request-head transport', () => {
  let database: DatabaseService;
  let feed: ClientStateFeedService;
  let sse: SseService;
  let sequence = 0;

  beforeAll(() => {
    database = new DatabaseService();
    sse = new SseService(database, new CallStateRegistry());
    feed = new ClientStateFeedService(database, sse);
  });

  afterAll(async () => {
    feed?.onModuleDestroy();
    sse?.onModuleDestroy();
    await database?.onApplicationShutdown();
  });

  async function owner() {
    const [row] = await database.db.insert(account)
      .values({ account: `request-head-${++sequence}` }).returning();
    return row;
  }

  async function publish(user: typeof account.$inferSelect, end: bigint, read: bigint) {
    return database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: user.account, profileNamespaceId: 0 },
      ]);
      await tx.update(account).set({ requestEndId: end, requestReadId: read })
        .where(eq(account.id, user.id));
      return feed.publishRequestHeadInTx(tx, user.id);
    });
  }

  it('appends complete versions and allocates nothing for an unchanged head', async () => {
    const user = await owner();
    expect(await publish(user, 9007199254740993n, 0n)).toBe(1);
    expect(await publish(user, 9007199254740993n, 0n)).toBeNull();
    expect(await publish(user, 9007199254740993n, 9007199254740993n)).toBe(2);
    const versions = await feed.query(user.id, 'full', 0, 2);
    expect(versions.sort((a, b) => a.feedId - b.feedId).map((row) => ({
      feedId: row.feedId, body: row.body,
    }))).toEqual([
      { feedId: 1, body: { requestEndId: '9007199254740993', requestReadId: '0' } },
      { feedId: 2, body: { requestEndId: '9007199254740993', requestReadId: '9007199254740993' } },
    ]);
    expect(await feed.readEndId(user.id)).toBe(2);
  });

  it('keeps heads older than seven days and honors a fixed range boundary', async () => {
    const user = await owner();
    await publish(user, 10n, 0n);
    await database.db.update(clientStateFeed)
      .set({ updatedAt: sql`CURRENT_TIMESTAMP - INTERVAL '8 days'` })
      .where(eq(clientStateFeed.userId, user.id));
    await publish(user, 11n, 0n);
    for (const mode of ['full', 'delta'] as const) {
      const old = await feed.query(user.id, mode, 0, 1);
      expect(old.map((row) => row.feedId)).toEqual([1]);
      expect(old[0].body).toEqual({ requestEndId: '10', requestReadId: '0' });
      expect((await feed.query(user.id, mode, 1, 2)).map((row) => row.feedId))
        .toEqual([2]);
      expect(await feed.query(user.id, mode, 2, 2)).toEqual([]);
    }
  });

  it('rolls back the head, allocator and appended row together', async () => {
    const user = await owner();
    await expect(database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: user.account, profileNamespaceId: 0 },
      ]);
      await tx.update(account).set({ requestEndId: 1n })
        .where(eq(account.id, user.id));
      expect(await feed.publishRequestHeadInTx(tx, user.id)).toBe(1);
      throw new Error('abort head publication');
    })).rejects.toThrow('abort head publication');
    expect(await database.db.query.account.findFirst({ where: eq(account.id, user.id) }))
      .toMatchObject({ requestEndId: 0n, requestReadId: 0n, clientStateFeedEndId: 0 });
    expect(await feed.query(user.id, 'delta', 0, 1)).toEqual([]);
  });

  it('isolates each account sequence and rejects duplicate user/feed identity', async () => {
    const first = await owner();
    const second = await owner();
    expect(await publish(first, 1n, 0n)).toBe(1);
    expect(await publish(second, 2n, 0n)).toBe(1);
    expect((await feed.query(first.id, 'delta', 0, 1)).map((row) => row.body))
      .toEqual([{ requestEndId: '1', requestReadId: '0' }]);
    await expect(database.db.insert(clientStateFeed).values({
      userId: first.id, feedId: 1, body: { requestEndId: '1', requestReadId: '0' },
    })).rejects.toMatchObject({ cause: { code: '23505', constraint: 'ClientStateFeed_pkey' } });
    expect(await database.db.select().from(clientStateFeed).where(and(
      eq(clientStateFeed.userId, first.id), eq(clientStateFeed.feedId, 1),
    ))).toHaveLength(1);
  });
});
