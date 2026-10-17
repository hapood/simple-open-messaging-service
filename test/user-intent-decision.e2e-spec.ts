import {
  relationshipPairBusinessKey,
  type PairAddressScope,
} from '../src/common/locks/relationship-pair-business-lock.js';
import { businessAccountScopeKey } from '../src/common/locks/account-business-lock.js';
import type { ProfiledAddress } from '../shared/profiled-address.js';
import {
  findP2PRelationship,
  seedAcceptedRelationship,
  seedFederatedPeerNamespace,
  seedUser,
} from './seed.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { withBusinessLockCapture } from './business-lock-capture.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationStateFeedPushService } from '../src/federation/federation-state-feed-push.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import {
  UserIntentService,
  type UserIntentDependencies,
} from '../src/user/p2p-intent/authored/user-intent.service.js';

import { ReceivedUserIntentService } from '../src/user/p2p-intent/received/received-user-intent.service.js';
import * as userIntentState from '../src/user/p2p-intent/shared/user-intent-state-sql.js';

interface UserRef {
  id: number;
  account: string;
}

function body(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

/** Message.content is jsonb text on the driver boundary. */
function contentOf(message: { content: unknown }): Record<string, any> {
  return JSON.parse(message.content as string);
}

function pairScope(
  pair: typeof tables.relationshipPair.$inferSelect,
): PairAddressScope {
  return {
    // `kind` is a plain varchar column; the check constraint pins the union.
    kind: pair.kind as PairAddressScope['kind'],
    addresses: [
      {
        account: pair.endpointAAccount.toLowerCase(),
        profileNamespaceId: pair.endpointANamespaceId,
      },
      {
        account: pair.endpointBAccount.toLowerCase(),
        profileNamespaceId: pair.endpointBNamespaceId,
      },
    ],
  };
}

describe('user intent decision', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let deps: UserIntentDependencies;
  let service: UserIntentService;
  const businessLocks: string[] = [];
  let sequence = 0;

  /** Dispatches one command to the service service; the suite compares
   * committed state after each command. */
  async function runIntent(params: {
    userId: number;
    targetUserId: number | null;
    target: { account: string; namespaceId: number };
    decision: 'ACCEPTED' | 'REVOKED' | 'REQUESTED';
    note?: string;
  }): Promise<void> {
    await service.execute({
      userId: params.userId,
      decision: params.decision,
      target: params.target,
      ...(params.note === undefined ? {} : { note: params.note }),
    });
  }

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Do not start schedulers: compare committed outbox state before background fanout consumes it.
    app = fixture.createNestApplication(new FastifyAdapter());
    database = app.get(DatabaseService);
    deps = {
      database: withBusinessLockCapture(database, businessLocks),
      clientFeed: app.get(ClientStateFeedService),
      peerFeed: app.get(PeerStateFeedService),
      federation: app.get(FederationStateFeedPushService),
      namespaces: app.get(FederationNamespaceService),
    };
    service = new UserIntentService(deps);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
  });

  async function twoUsers(prefixName: string) {
    const prefix = `${prefixName}-${++sequence}`;
    const alice = await seedUser(app, `${prefix}-alice`);
    const bob = await seedUser(app, `${prefix}-bob`);
    return { alice, bob };
  }

  async function setProfileRevision(user: UserRef, profileRev: number) {
    await database.db.insert(tables.profileTable).values({
      account: user.account,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev,
      displayName: user.account,
    });
    await database.db
      .update(tables.account)
      .set({ defaultProfileRev: profileRev })
      .where(eq(tables.account.id, user.id));
  }

  async function cursor(userId: number, threadId: number) {
    return database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.accountId, userId),
        eq(tables.accountThreadState.threadId, threadId),
      ),
    });
  }

  it('initializes local viewers from the request and acceptance declarations', async () => {
    const { alice, bob } = await twoUsers('profile-initialization');
    await setProfileRevision(alice, 7);
    await setProfileRevision(bob, 3);
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: bob.account, namespaceId: 0 },
    });
    const { pair } = await findP2PRelationship(database.db, alice.id, bob.id);
    const threadId = pair!.threadId!;
    expect(await cursor(alice.id, threadId)).toMatchObject({
      threadProfileRev: 0,
    });
    expect(await cursor(bob.id, threadId)).toMatchObject({
      threadProfileRev: 7,
    });
    await service.execute({
      userId: bob.id,
      decision: 'ACCEPTED',
      target: { account: alice.account, namespaceId: 0 },
    });
    expect(await cursor(alice.id, threadId)).toMatchObject({
      threadProfileRev: 3,
    });
    expect(await cursor(bob.id, threadId)).toMatchObject({
      threadProfileRev: 7,
    });
  });

  it('initializes a received request from its declaration and captures the final thread feed', async () => {
    const { alice } = await twoUsers('received-profile');
    const domain = `received-profile-${++sequence}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const peer = { account: 'remote-profile', domain, namespaceId };
    const receiver = new ReceivedUserIntentService({
      ...deps,
      userIntents: service,
    });
    const clientUpdates: import('../src/client-state-feed/client-state-feed.service.js').PendingClientStateFeedUpdate[] =
      [];
    const now = Date.now();
    const command = {
      localUserId: alice.id,
      peer,
      body: {
        status: 'REQUESTED' as const,
        profileNamespaceId: 0,
        profileRev: 7,
        note: '',
        requestedAt: now,
        expiresAt: now + 60_000,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      },
    };
    await database.db.transaction((tx) =>
      receiver.applyInTx(tx, command, clientUpdates, new Set()),
    );
    const pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(tables.relationshipPair.endpointAAccount, alice.account),
        eq(tables.relationshipPair.endpointBAccount, peer.account),
        eq(tables.relationshipPair.endpointBNamespaceId, namespaceId),
      ),
    });
    const threadId = pair!.threadId!;
    const state = await cursor(alice.id, threadId);
    expect(state).toMatchObject({ threadProfileRev: 7 });
    expect(clientUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: alice.id,
          threadFeedEndId: state!.threadFeedId,
        }),
      ]),
    );

    await service.execute({
      userId: alice.id,
      decision: 'ACCEPTED',
      target: { account: peer.account, namespaceId },
    });
    expect(await cursor(alice.id, threadId)).toMatchObject({
      threadProfileRev: 7,
    });
  });

  it('reads the newly persisted peer declaration when a received acceptance activates a requested thread', async () => {
    const { alice } = await twoUsers('received-accept-profile');
    const domain = `received-accept-profile-${++sequence}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const peer = { account: 'remote-accept-profile', domain, namespaceId };
    const receiver = new ReceivedUserIntentService({
      ...deps,
      userIntents: service,
    });
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: peer.account, namespaceId },
    });
    const now = Date.now();
    await receiver.execute({
      localUserId: alice.id,
      peer,
      body: {
        status: 'ACCEPTED',
        profileNamespaceId: 0,
        profileRev: 3,
        note: '',
        requestedAt: now,
        expiresAt: null,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      },
    });
    const pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(tables.relationshipPair.endpointAAccount, alice.account),
        eq(tables.relationshipPair.endpointBAccount, peer.account),
        eq(tables.relationshipPair.endpointBNamespaceId, namespaceId),
      ),
    });
    expect(pair).toMatchObject({ active: true });
    expect(await cursor(alice.id, pair!.threadId!)).toMatchObject({
      threadProfileRev: 3,
    });
  });

  /** Seed a pending request with the production entry (uncounted setup). */
  async function seedPending(
    fromUserId: number,
    toUserId: number,
    note = 'please',
  ) {
    const target = await database.db.query.account.findFirst({
      where: eq(tables.account.id, toUserId),
      columns: { account: true },
    });
    if (!target) throw new Error('seedPending target is missing');
    await service.execute({
      userId: fromUserId,
      decision: 'REQUESTED',
      target: { account: target.account, namespaceId: 0 },
      note,
    });
  }

  /** Seed an active friendship on a retained thread (uncounted setup). */
  async function seedFriends(aliceId: number, bobId: number) {
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'P2P',
        authorityNamespaceId: 0,
        updatedAt: new Date(),
      })
      .returning({ id: tables.messageThread.id });
    await seedAcceptedRelationship(database.db, aliceId, bobId, thread.id);
    // The seeder leaves the sticky flag unset; an ended friendship reads true.
    await database.db
      .update(tables.relationshipPair)
      .set({ established: true })
      .where(
        and(
          eq(tables.relationshipPair.kind, 'P2P'),
          eq(tables.relationshipPair.threadId, thread.id),
        ),
      );
    return thread.id;
  }

  /** Everything the commands touch, scoped to this fixture's thread and users. */
  async function state(
    alice: UserRef,
    bob: UserRef & { domain?: string; namespaceId?: number },
  ) {
    const bobTarget =
      bob.id > 0
        ? bob.id
        : {
            account: bob.account,
            namespaceId: bob.namespaceId ?? 0,
          };
    const { pair, firstEndpoint, secondEndpoint } = await findP2PRelationship(
      database.db,
      alice.id,
      bobTarget,
    );
    const intents = pair
      ? await database.db.query.relationshipIntent
          .findMany({
            where: or(
              and(
                eq(
                  tables.relationshipIntent.authorAccount,
                  firstEndpoint.account,
                ),
                eq(
                  tables.relationshipIntent.authorNamespaceId,
                  firstEndpoint.namespaceId,
                ),
                eq(
                  tables.relationshipIntent.receiverAccount,
                  secondEndpoint.account,
                ),
                eq(
                  tables.relationshipIntent.receiverNamespaceId,
                  secondEndpoint.namespaceId,
                ),
              ),
              and(
                eq(
                  tables.relationshipIntent.authorAccount,
                  secondEndpoint.account,
                ),
                eq(
                  tables.relationshipIntent.authorNamespaceId,
                  secondEndpoint.namespaceId,
                ),
                eq(
                  tables.relationshipIntent.receiverAccount,
                  firstEndpoint.account,
                ),
                eq(
                  tables.relationshipIntent.receiverNamespaceId,
                  firstEndpoint.namespaceId,
                ),
              ),
            ),
          })
          .then((rows) =>
            rows.sort((left, right) =>
              left.authorAccount.localeCompare(right.authorAccount),
            ),
          )
      : [];
    const thread = pair?.threadId
      ? await database.db.query.messageThread.findFirst({
          where: eq(tables.messageThread.id, pair.threadId),
        })
      : undefined;
    const threadId = thread?.id ?? 0;
    const messages = thread
      ? await database.db.query.message.findMany({
          where: eq(tables.message.threadId, thread.id),
          orderBy: tables.message.seq,
        })
      : [];
    const states = thread
      ? await database.db.query.accountThreadState.findMany({
          where: eq(tables.accountThreadState.threadId, thread.id),
          orderBy: tables.accountThreadState.accountId,
        })
      : [];
    const audiences = thread
      ? await database.db.query.threadAudience.findMany({
          where: eq(tables.threadAudience.threadId, thread.id),
          orderBy: tables.threadAudience.id,
        })
      : [];
    const userIds = [alice.id, bob.id].filter((id) => id > 0);
    const feeds = await database.db.query.clientStateFeed.findMany({
      where: and(
        eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        inArray(tables.clientStateFeed.userId, userIds),
      ),
      orderBy: tables.clientStateFeed.id,
    });
    const tasks = await database.db.query.durableTask.findMany({
      where: inArray(tables.durableTask.status, ['PENDING', 'SUPERSEDED']),
      orderBy: tables.durableTask.id,
    });
    const threadTasks = tasks.filter(
      (task) => task.payload['threadId'] === threadId && threadId !== 0,
    );
    return {
      pair,
      firstEndpoint,
      secondEndpoint,
      intents,
      thread,
      messages,
      states,
      audiences,
      feeds,
      threadTasks,
    };
  }

  function eventParticipants(after: Awaited<ReturnType<typeof state>>) {
    const pair = after.pair!;
    return (
      [
        {
          account: pair.endpointAAccount,
          namespaceId: pair.endpointANamespaceId,
        },
        {
          account: pair.endpointBAccount,
          namespaceId: pair.endpointBNamespaceId,
        },
      ] as const
    ).map(
      (endpoint) =>
        ({
          account: endpoint.account,
          publisherNamespaceId: endpoint.namespaceId,
          profileNamespaceId: endpoint.namespaceId,
          profileRev:
            after.intents.find(
              (intent) =>
                intent.authorAccount === endpoint.account &&
                intent.authorNamespaceId === endpoint.namespaceId,
            )?.profileRev ?? 0,
        }) satisfies ProfiledAddress,
    );
  }

  it('requests a fresh local friendship with shell-only effects', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-local');
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REQUESTED',
      note: 'let us chat',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: false });
    expect(after.pair!.threadId).not.toBeNull();
    expect(after.thread).toMatchObject({ type: 'P2P' });
    // The authoring side holds REQUESTED with the seven-day TTL.
    const authored = after.intents.find(
      (intent) =>
        intent.authorAccount === after.firstEndpoint.account &&
        intent.authorNamespaceId === after.firstEndpoint.namespaceId,
    );
    expect(authored).toMatchObject({
      status: 'REQUESTED',
      note: 'let us chat',
    });
    expect(
      authored!.expiresAt!.getTime() - authored!.requestedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);
    expect(after.messages).toHaveLength(0);
    // Participant shells exist; nothing is read-advanced yet.
    expect(after.states).toHaveLength(2);
    expect(after.states.every((s) => s.messageVisibleThroughSeq === null)).toBe(
      true,
    );
    // Both local endpoints learn the pending direction; no peer event, no tasks.
    expect(after.feeds).toHaveLength(2);
    expect(body(after.feeds[0].body).direction).toBe('OUTGOING');
    expect(body(after.feeds[1].body).direction).toBe('INCOMING');
    expect(body(after.feeds[0].body).peer).toMatchObject({
      account: bob.account,
    });
    expect(body(after.feeds[1].body).peer).toMatchObject({
      account: alice.account,
    });
    expect(after.audiences).toHaveLength(0);
    expect(after.threadTasks).toHaveLength(0);
  });

  it('accepts an application with the full activation effects', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('ack-local');
    await seedPending(alice.id, bob.id, 'please');
    await runIntent({
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, namespaceId: 0 },
      decision: 'ACCEPTED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: true, established: true });
    // Both directions are ACCEPTED and can no longer expire under the pair.
    expect(after.intents.map((intent) => intent.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
    for (const intent of after.intents) expect(intent.expiresAt).toBeNull();
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]).toMatchObject({
      contentType: 'SYSTEM',
      creatorAccount: '$system',
    });
    expect(contentOf(after.messages[0])).toEqual({
      type: 'FRIEND_ADDED',
      participants: eventParticipants(after),
    });
    expect(after.audiences).toHaveLength(2);
    // Activation starts read at the boundary with no preview and no unread.
    for (const participant of after.states) {
      expect(participant.unreadCount).toBe(0);
      expect(participant.previewSeqs).toEqual([]);
    }
    // Both directions reach both endpoints.
    expect(after.feeds).toHaveLength(4);
    expect(
      after.feeds.filter((feed) => body(feed.body).direction === 'OUTGOING'),
    ).toHaveLength(2);
    expect(after.threadTasks.map((task) => task.taskType).sort()).toEqual([
      'FAN_OUT_FEDERATION_THREAD_CONTENT',
      'FAN_OUT_THREAD_CONTENT',
    ]);
  });

  it('collapses a crossed request into the acceptance path', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-cross');
    await seedPending(bob.id, alice.id, 'from bob');
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REQUESTED',
      note: 'from alice',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: true, established: true });
    expect(after.intents.map((intent) => intent.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
    // The collapsed requester's note survives the acceptance write.
    expect(
      after.intents.find((intent) => intent.note === 'from alice'),
    ).toBeTruthy();
    expect(after.messages).toHaveLength(1);
    expect(contentOf(after.messages[0])).toEqual({
      type: 'FRIEND_ADDED',
      participants: eventParticipants(after),
    });
  });

  it('resets both crossed-request boundaries before activation and leaves them intact on a repeated request', async () => {
    const { alice, bob } = await twoUsers('crossed-boundary');
    await seedPending(bob.id, alice.id);
    const { pair } = await findP2PRelationship(database.db, alice.id, bob.id);
    const threadId = pair!.threadId!;
    // Model a retained history boundary before friendship is reactivated.
    await database.db
      .update(tables.messageThread)
      .set({ curSeq: 8 })
      .where(eq(tables.messageThread.id, threadId));
    await database.db
      .update(tables.accountThreadState)
      .set({
        lastReadSeq: 2,
        unreadCount: 4,
        previewSeqs: [3, 4],
        lastMentionSeq: 4,
      })
      .where(eq(tables.accountThreadState.threadId, threadId));
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: bob.account, namespaceId: 0 },
    });
    for (const user of [alice, bob]) {
      expect(await cursor(user.id, threadId)).toMatchObject({
        lastReadSeq: 8,
        unreadCount: 0,
        previewSeqs: [],
        lastMentionSeq: null,
      });
    }
    const notice = await database.db.query.message.findFirst({
      where: eq(tables.message.threadId, threadId),
    });
    expect(notice).toMatchObject({ seq: 9 });
    expect(contentOf(notice!)).toMatchObject({ type: 'FRIEND_ADDED' });
    await database.db
      .update(tables.messageThread)
      .set({ curSeq: 10 })
      .where(eq(tables.messageThread.id, threadId));
    await database.db
      .update(tables.accountThreadState)
      .set({
        unreadCount: 2,
        previewSeqs: [10],
        lastMentionSeq: 10,
      })
      .where(eq(tables.accountThreadState.threadId, threadId));
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: bob.account, namespaceId: 0 },
    });
    for (const user of [alice, bob]) {
      expect(await cursor(user.id, threadId)).toMatchObject({
        lastReadSeq: 8,
        unreadCount: 2,
        previewSeqs: [10],
        lastMentionSeq: 10,
      });
    }
  });

  it.each([false, true])(
    'uses one expiry decision across crossed-request preparation (already expired: %s)',
    async (alreadyExpired) => {
      const { alice, bob } = await twoUsers('crossed-expiry');
      await seedPending(bob.id, alice.id);
      const { pair } = await findP2PRelationship(database.db, alice.id, bob.id);
      const threadId = pair!.threadId!;
      const expiresAt = Date.now() + 60_000;
      await database.db
        .update(tables.relationshipIntent)
        .set({ expiresAt: new Date(expiresAt) })
        .where(
          and(
            eq(tables.relationshipIntent.authorAccount, bob.account),
            eq(tables.relationshipIntent.receiverAccount, alice.account),
            eq(tables.relationshipIntent.authorNamespaceId, 0),
            eq(tables.relationshipIntent.receiverNamespaceId, 0),
          ),
        );
      await database.db
        .update(tables.messageThread)
        .set({ curSeq: 8 })
        .where(eq(tables.messageThread.id, threadId));
      await database.db
        .update(tables.accountThreadState)
        .set({
          lastReadSeq: 2,
          unreadCount: 4,
          previewSeqs: [3, 4],
          lastMentionSeq: 4,
        })
        .where(eq(tables.accountThreadState.threadId, threadId));
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(expiresAt + (alreadyExpired ? 1 : -1));
      const lock = userIntentState.lockUserIntentThreadStateInTx;
      const reset = vi
        .spyOn(userIntentState, 'lockUserIntentThreadStateInTx')
        .mockImplementation(async (...args) => {
          await lock(...args);
          // Simulate crossing the expiry boundary while waiting for DB work.
          clock.mockReturnValue(expiresAt + 1);
        });
      try {
        await service.execute({
          userId: alice.id,
          decision: 'REQUESTED',
          target: { account: bob.account, namespaceId: 0 },
        });
        expect(reset).toHaveBeenCalledOnce();
        for (const user of [alice, bob]) {
          expect(await cursor(user.id, threadId)).toMatchObject(
            alreadyExpired
              ? {
                  lastReadSeq: 2,
                  unreadCount: 4,
                  previewSeqs: [3, 4],
                  lastMentionSeq: 4,
                }
              : {
                  lastReadSeq: 8,
                  unreadCount: 0,
                  previewSeqs: [],
                  lastMentionSeq: null,
                },
          );
        }
        const currentPair = await database.db.query.relationshipPair.findFirst({
          where: eq(tables.relationshipPair.id, pair!.id),
        });
        expect(currentPair!.active).toBe(!alreadyExpired);
        const notices = await database.db.query.message.findMany({
          where: eq(tables.message.threadId, threadId),
        });
        expect(notices).toHaveLength(alreadyExpired ? 0 : 1);
        if (!alreadyExpired)
          expect(contentOf(notices[0])).toMatchObject({ type: 'FRIEND_ADDED' });
      } finally {
        reset.mockRestore();
        clock.mockRestore();
      }
    },
  );

  it('rolls back the entire friendship operation if participant state fails after intent persistence', async () => {
    const { alice, bob } = await twoUsers('atomic-acceptance');
    await seedPending(alice.id, bob.id);
    const before = await state(alice, bob);
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
    const push = vi
      .spyOn(deps.federation, 'pushStateFeedNamespaces')
      .mockResolvedValue(undefined);
    const reset = vi
      .spyOn(userIntentState, 'resetUserIntentThreadStateInTx')
      .mockImplementation(async (tx) => {
        const pair = await tx.query.relationshipPair.findFirst({
          where: eq(tables.relationshipPair.id, before.pair!.id),
        });
        expect(pair).toMatchObject({ active: true });
        // Fail inside the same transaction, after the intent/state-machine SQL.
        await tx.execute(sql`SELECT 1 / 0`);
      });
    await expect(
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, namespaceId: 0 },
      }),
    ).rejects.toThrow();
    expect(reset).toHaveBeenCalledOnce();
    const after = await state(alice, bob);
    expect(after.pair).toEqual(before.pair);
    expect(after.intents).toEqual(before.intents);
    expect(after.states).toEqual(before.states);
    expect(after.messages).toEqual(before.messages);
    expect(after.feeds).toEqual(before.feeds);
    expect(after.audiences).toEqual(before.audiences);
    expect(after.threadTasks).toEqual(before.threadTasks);
    expect(notify).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('no-ops an already-active acceptance and rejects a stale one', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('ack-noop');
    await seedFriends(alice.id, bob.id);
    const before = await state(alice, bob);
    // The satisfied acceptance is a write-free no-op whose outcome still
    // carries the active thread id for the HTTP surface.
    await expect(
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, namespaceId: 0 },
      }),
    ).resolves.toEqual({
      status: 'NO_OP',
      reason: 'ALREADY_ACTIVE',
      threadId: before.pair!.threadId,
    });
    const after = await state(alice, bob);
    expect(after.pair).toEqual(before.pair);
    expect(after.feeds).toHaveLength(before.feeds.length);
    // A stale accept (no live reverse request) reports NOT_FOUND.
    const carol = await seedUser(app, `ack-stale-${++sequence}-carol`);
    await expect(
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: carol.account, namespaceId: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.NOT_FOUND,
    });
  });

  it('revokes a pending request without any departure effect', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-pending');
    await seedPending(alice.id, bob.id);
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REVOKED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: false });
    const authored = after.intents.find(
      (intent) =>
        intent.authorAccount === after.firstEndpoint.account &&
        intent.authorNamespaceId === after.firstEndpoint.namespaceId,
    );
    expect(authored).toMatchObject({ status: 'REVOKED' });
    expect(after.messages).toHaveLength(0);
    expect(after.threadTasks).toHaveLength(0);
    const ended = after.feeds.filter(
      (feed) => body(feed.body).status === 'REVOKED',
    );
    expect(ended).toHaveLength(2);
    for (const feed of ended)
      expect(body(feed.body)).toMatchObject({
        requestStatus: 'WITHDRAWN',
        requestDirection: feed.userId === alice.id ? 'OUTGOING' : 'INCOMING',
      });
  });

  it('rejects an incoming request through the same revocation', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-reject');
    await seedPending(alice.id, bob.id, 'hello?');
    await runIntent({
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, namespaceId: 0 },
      decision: 'REVOKED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false });
    // The recipient authored their own REVOKED; the applicant stays REQUESTED
    // so a later re-application works through the existing gate.
    expect(after.intents.map((intent) => intent.status)).toContain('REQUESTED');
    expect(after.intents.map((intent) => intent.status)).toContain('REVOKED');
    expect(after.messages).toHaveLength(0);
    const ended = after.feeds.filter(
      (feed) => body(feed.body).status === 'REVOKED',
    );
    expect(ended).toHaveLength(2);
    for (const feed of ended)
      expect(body(feed.body)).toMatchObject({
        requestStatus: 'REJECTED',
        requestDirection: feed.userId === alice.id ? 'OUTGOING' : 'INCOMING',
      });
  });

  it('ends a friendship with the full departure effect set', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-friend');
    const threadId = await seedFriends(alice.id, bob.id);
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REVOKED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: true });
    expect(after.thread).toMatchObject({ federationRoundsEnabled: false });
    expect(after.thread!.authorizationEpoch).toBeGreaterThan(0);
    expect(after.messages).toHaveLength(1);
    expect(contentOf(after.messages[0])).toEqual({
      type: 'FRIEND_REMOVED',
      initiator: eventParticipants(after).find(
        (participant) => participant.account === alice.account,
      ),
      participants: eventParticipants(after),
    });
    const departureSeq = after.messages[0].seq;
    for (const participant of after.states)
      expect(participant.messageVisibleThroughSeq).toBe(departureSeq);
    expect(after.audiences).toHaveLength(0);
    const threadTask = after.threadTasks.find(
      (task) => task.taskType === 'FAN_OUT_THREAD_CONTENT',
    );
    expect(threadTask).toMatchObject({
      status: 'PENDING',
      scopeType: 'THREAD',
    });
    expect(threadTask!.payload).toMatchObject({
      threadId,
      messageEndSeq: departureSeq,
    });
    const departures = after.threadTasks.filter(
      (task) => task.taskType === 'FAN_OUT_ACCOUNT_THREAD_CONTENT',
    );
    expect(departures).toHaveLength(2);
    expect(
      departures
        .map((task) => task.payload['accountId'] as number)
        .sort((a, b) => a - b),
    ).toEqual([alice.id, bob.id].sort((left, right) => left - right));
    // The local peer authors its conclusion in the same transaction.
    expect(after.intents.every((intent) => intent.status === 'REVOKED')).toBe(
      true,
    );
    // Both endpoints learn the closure with the sticky established flag.
    const revokedFeeds = after.feeds.filter(
      (feed) => body(feed.body).status === 'REVOKED',
    );
    expect(revokedFeeds.length).toBeGreaterThanOrEqual(2);
    for (const feed of revokedFeeds.slice(0, 2))
      expect(body(feed.body).established).toBe(true);
  });

  it('re-friends after a withdrawal only through a fresh live direction', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-refriend');
    await seedFriends(alice.id, bob.id);
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REVOKED',
    });
    const ended = await state(alice, bob);
    expect(ended.pair).toMatchObject({ active: false, established: true });
    // The local peer authors its own REVOKED conclusion in the same
    // transaction, so a withdrawal never leaves a stale confirmation behind.
    expect(ended.intents.map((intent) => intent.status)).toEqual([
      'REVOKED',
      'REVOKED',
    ]);
    // A bare re-request cannot cross a revoked confirmation: it queues a live
    // request that the peer must accept again.
    await runIntent({
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REQUESTED',
    });
    const requested = await state(alice, bob);
    expect(requested.pair).toMatchObject({ active: false });
    await runIntent({
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, namespaceId: 0 },
      decision: 'ACCEPTED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: true, established: true });
    expect(after.intents.map((intent) => intent.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
  });

  it('requests a remote peer through the peer feed', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const prefix = `req-remote-${++sequence}`;
    const alice = await seedUser(app, `${prefix}-alice`);
    const domain = `${prefix}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    await runIntent({
      userId: alice.id,
      targetUserId: null,
      target: { account: `${prefix}-peer`, namespaceId },
      decision: 'REQUESTED',
      note: 'cross-server hello',
    });
    const after = await state(alice, {
      id: -1,
      account: `${prefix}-peer`,
      domain,
      namespaceId,
    });
    expect(after.pair).toMatchObject({
      active: false,
      established: false,
      endpointAAccount: alice.account,
      endpointANamespaceId: 0,
      endpointBAccount: `${prefix}-peer`,
      endpointBNamespaceId: namespaceId,
    });
    expect(after.intents).toHaveLength(1);
    expect(after.intents[0]).toMatchObject({
      status: 'REQUESTED',
      note: 'cross-server hello',
    });
    // The remote target has no local account, so exactly one client feed row.
    expect(after.feeds).toHaveLength(1);
    const peerRows = await database.db.query.peerStateFeed.findMany({
      where: eq(tables.peerStateFeed.namespaceId, namespaceId),
    });
    const peerIntent = peerRows.find(
      (row) => row.eventType === 'RELATIONSHIP_INTENT',
    );
    expect(peerIntent).toBeTruthy();
    expect(peerIntent).toMatchObject({
      account: alice.account,
      subjectAccount: `${prefix}-peer`,
      subjectNamespaceId: namespaceId,
    });
    expect(body(peerIntent!.body)).toMatchObject({
      status: 'REQUESTED',
      note: 'cross-server hello',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
    });
    // A remote invite opens no local audience and admits no tasks.
    expect(after.audiences).toHaveLength(0);
    expect(after.threadTasks).toHaveLength(0);
  });

  it('acquires the actor scope then the pair scope once', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('locks');
    await seedPending(alice.id, bob.id);
    businessLocks.length = 0;
    await runIntent({
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, namespaceId: 0 },
      decision: 'ACCEPTED',
    });
    const { pair } = await findP2PRelationship(database.db, alice.id, bob.id);
    // Both local endpoints' account scopes commit feed/allocator state, so the
    // command owns both; they are acquired in one global order before the Pair,
    // which protects intent and relationship-derived projections.
    expect(businessLocks).toEqual([
      ...[
        businessAccountScopeKey({
          account: alice.account,
          profileNamespaceId: 0,
        }),
        businessAccountScopeKey({
          account: bob.account,
          profileNamespaceId: 0,
        }),
      ].sort(),
      relationshipPairBusinessKey(pairScope(pair!)),
    ]);
  });

  it('rolls back relationship, feeds and tasks on a late failure and permits retry', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('rollback');
    await seedPending(alice.id, bob.id);
    const before = await state(alice, bob);
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
    const push = vi
      .spyOn(deps.federation, 'pushStateFeedNamespaces')
      .mockResolvedValue(undefined);
    const transaction = deps.database.db.transaction.bind(deps.database.db);
    const failure = vi
      .spyOn(deps.database.db, 'transaction')
      .mockImplementation(async (callback) =>
        transaction(async (tx) => {
          await callback(tx);
          throw new Error('late failure');
        }),
      );
    await expect(
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, namespaceId: 0 },
      }),
    ).rejects.toThrow('late failure');
    const failed = await state(alice, bob);
    expect(failed.pair).toEqual(before.pair);
    expect(failed.feeds).toEqual(before.feeds);
    expect(failed.threadTasks).toEqual(before.threadTasks);
    expect(notify).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    failure.mockRestore();
    await service.execute({
      userId: bob.id,
      decision: 'ACCEPTED',
      target: { account: alice.account, namespaceId: 0 },
    });
    expect((await state(alice, bob)).pair?.active).toBe(true);
  });

  it('activates exactly once under concurrent duplicate acceptance', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('ack-race');
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: bob.account, namespaceId: 0 },
    });
    // Two racing acceptances serialize on the endpoint/pair scopes: the loser
    // observes the active pair and must not double-write the system history.
    await Promise.all([
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, namespaceId: 0 },
      }),
      service.execute({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, namespaceId: 0 },
      }),
    ]);
    const after = await state(alice, bob);
    expect(after.pair?.active).toBe(true);
    expect(
      after.messages.filter(
        (message) => contentOf(message).type === 'FRIEND_ADDED',
      ),
    ).toHaveLength(1);
    // The state() helper reads both endpoints' feeds: the activated pair
    // publishes both canonical directions to each user, so the deduped total
    // is 2 users x 2 directions — exactly once per (user, direction) slot.
    expect(
      after.feeds.filter((feed) => body(feed.body)?.status === 'ACCEPTED'),
    ).toHaveLength(4);
  });

  it('resolves the direct-namespace pair over a mirrored same-account decoy', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('decoy');
    await service.execute({
      userId: alice.id,
      decision: 'REQUESTED',
      target: { account: bob.account, namespaceId: 0 },
    });
    // A group-mirror pair in a foreign namespace carries bob's account too;
    // the P2P locator must never capture it.
    const decoyNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      `decoy-${++sequence}.test`,
    );
    const [_mirror] = await database.db
      .insert(tables.relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'USER',
        endpointAAccount: bob.account,
        endpointANamespaceId: 0,
        endpointBType: 'GROUP',
        endpointBAccount: `!mirror-${sequence}`,
        endpointBNamespaceId: decoyNamespaceId,
        active: true,
        established: true,
        updatedAt: new Date(),
      })
      .returning({ id: tables.relationshipPair.id });
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: `!mirror-${sequence}`,
      receiverNamespaceId: decoyNamespaceId,
      status: 'REQUESTED',
      profileNamespaceId: 0,
      profileRev: 1,
      note: '',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      updatedAt: new Date(),
    });

    const revoked = await service.execute({
      userId: bob.id,
      decision: 'REVOKED',
      target: { account: alice.account, namespaceId: 0 },
    });
    expect(revoked).toEqual({ status: 'APPLIED' });
    const after = await state(bob, alice);
    expect(
      after.intents.find(
        (intent) =>
          intent.authorAccount === after.firstEndpoint.account &&
          intent.authorNamespaceId === after.firstEndpoint.namespaceId,
      )?.status,
    ).toBe('REVOKED');
    const mirrorIntents = await database.db.query.relationshipIntent.findMany({
      where: and(
        eq(tables.relationshipIntent.authorAccount, bob.account),
        eq(tables.relationshipIntent.authorNamespaceId, 0),
        eq(tables.relationshipIntent.receiverAccount, `!mirror-${sequence}`),
        eq(tables.relationshipIntent.receiverNamespaceId, decoyNamespaceId),
      ),
    });
    expect(mirrorIntents.map((intent) => intent.status)).toEqual(['REQUESTED']);
  });
});
