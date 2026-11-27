import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { account, accountThreadState, message, messageThread, relationshipPair } from '../src/database/schema.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('thread feed exact head author', () => {
  const db = new DatabaseService();
  const feed = new ThreadFeedService(db);
  let userId: number;
  let threadId: number;
  let owner: string;
  let index = 0;
  beforeAll(async () => {
    await db.onModuleInit();
    Object.assign(feed, { previews: new ThreadPreviewService(db) });
  });
  afterAll(() => db.onApplicationShutdown());
  beforeEach(async () => {
    owner = `author-viewer-${++index}`;
    const [user] = await db.db.insert(account).values({ account: owner }).returning();
    userId = user.id;
    const [thread] = await db.db.insert(messageThread).values({ type: 'P2P' }).returning();
    threadId = thread.id;
    await db.db.insert(relationshipPair).values({
      kind: 'P2P', active: true, established: true, threadId,
      endpointAType: 'USER', endpointAAccount: owner, endpointANamespaceId: 0,
      endpointBType: 'USER', endpointBAccount: 'peer', endpointBNamespaceId: 0,
    });
    await db.db.insert(accountThreadState).values({ accountId: userId, threadId });
  });

  async function publish(seq: number, author = 'peer', namespaceId = 0) {
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx.insert(message).values(withMessageDigest({
        threadId, seq, creatorAccount: author, profileNamespaceId: namespaceId,
        contentType: author === '$system' ? 'SYSTEM' : 'PURE_TEXT',
        content: '{}',
      }));
      await tx.update(messageThread).set({ curSeq: seq }).where(eq(messageThread.id, threadId));
      await ThreadFeedHeadWriter.advanceInTx(tx, userId, { threadId, messageEndSeq: seq });
    });
  }
  async function snapshot(previewCount = 0) {
    return (await feed.queryThreadFeedDelta(userId, { after: 0, previewCount })).items[0];
  }

  it('omits author for zero and returns no thread to an unrelated account', async () => {
    expect(await snapshot()).toMatchObject({ messageEndSeq: 0 });
    expect(await snapshot()).not.toHaveProperty('author');
    const [stranger] = await db.db.insert(account).values({ account: `author-stranger-${index}` }).returning();
    expect((await feed.queryThreadFeedDelta(stranger.id, { after: 0 })).items).toEqual([]);
  });

  it('uses the self-authored head independently of retained peer previews and read position', async () => {
    await publish(1);
    await publish(2, owner);
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await ThreadFeedHeadWriter.advanceInTx(tx, userId, { threadId, messageEndSeq: 2, lastReadSeq: 2 });
    });
    const state = await snapshot(3);
    expect(state).toMatchObject({ messageEndSeq: 2, author: { account: owner, namespaceId: 0 } });
    expect(state.previews?.map((preview) => preview.seq)).toEqual([1]);
    expect(Object.keys(state.author!).sort()).toEqual(['account', 'namespaceId']);
  });

  it('preserves author namespace rather than substituting the thread namespace', async () => {
    await publish(1, 'foreign', 73);
    expect(await snapshot()).toMatchObject({
      publisherNamespaceId: 0,
      author: { account: 'foreign', namespaceId: 73 },
    });
  });

  it('returns the system author without profile requests or an older-author fallback', async () => {
    await publish(1);
    await publish(2, '$system');
    expect(await snapshot()).toMatchObject({ messageEndSeq: 2, author: { account: '$system', namespaceId: 0 } });
  });

  it('retains immutable head identity after deletion and clearing without returning content', async () => {
    await publish(1, 'head-author', 4);
    await db.db.update(message).set({ isDeleted: true }).where(eq(message.threadId, threadId));
    await db.db.update(messageThread).set({ clearedSeq: 1 }).where(eq(messageThread.id, threadId));
    const state = await snapshot();
    expect(state.author).toEqual({ account: 'head-author', namespaceId: 4 });
    expect(state).not.toHaveProperty('content');
    expect(state).not.toHaveProperty('previews');
  });

  it('uses the retained account head, not a newer message beyond the visibility ceiling', async () => {
    await publish(1, 'retained');
    await db.db.update(accountThreadState).set({ messageVisibleThroughSeq: 1 }).where(eq(accountThreadState.threadId, threadId));
    await db.db.update(relationshipPair).set({ active: false }).where(eq(relationshipPair.threadId, threadId));
    await db.db.insert(message).values(withMessageDigest({
      threadId, seq: 2, creatorAccount: 'not-visible', contentType: 'PURE_TEXT', content: '{}',
    }));
    await db.db.update(messageThread).set({ curSeq: 2 }).where(eq(messageThread.id, threadId));
    expect(await snapshot()).toMatchObject({
      conversationState: 'READ_ONLY', messageEndSeq: 1,
      author: { account: 'retained', namespaceId: 0 },
    });
  });

  it('fails a corrupt nonzero head rather than publishing a missing or older author', async () => {
    await publish(1);
    await db.db.update(accountThreadState).set({ messageEndSeq: 2 }).where(eq(accountThreadState.threadId, threadId));
    await expect(snapshot()).rejects.toThrow('author');
  });

  it('keeps page cursor, head, and author coherent across a concurrent committed advance', async () => {
    await publish(1, 'before');
    const before = await snapshot();
    const originalTransaction = db.db.transaction.bind(db.db);
    const transaction = vi.spyOn(db.db, 'transaction');
    transaction.mockImplementationOnce((run, options) => originalTransaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      let reads = 0;
      vi.spyOn(tx, 'execute').mockImplementation(async (query) => {
        const result = await execute(query);
        if (++reads === 1) await publish(2, 'after');
        return result;
      });
      return run(tx);
    }, options));
    try {
      const page = await feed.queryThreadFeedDelta(userId, { after: 0 });
      expect(page.threadFeedEndId).toBe(before.threadFeedId);
      expect(page.items[0]).toMatchObject({
        threadFeedId: before.threadFeedId, messageEndSeq: 1,
        author: { account: 'before', namespaceId: 0 },
      });
    } finally {
      transaction.mockRestore();
    }
    expect(await snapshot()).toMatchObject({ messageEndSeq: 2, author: { account: 'after', namespaceId: 0 } });
  });
});
