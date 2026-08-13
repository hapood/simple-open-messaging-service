import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  federatedPeer,
  federationMessageDelivery,
  federationServeCursor,
  federationTombstonePullCursor,
  federationTombstoneServeCursor,
  message,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationMemoryFeedService } from '../src/federation/federation-memory-feed.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import { FederationMessageTombstoneFeedService } from '../src/federation/federation-message-tombstone-feed.service.js';
import { FederationMessageTombstonePullService } from '../src/federation/federation-message-tombstone-pull.service.js';

describe('FederationMessageTombstoneFeedService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let cursor: FederationCursorService;
  let memory: FederationMemoryFeedService;
  let messages: FederationMessageFeedService;
  let tombstones: FederationMessageTombstoneFeedService;
  let pull: FederationMessageTombstonePullService;
  const peerDomain = 'tombstone-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    cursor = new FederationCursorService(database);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    memory = new FederationMemoryFeedService(database);
    messages = new FederationMessageFeedService(cursor, memory);
    tombstones = new FederationMessageTombstoneFeedService(database, memory);
    pull = new FederationMessageTombstonePullService(database);
  });

  afterAll(async () => mod.close());

  async function seedP2p(authorIsForeigner = false) {
    const now = new Date('2026-08-12T01:02:03.000Z');
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
    const [author, remote] = await database.db
      .insert(user)
      .values([
        {
          account: 'alice',
          name: 'Alice',
          isForeigner: authorIsForeigner,
          domain: authorIsForeigner ? 'author.test' : 'local',
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
      { userId: author.id, threadId: thread.id, joinedAt: now, updatedAt: now },
      { userId: remote.id, threadId: thread.id, joinedAt: now, updatedAt: now },
    ]);
    await database.db
      .insert(threadAudience)
      .values({
        targetDomain: peerDomain,
        threadId: thread.id,
        messageScannedThroughSeq: -1,
      });
    const [target] = await database.db
      .insert(message)
      .values({
        seq: 0,
        originSeq: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'delete me' }),
        threadId: thread.id,
        creator: author.id,
        isDeleted: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await database.db
      .update(messageThread)
      .set({ curSeq: 0 })
      .where(eq(messageThread.id, thread.id));
    await database.db.insert(federationMessageDelivery).values({
      peerDomain,
      messageId: target.id,
    });
    const [deletion] = await database.db
      .insert(deletedMessage)
      .values({
        threadId: thread.id,
        seq: 0,
        type: MessageDeleteType.WITHDRAW,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await cursor.initializePeer(peerDomain, 0n);
    await database.db.insert(federationTombstoneServeCursor).values({
      peerDomain,
    });
    await database.db.insert(federationTombstonePullCursor).values({
      peerDomain,
      initialized: true,
    });
    return { author, deletion, target, thread };
  }

  it('allocates and serves a durable local-author tombstone', async () => {
    const { deletion } = await seedP2p();

    const page = await tombstones.serve(peerDomain, 0n);

    expect(page).toEqual({
      tombstones: [
        {
          feedId: '1',
          thread: {
            type: 'P2P',
            participants: expect.arrayContaining([
              { account: 'alice', domain: process.env.SOMS_DOMAIN },
              { account: 'bob', domain: peerDomain },
            ]),
          },
          target: {
            creator: { account: 'alice', domain: process.env.SOMS_DOMAIN },
            originSeq: 0,
          },
          type: MessageDeleteType.WITHDRAW,
          deletedAt: Date.parse('2026-08-12T01:02:03.000Z'),
        },
      ],
      scannedThrough: '1',
      hasMore: false,
    });

    await tombstones.serve(peerDomain, 1n);
    const [sourceCursor] = await database.db
      .select()
      .from(federationTombstoneServeCursor);
    expect(sourceCursor.sourceScannedThrough).toBe(deletion.id);
  });

  it('keeps exact delivery entitlement after the audience closes', async () => {
    await seedP2p();
    await database.db
      .update(threadAudience)
      .set({ deliverThroughChangeId: 0n });

    const page = await tombstones.serve(peerDomain, 0n);

    expect(page.tombstones).toHaveLength(1);
  });

  it('does not expose a tombstone for a message the peer never received', async () => {
    const { target } = await seedP2p();
    await database.db
      .delete(federationMessageDelivery)
      .where(eq(federationMessageDelivery.messageId, target.id));
    await database.db
      .update(threadAudience)
      .set({ messageScannedThroughSeq: 0 })
      .where(eq(threadAudience.targetDomain, peerDomain));

    const page = await tombstones.serve(peerDomain, 0n);

    expect(page.tombstones).toEqual([]);
    expect(page.scannedThrough).toBe('0');
  });

  it('does not federate a local moderation deletion of a foreign P2P message', async () => {
    await seedP2p(true);

    const page = await tombstones.serve(peerDomain, 0n);

    expect(page).toEqual({
      tombstones: [],
      scannedThrough: '0',
      hasMore: false,
    });
  });

  it('keeps message and tombstone allocation in independent peer feed spaces', async () => {
    const { author, thread } = await seedP2p();
    await database.db.insert(message).values({
      seq: 1,
      originSeq: 1,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'still live' }),
      threadId: thread.id,
      creator: author.id,
      updatedAt: new Date(),
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, thread.id));

    await Promise.all([memory.fill(peerDomain), tombstones.fill(peerDomain)]);
    const [messagePage, tombstonePage] = await Promise.all([
      messages.serve(peerDomain, 0n),
      tombstones.serve(peerDomain, 0n),
    ]);
    const [messageCursor] = await database.db
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain));

    expect(messagePage.messages).toHaveLength(1);
    expect(tombstonePage.tombstones).toHaveLength(1);
    const [tombstoneCursor] = await database.db
      .select({
        allocatedThrough: federationTombstoneServeCursor.allocatedThrough,
      })
      .from(federationTombstoneServeCursor)
      .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain));
    // The deleted message itself is a message-feed hole. Tombstones allocate in
    // their own space, so the same numeric ID may validly occur in both feeds.
    expect(messageCursor.allocatedThrough).toBe(2n);
    expect(tombstoneCursor.allocatedThrough).toBe(1n);
    expect(messagePage.messages[0].feedId).toBe('2');
    expect(tombstonePage.tombstones[0].feedId).toBe('1');
  });

  it('replays an unacknowledged tombstone with the same feed ID after restart', async () => {
    await seedP2p();
    const first = await tombstones.serve(peerDomain, 0n);
    expect(first.tombstones[0]?.feedId).toBe('1');

    const restarted = new FederationMessageTombstoneFeedService(
      database,
      new FederationMemoryFeedService(database),
    );
    const replay = await restarted.serve(peerDomain, 0n);
    expect(replay.tombstones[0]?.feedId).toBe('1');
  });

  it('does not return a tombstone beyond the requested truncation boundary', async () => {
    await seedP2p();
    await tombstones.fill(peerDomain);

    const page = await tombstones.serve(peerDomain, 0n, undefined, 0n);

    expect(page.tombstones).toEqual([]);
    expect(page.scannedThrough).toBe('0');
    expect(page.hasMore).toBe(false);
  });

  it('commits a pulled page before advancing its independent cursor', async () => {
    await seedP2p();
    let applied = false;
    const boundaries: Array<bigint | undefined> = [];
    pull.advertise(peerDomain, 2n);

    await pull.run(peerDomain, {
      fetch: async (after, trunc) => {
        boundaries.push(trunc);
        return after === 0n
          ? {
              tombstones: [
                {
                  feedId: '2',
                  thread: { type: 'P2P', participants: [] },
                  target: {
                    creator: { account: 'alice', domain: 'author.test' },
                    originSeq: 0,
                  },
                  type: MessageDeleteType.WITHDRAW,
                  deletedAt: 1,
                },
              ],
              scannedThrough: '2',
              hasMore: false,
            }
          : { tombstones: [], scannedThrough: '2', hasMore: false };
      },
      apply: async () => {
        applied = true;
      },
    });

    const stored =
      await database.db.query.federationTombstonePullCursor.findFirst({
        where: eq(federationTombstonePullCursor.peerDomain, peerDomain),
      });
    expect(applied).toBe(true);
    expect(stored?.committedThrough).toBe(2n);
    expect(boundaries).toEqual([2n, 2n]);
  });

  it('rolls back the pull cursor for unordered tombstones', async () => {
    await seedP2p();

    await expect(
      pull.run(peerDomain, {
        fetch: async () => ({
          tombstones: [
            {
              feedId: '2',
              thread: { type: 'P2P', participants: [] },
              target: {
                creator: { account: 'alice', domain: 'author.test' },
                originSeq: 0,
              },
              type: MessageDeleteType.WITHDRAW,
              deletedAt: 1,
            },
            {
              feedId: '1',
              thread: { type: 'P2P', participants: [] },
              target: {
                creator: { account: 'alice', domain: 'author.test' },
                originSeq: 1,
              },
              type: MessageDeleteType.WITHDRAW,
              deletedAt: 2,
            },
          ],
          scannedThrough: '2',
          hasMore: false,
        }),
        apply: async () => undefined,
      }),
    ).rejects.toThrow('unordered tombstones');

    const stored =
      await database.db.query.federationTombstonePullCursor.findFirst({
        where: eq(federationTombstonePullCursor.peerDomain, peerDomain),
      });
    expect(stored?.committedThrough).toBe(0n);
  });
});
