import {
  experimentalPairBusinessKey,
  type PairAddressScope,
} from '../src/business-v2/shared/locks/pair-business-lock.js';
import { businessAccountScopeKey } from '../src/relationship/business-scope-lock.js';
import {
  findP2PRelationship,
  seedAcceptedRelationship,
  seedFederatedPeerNamespace,
  seedUser,
} from './seed.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AppModule } from '../src/app.module.js';
import {
  DatabaseService,
  databaseSchema,
} from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { RelationshipService } from '../src/relationship/relationship.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationService } from '../src/federation/federation.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import {
  ExperimentalUserIntentService,
  type UserIntentDependencies,
} from '../src/business-v2/user/p2p-intent/user-intent-decision.service.js';

type Seeded = Awaited<ReturnType<typeof seedUser>>;

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
    kind: pair.kind,
    addresses: [
      `${pair.endpointAAccount}@${pair.endpointADomain}`.toLowerCase(),
      `${pair.endpointBAccount}@${pair.endpointBDomain}`.toLowerCase(),
    ],
  };
}

describe('experimental user intent decision', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let deps: UserIntentDependencies;
  let experiment: ExperimentalUserIntentService;
  let baseline: RelationshipService;
  const statements: string[] = [];
  const businessLocks: string[] = [];
  let sequence = 0;

  /** Dispatches one command to the baseline service or the experiment under
   * its own entry; the baseline keeps the production entries untouched. */
  async function runIntent(
    path: 'baseline' | 'experiment',
    params: {
      userId: number;
      targetUserId: number | null;
      target: { account: string; domain: string };
      decision: 'ACCEPTED' | 'REVOKED' | 'REQUESTED';
      note?: string;
    },
  ): Promise<void> {
    if (path === 'baseline') {
      const peerUserId = params.targetUserId;
      if (peerUserId === null)
        throw new Error('baseline commands require a local peer');
      if (params.decision === 'REQUESTED')
        await baseline.createRelationshipRequest(
          params.userId,
          peerUserId,
          params.note ?? '',
        );
      else if (params.decision === 'ACCEPTED')
        await baseline.acceptRelationshipRequest(peerUserId, params.userId);
      else await baseline.revokeRelationshipRequest(peerUserId, params.userId);
      return;
    }
    await experiment.handleUserIntent({
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
    const measured = Object.create(database) as DatabaseService;
    Object.defineProperty(measured, 'db', {
      value: drizzle({
        client: database.pool,
        schema: databaseSchema,
        logger: {
          logQuery(query: string, params: unknown[]) {
            statements.push(query);
            if (
              query.includes('pg_advisory_xact_lock') &&
              typeof params[0] === 'string'
            )
              businessLocks.push(params[0]);
          },
        },
      }),
    });
    deps = {
      database: measured,
      clientFeed: app.get(ClientStateFeedService),
      peerFeed: app.get(PeerStateFeedService),
      federation: app.get(FederationService),
      namespaces: app.get(FederationNamespaceService),
    };
    experiment = new ExperimentalUserIntentService(deps);
    baseline = new RelationshipService(
      measured,
      app.get(AccountThreadStateService),
      deps.clientFeed,
      app.get(RelationshipIntentService),
      deps.namespaces,
      app.get(MessageService),
    );
    // Property-injected collaborators the constructor signature does not carry.
    baseline['previews'] = app.get(
      (await import('../src/message/thread-preview.service.js')).ThreadPreviewService,
    );
    baseline['tasks'] = app.get(
      (await import('../src/durable-task/durable-task-queue.service.js')).DurableTaskQueueService,
    );
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

  /** Seed a pending request with the production service (uncounted setup). */
  function seedPending(fromUserId: number, toUserId: number, note = 'please') {
    return app
      .get(RelationshipService)
      .createRelationshipRequest(fromUserId, toUserId, note);
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
            domain: bob.domain!,
            namespaceId: bob.namespaceId ?? 0,
          };
    const { pair, firstSide } = await findP2PRelationship(
      database.db,
      alice.id,
      bobTarget,
    );
    const intents = pair
      ? await database.db.query.relationshipIntent.findMany({
          where: eq(tables.relationshipIntent.pairId, pair.id),
          orderBy: tables.relationshipIntent.authorSide,
        })
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
    const reverseTasks = tasks.filter(
      (task) =>
        task.taskType === 'REVOKE_USER_RELATIONSHIP' &&
        task.scopeType === 'USER_PAIR' &&
        body(task.payload)['targetUserId']?.account === alice.account,
    );
    return {
      pair,
      firstSide,
      intents,
      thread,
      messages,
      states,
      audiences,
      feeds,
      threadTasks,
      reverseTasks,
    };
  }

  it('reduces SQL round trips against the unchanged baseline', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    for (const decision of ['REQUESTED', 'ACCEPTED', 'REVOKED'] as const) {
      const counts: number[] = [];
      for (const path of ['baseline', 'experiment'] as const) {
        const { alice, bob } = await twoUsers('count');
        if (decision !== 'REQUESTED') await seedPending(alice.id, bob.id);
        statements.length = 0;
        await runIntent(path, {
          userId: decision === 'ACCEPTED' ? bob.id : alice.id,
          targetUserId: decision === 'ACCEPTED' ? alice.id : bob.id,
          target: {
            account: decision === 'ACCEPTED' ? alice.account : bob.account,
            domain: 'local',
          },
          decision,
          note: 'hello',
        });
        counts.push(statements.length);
      }
      console.log(
        `${decision} baseline: ${counts[0]} SQL statements, experiment: ${counts[1]} SQL statements`,
      );
      expect(counts[0] - counts[1]).toBeGreaterThanOrEqual(20);
    }
  });

  it('requests a fresh local friendship with shell-only effects', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-local');
    statements.length = 0;
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REQUESTED',
      note: 'let us chat',
    });
    console.log(`experiment REQ local: ${statements.length} SQL statements`);
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: false });
    expect(after.pair!.threadId).not.toBeNull();
    expect(after.thread).toMatchObject({ type: 'P2P' });
    // The authoring side holds REQUESTED with the seven-day TTL.
    const authored = after.intents.find(
      (intent) => intent.authorSide === after.firstSide,
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
    expect(
      after.states.every((s) => s.messageVisibleThroughSeq === null),
    ).toBe(true);
    // Both local endpoints learn the pending direction; no peer event, no tasks.
    expect(after.feeds).toHaveLength(2);
    expect(body(after.feeds[0].body).direction).toBe('OUTGOING');
    expect(body(after.feeds[1].body).direction).toBe('INCOMING');
    for (const feed of after.feeds)
      expect(body(feed.body).peer).toMatchObject({ account: bob.account });
    expect(after.audiences).toHaveLength(0);
    expect(after.threadTasks).toHaveLength(0);
  });

  it('accepts an application like the baseline', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('ack-local');
    await seedPending(alice.id, bob.id, 'please');
    statements.length = 0;
    await runIntent('experiment', {
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, domain: 'local' },
      decision: 'ACCEPTED',
    });
    console.log(`experiment ACK local: ${statements.length} SQL statements`);
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
    expect(contentOf(after.messages[0])).toEqual({ type: 'FRIEND_ADDED' });
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
  });

  it('collapses a crossed request into the acceptance path', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-cross');
    await seedPending(bob.id, alice.id, 'from bob');
    statements.length = 0;
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REQUESTED',
      note: 'from alice',
    });
    console.log(
      `experiment REQ+REQ collapse: ${statements.length} SQL statements`,
    );
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
    expect(contentOf(after.messages[0])).toEqual({ type: 'FRIEND_ADDED' });
  });

  it('no-ops an already-active acceptance and rejects a stale one', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('ack-noop');
    await seedFriends(alice.id, bob.id);
    const before = await state(alice, bob);
    await expect(
      experiment.handleUserIntent({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, domain: 'local' },
      }),
    ).resolves.toBeUndefined();
    const after = await state(alice, bob);
    expect(after.pair).toEqual(before.pair);
    expect(after.feeds).toHaveLength(before.feeds.length);
    // A stale accept (no live reverse request) reports NOT_FOUND.
    const carol = await seedUser(app, `ack-stale-${++sequence}-carol`);
    await expect(
      experiment.handleUserIntent({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: carol.account, domain: 'local' },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('revokes a pending request without any departure effect', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-pending');
    await seedPending(alice.id, bob.id);
    statements.length = 0;
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REVOKED',
    });
    console.log(
      `experiment REVOKED withdraw: ${statements.length} SQL statements`,
    );
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: false });
    const authored = after.intents.find(
      (intent) => intent.authorSide === after.firstSide,
    );
    expect(authored).toMatchObject({ status: 'REVOKED' });
    expect(after.messages).toHaveLength(0);
    expect(after.threadTasks).toHaveLength(0);
    expect(after.reverseTasks).toHaveLength(0);
  });

  it('rejects an incoming request through the same revocation', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-reject');
    await seedPending(alice.id, bob.id, 'hello?');
    await runIntent('experiment', {
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, domain: 'local' },
      decision: 'REVOKED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false });
    // The recipient authored their own REVOKED; the applicant stays REQUESTED
    // so a later re-application works through the existing gate.
    expect(after.intents.map((intent) => intent.status)).toContain(
      'REQUESTED',
    );
    expect(after.intents.map((intent) => intent.status)).toContain('REVOKED');
    expect(after.messages).toHaveLength(0);
  });

  it('ends a friendship with the full departure effect set', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('revoke-friend');
    const threadId = await seedFriends(alice.id, bob.id);
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REVOKED',
    });
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: false, established: true });
    expect(after.thread).toMatchObject({ federationRoundsEnabled: false });
    expect(after.thread!.authorizationEpoch).toBeGreaterThan(0);
    expect(after.messages).toHaveLength(1);
    expect(contentOf(after.messages[0])).toEqual({
      type: 'FRIEND_REMOVED',
      initiator: { account: alice.account, domain: 'local' },
    });
    const departureSeq = after.messages[0].seq;
    for (const participant of after.states)
      expect(participant.messageVisibleThroughSeq).toBe(departureSeq);
    expect(after.audiences).toHaveLength(0);
    const threadTask = after.threadTasks.find(
      (task) => task.taskType === 'FAN_OUT_THREAD_CONTENT',
    );
    expect(threadTask).toMatchObject({ status: 'PENDING', scopeType: 'THREAD' });
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
    // The local peer authors their own REVOKED through the reverse task.
    const reverse = after.reverseTasks[0];
    expect(reverse).toMatchObject({ kind: 'MUTATION', status: 'PENDING' });
    expect(reverse!.payload).toMatchObject({
      operation: 'RESPOND_TO_REVOKE',
      intentAuthorUserId: bob.id,
      targetUserId: { account: alice.account, domain: 'local', namespaceId: 0 },
    });
    // Both endpoints learn the closure with the sticky established flag.
    const revokedFeeds = after.feeds.filter(
      (feed) => body(feed.body).status === 'REVOKED',
    );
    expect(revokedFeeds.length).toBeGreaterThanOrEqual(2);
    for (const feed of revokedFeeds.slice(0, 2))
      expect(body(feed.body).established).toBe(true);
  });

  it('re-friends after a withdrawal through the crossed acceptance', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('req-refriend');
    await seedFriends(alice.id, bob.id);
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REVOKED',
    });
    expect((await state(alice, bob)).pair).toMatchObject({ active: false });
    statements.length = 0;
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: bob.id,
      target: { account: bob.account, domain: 'local' },
      decision: 'REQUESTED',
    });
    console.log(
      `experiment REQ after withdrawal: ${statements.length} SQL statements`,
    );
    const after = await state(alice, bob);
    expect(after.pair).toMatchObject({ active: true, established: true });
    expect(after.intents.map((intent) => intent.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
  });

  it('requests a remote peer through the peer feed', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const prefix = `req-remote-${++sequence}`;
    const alice = await seedUser(app, `${prefix}-alice`);
    const domain = `${prefix}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    statements.length = 0;
    await runIntent('experiment', {
      userId: alice.id,
      targetUserId: null,
      target: { account: `${prefix}-peer`, domain },
      decision: 'REQUESTED',
      note: 'cross-server hello',
    });
    console.log(`experiment REQ remote: ${statements.length} SQL statements`);
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
      endpointADomain: 'local',
      endpointBAccount: `${prefix}-peer`,
      endpointBDomain: domain,
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

  it('acquires the endpoint scopes then the pair scope once', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('locks');
    await seedPending(alice.id, bob.id);
    businessLocks.length = 0;
    await runIntent('experiment', {
      userId: bob.id,
      targetUserId: alice.id,
      target: { account: alice.account, domain: 'local' },
      decision: 'ACCEPTED',
    });
    const { pair } = await findP2PRelationship(database.db, alice.id, bob.id);
    expect(businessLocks).toEqual([
      businessAccountScopeKey({ account: alice.account, domain: 'local' }),
      businessAccountScopeKey({ account: bob.account, domain: 'local' }),
      experimentalPairBusinessKey(pairScope(pair!)),
    ]);
  });

  it('rolls back relationship, feeds and tasks on a late failure and permits retry', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const { alice, bob } = await twoUsers('rollback');
    await seedPending(alice.id, bob.id);
    const before = await state(alice, bob);
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
    const push = vi
      .spyOn(deps.federation, 'pushStateFeedDomains')
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
      experiment.handleUserIntent({
        userId: bob.id,
        decision: 'ACCEPTED',
        target: { account: alice.account, domain: 'local' },
      }),
    ).rejects.toThrow('late failure');
    const failed = await state(alice, bob);
    expect(failed.pair).toEqual(before.pair);
    expect(failed.feeds).toEqual(before.feeds);
    expect(failed.threadTasks).toEqual(before.threadTasks);
    expect(notify).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    failure.mockRestore();
    await experiment.handleUserIntent({
      userId: bob.id,
      decision: 'ACCEPTED',
      target: { account: alice.account, domain: 'local' },
    });
    expect((await state(alice, bob)).pair?.active).toBe(true);
  });
});
