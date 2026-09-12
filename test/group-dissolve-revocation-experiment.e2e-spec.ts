import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';
import type { NamespacedAddress } from '../src/common/client-identity.js';
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
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AppModule } from '../src/app.module.js';
import {
  DatabaseService,
  databaseSchema,
} from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { MessageService } from '../src/message/message.service.js';
import { GroupDisbandMembershipRevocationService } from '../src/business/group/disband/group-disband-membership-revocation.service.js';
import type { GroupDisbandMembershipRevocationDependencies } from '../src/business/group/disband/group-disband-membership-revocation.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationService } from '../src/federation/federation.service.js';
import { FederationRelationshipMutationService } from '../src/federation/federation-relationship-mutation.service.js';
import { AuthoritativeGroupMetaMutationService } from '../src/federation/authoritative-group-meta-mutation.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { readCurrentGroupMemberInTx } from '../src/group-meta/current-group-roster.js';
import { findGroupRelationship, seedFederatedPeerNamespace, seedUser } from './seed.js';

/** The disband sweep's per-member departure: the legacy `FORCE_REVOKE_GROUP_MEMBER`
 * execution (`GroupService.revokeDissolvedGroupMember`) against the composed
 * business-SQL replacement. Both paths run on identical fixtures; the suite
 * compares canonical state, the departure effect set, the wake targets, and
 * reports statement counts. */
describe('experimental disband member revocation', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let deps: GroupDisbandMembershipRevocationDependencies;
  let baseline: GroupService;
  let experiment: GroupDisbandMembershipRevocationService;
  const statements: string[] = [];
  let sequence = 0;

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
          logQuery(query: string) {
            statements.push(query);
          },
        },
      }),
    });
    deps = {
      database: measured,
      clientFeed: app.get(ClientStateFeedService),
      peerFeed: app.get(PeerStateFeedService),
      federation: app.get(FederationService),
    };
    experiment = new GroupDisbandMembershipRevocationService(deps);
    baseline = new GroupService(
      measured,
      deps.federation,
      app.get(FederationRelationshipMutationService),
      deps.clientFeed,
      app.get(AuthoritativeGroupMetaMutationService),
      // The GROUP_LEFT system message and its fan-out admissions live in the
      // optional message dependency; the sweep's effect set needs them.
      app.get(MessageService),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database.db
      .delete(tables.systemSetting)
      .where(
        eq(tables.systemSetting.key, FEDERATION_HISTORY_ACCESS_SETTING_KEY),
      );
  });
  afterAll(async () => {
    await app?.close();
  });

  async function runRevocation(
    path: 'baseline' | 'experiment',
    params: { threadId: number; memberUserId: NamespacedAddress },
  ): Promise<{ transitioned?: boolean }> {
    statements.length = 0;
    if (path === 'baseline') {
      // The legacy wrapper commits the departure but drops the transition flag.
      await baseline.revokeDissolvedGroupMember({
        threadId: params.threadId,
        memberUserId: params.memberUserId,
      });
      return {};
    }
    return experiment.execute({
      threadId: params.threadId,
      memberAddress: params.memberUserId,
    });
  }

  /** An owner, a local member on the roster, and the dissolved group fact. */
  async function localFixture(tag: string) {
    const prefix = `dbr-${tag}-${++sequence}`;
    const owner = await seedUser(app, `${prefix}-owner`);
    const member = await seedUser(app, `${prefix}-member`);
    const created = await baseline.createNewGroup({
      owner: owner.id,
      name: 'Disband experiment',
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, created.threadId),
    });
    const groupAddress = { account: thread!.groupAccount!, domain: 'local' };
    // Activate the member through the production acceptance path.
    await database.db.transaction((tx) =>
      app.get(FederationRelationshipMutationService).writeMemberRelationshipIntentInTx(
        tx,
        created.threadId,
        member.id,
        'REQUESTED',
        [],
        '',
      ),
    );
    const { pair } = await findGroupRelationship(
      database.db,
      created.threadId,
      member.id,
    );
    const intent = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(tables.relationshipIntent.pairId, pair!.id),
        eq(tables.relationshipIntent.authorSide, 'B'),
      ),
    });
    await baseline.handleJoinRequest({
      threadId: created.threadId,
      managerUserId: owner.id,
      requestId: intent!.id,
      decision: 'ACCEPTED',
    });
    await dissolveGroup(groupAddress.account);
    return {
      owner,
      member,
      threadId: created.threadId,
      groupAddress,
      memberUserId: {
        account: member.account,
        domain: 'local',
        namespaceId: 0,
      } satisfies NamespacedAddress,
    };
  }

  /** A dissolved group whose remaining member is peer-hosted: pair, intents,
   * roster fact, and audience are seeded directly — the federation handshake
   * that would normally produce them is out of scope here. */
  async function remoteFixture(tag: string) {
    const prefix = `dbrr-${tag}-${++sequence}`;
    const domain = `${prefix}.test`;
    const owner = await seedUser(app, `${prefix}-owner`);
    const created = await baseline.createNewGroup({
      owner: owner.id,
      name: 'Disband remote experiment',
    });
    const threadId = created.threadId;
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
    });
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const memberAccount = `${prefix}-member`;
    await database.db.execute(sql`
      WITH pair AS (
        INSERT INTO "RelationshipPair"
          (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
           "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId", active)
        VALUES ('GROUP_MEMBER', 'GROUP', ${thread!.groupAccount!}, 'local', ${namespaceId},
          'USER', ${memberAccount}, ${domain}, ${namespaceId}, ${threadId}, true)
        RETURNING id
      ), intents AS (
        INSERT INTO "RelationshipIntent"
          ("pairId", "authorSide", status, "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
           "requestedAt", "updatedAt")
        SELECT id, side, 'ACCEPTED'::"RelationshipIntentStatus", 0, '', 0, 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM pair, (VALUES ('A'::text), ('B'::text)) sides(side)
        RETURNING "pairId"
      ), meta AS (
        INSERT INTO "GroupMeta" ("threadId") VALUES (${threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "threadId", "metaEndId"
      ), roster AS (
        INSERT INTO "GroupMetaMemberFeed"
          ("threadId", "feedId", "memberAccount", "memberDomain", "memberNamespaceId", operation, body)
        SELECT m."threadId", m."metaEndId" + 1, ${memberAccount}, ${domain}, ${namespaceId},
          'UPSERT'::"GroupMetaMemberOperation", '{"role":"MEMBER","profileRev":1}'::jsonb
        FROM meta m
        RETURNING "threadId"
      ), bump AS (
        UPDATE "GroupMeta" g SET "metaEndId" = g."metaEndId" + 1
        FROM roster r WHERE g."threadId" = r."threadId"
        RETURNING g."threadId"
      )
      INSERT INTO "ThreadAudience"
        ("targetDomain", "targetNamespaceId", "threadId", "groupMetaVisibleAfter")
      SELECT ${domain}, ${namespaceId}, ${threadId}, 0 FROM bump
    `);
    await dissolveGroup(thread!.groupAccount!);
    return {
      owner,
      threadId,
      groupAccount: thread!.groupAccount!,
      memberUserId: {
        account: memberAccount,
        domain,
        namespaceId,
      } satisfies NamespacedAddress,
    };
  }

  async function dissolveGroup(groupAccount: string): Promise<void> {
    await database.db
      .update(tables.groupAccount)
      .set({ dissolvedAt: new Date() })
      .where(eq(tables.groupAccount.account, groupAccount));
  }

  interface ThreadTaskDelta {
    [taskType: string]: number;
  }

  async function threadTasks(threadId: number): Promise<ThreadTaskDelta> {
    const rows = await database.db
      .select({
        taskType: tables.durableTask.taskType,
        count: sql<number>`count(*)::int`,
      })
      .from(tables.durableTask)
      .where(sql`${tables.durableTask.payload} ->> 'threadId' = ${String(threadId)}`)
      .groupBy(tables.durableTask.taskType);
    return Object.fromEntries(rows.map((row) => [row.taskType, row.count]));
  }

  async function localMemberState(fixture: Awaited<ReturnType<typeof localFixture>>) {
    const { pair } = await findGroupRelationship(
      database.db,
      fixture.threadId,
      fixture.member.id,
    );
    const intents = await database.db.query.relationshipIntent.findMany({
      where: eq(tables.relationshipIntent.pairId, pair!.id),
      orderBy: tables.relationshipIntent.authorSide,
    });
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupMemberInTx(tx, fixture.threadId, fixture.member.id),
    );
    const participant = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, fixture.threadId),
        eq(tables.accountThreadState.accountId, fixture.member.id),
      ),
    });
    const audience = await database.db.query.threadAudience.findFirst({
      where: and(
        eq(tables.threadAudience.threadId, fixture.threadId),
        eq(tables.threadAudience.localUserId, fixture.member.id),
      ),
    });
    const projection = await database.db.query.groupRequestProjection.findFirst({
      where: and(
        eq(tables.groupRequestProjection.threadId, fixture.threadId),
        eq(
          tables.groupRequestProjection.memberAccount,
          fixture.member.account,
        ),
      ),
    });
    const memberFeeds = await database.db.query.clientStateFeed.findMany({
      where: and(
        eq(tables.clientStateFeed.userId, fixture.member.id),
        eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    const systemMessages = await database.db.query.message.findMany({
      where: and(
        eq(tables.message.threadId, fixture.threadId),
        eq(tables.message.contentType, 'SYSTEM'),
      ),
      orderBy: tables.message.seq,
    });
    return {
      pair,
      intents,
      roster,
      participant,
      audience,
      projection,
      memberFeeds,
      systemMessages,
    };
  }

  it.each(['baseline', 'experiment'] as const)(
    '%s departs a local rostered member of a dissolved group',
    async (path) => {
      vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
        undefined,
      );
      const fixture = await localFixture(path);
      const tasksBefore = await threadTasks(fixture.threadId);
      const messagesBefore = (await localMemberState(fixture)).systemMessages
        .length;
      statements.length = 0;
      const result = await runRevocation(path, fixture);
      const queryCount = statements.length;
      if (path === 'experiment') expect(result).toEqual({ transitioned: true });
      const state = await localMemberState(fixture);
      // Canonical relationship state: the pair closes and both authored sides
      // read REVOKED — the sweep's group authors side B itself.
      expect(state.pair?.active).toBe(false);
      expect(
        state.intents.map((intent) => [intent.authorSide, intent.status]),
      ).toEqual([
        ['A', 'REVOKED'],
        ['B', 'REVOKED'],
      ]);
      // The disband fan-out writes no DEPART fact: a dissolved group keeps its
      // last roster entry (updateCanonicalRoster is off on this path).
      expect(state.roster).toMatchObject({ role: 'MEMBER' });
      // Departure effects: the GROUP_LEFT message, the member watermark, the
      // closed local audience, and the flipped manager projection.
      expect(state.systemMessages.length).toBe(messagesBefore + 1);
      const left = state.systemMessages.at(-1)!;
      const leftContent =
        typeof left.content === 'string'
          ? JSON.parse(left.content)
          : left.content;
      expect(leftContent).toMatchObject({
        type: 'GROUP_LEFT',
        member: { account: fixture.member.account, domain: 'local' },
      });
      expect(state.participant?.messageVisibleThroughSeq).toBe(left.seq);
      expect(state.audience).toBeUndefined();
      expect(state.projection).toMatchObject({ status: 'REVOKED' });
      // Fan-out admissions: the thread content head and exactly one departure
      // task for the departing member; no meta-head refresh, no reverse task.
      const tasksAfter = await threadTasks(fixture.threadId);
      expect(
        (tasksAfter['FAN_OUT_THREAD_CONTENT'] ?? 0) -
          (tasksBefore['FAN_OUT_THREAD_CONTENT'] ?? 0),
      ).toBe(1);
      expect(
        (tasksAfter['FAN_OUT_ACCOUNT_THREAD_CONTENT'] ?? 0) -
          (tasksBefore['FAN_OUT_ACCOUNT_THREAD_CONTENT'] ?? 0),
      ).toBe(1);
      expect(tasksAfter['REVOKE_USER_RELATIONSHIP'] ?? 0).toBe(0);
      expect(
        (tasksAfter['FAN_OUT_GROUP_META_HEAD'] ?? 0) -
          (tasksBefore['FAN_OUT_GROUP_META_HEAD'] ?? 0),
      ).toBe(0);
      // Recipient writes: the group→member flip and the member's own OUTGOING
      // entry, both REVOKED. Manager cosmetic rows stay with the reconcile
      // path under the v2 flip-only doctrine — only the projection flip is
      // decision-time work.
      const intentFeeds = state.memberFeeds.map((feed) => ({
        account: feed.account,
        subject: feed.subjectAccount,
        body: feed.body as Record<string, unknown>,
      }));
      expect(intentFeeds).toContainEqual(
        expect.objectContaining({
          account: fixture.groupAddress.account,
          subject: fixture.member.account,
          body: expect.objectContaining({ status: 'REVOKED' }),
        }),
      );
      expect(intentFeeds).toContainEqual(
        expect.objectContaining({
          account: fixture.member.account,
          subject: fixture.groupAddress.account,
          body: expect.objectContaining({
            status: 'REVOKED',
            direction: 'OUTGOING',
          }),
        }),
      );
      process.stdout.write(
        `${path} local member departure: ${queryCount} SQL statements\n`,
      );
    },
  );

  it.each(['baseline', 'experiment'] as const)(
    '%s treats a repeated revocation as a satisfied no-op',
    async (path) => {
      vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
        undefined,
      );
      const fixture = await localFixture(path);
      await runRevocation(path, fixture);
      const first = await localMemberState(fixture);
      const tasksBefore = await threadTasks(fixture.threadId);
      const result = await runRevocation(path, fixture);
      if (path === 'experiment') expect(result.transitioned).toBe(false);
      const second = await localMemberState(fixture);
      expect(second.pair?.active).toBe(false);
      expect(second.systemMessages.length).toBe(first.systemMessages.length);
      expect(second.memberFeeds.length).toBe(first.memberFeeds.length);
      const tasksAfter = await threadTasks(fixture.threadId);
      expect(tasksAfter).toEqual(tasksBefore);
    },
  );

  it.each(['baseline', 'experiment'] as const)(
    '%s refuses to sweep a member of an undissolved group',
    async (path) => {
      const prefix = `dbr-live-${++sequence}`;
      const owner = await seedUser(app, `${prefix}-owner`);
      const created = await baseline.createNewGroup({
        owner: owner.id,
        name: 'Disband live experiment',
      });
      await expect(
        runRevocation(path, {
          threadId: created.threadId,
          memberUserId: {
            account: owner.account,
            domain: 'local',
            namespaceId: 0,
          },
        }),
      ).rejects.toThrow('group member fan-out requires a dissolved group');
    },
  );

  it.each(['baseline', 'experiment'] as const)(
    '%s mints and departs an address that never joined',
    async (path) => {
      vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
        undefined,
      );
      const prefix = `dbr-stray-${++sequence}`;
      const owner = await seedUser(app, `${prefix}-owner`);
      const stranger = await seedUser(app, `${prefix}-stranger`);
      const created = await baseline.createNewGroup({
        owner: owner.id,
        name: 'Disband stray experiment',
      });
      await dissolveGroup((await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, created.threadId),
      }))!.groupAccount!);
      const result = await runRevocation(path, {
        threadId: created.threadId,
        memberUserId: {
          account: stranger.account,
          domain: 'local',
          namespaceId: 0,
        },
      });
      // Legacy contract: the lock chain mints the canonical pair and the
      // departure proceeds on it (a missing intent is not REVOKED yet).
      if (path === 'experiment') expect(result).toEqual({ transitioned: true });
      const { pair } = await findGroupRelationship(
        database.db,
        created.threadId,
        stranger.id,
      );
      expect(pair).toBeDefined();
      expect(pair?.active).toBe(false);
      const intents = await database.db.query.relationshipIntent.findMany({
        where: eq(tables.relationshipIntent.pairId, pair!.id),
        orderBy: tables.relationshipIntent.authorSide,
      });
      expect(
        intents.map((intent) => [intent.authorSide, intent.status]),
      ).toEqual([
        ['A', 'REVOKED'],
        ['B', 'REVOKED'],
      ]);
    },
  );

  it('rolls back the composed departure on a late failure and permits retry', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedDomains').mockResolvedValue(
      undefined,
    );
    const fixture = await localFixture('rollback');
    const before = await localMemberState(fixture);
    const tasksBefore = await threadTasks(fixture.threadId);
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
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
      experiment.execute({
        threadId: fixture.threadId,
        memberAddress: fixture.memberUserId,
      }),
    ).rejects.toThrow('late failure');
    const failed = await localMemberState(fixture);
    expect(failed.pair?.active).toBe(true);
    expect(failed.systemMessages.length).toBe(before.systemMessages.length);
    expect(await threadTasks(fixture.threadId)).toEqual(tasksBefore);
    expect(notify).not.toHaveBeenCalled();
    failure.mockRestore();
    await experiment.execute({
      threadId: fixture.threadId,
      memberAddress: fixture.memberUserId,
    });
    expect((await localMemberState(fixture)).pair?.active).toBe(false);
  });

  it.each(['baseline', 'experiment'] as const)(
    '%s departs a peer-hosted member through the peer feed',
    async (path) => {
      const wakes: string[][] = [];
      vi.spyOn(deps.federation, 'pushStateFeedDomains').mockImplementation(
        async (domains) => {
          wakes.push([...domains]);
        },
      );
      const fixture = await remoteFixture(path);
      const member = fixture.memberUserId;
      const tasksBefore = await threadTasks(fixture.threadId);
      const result = await runRevocation(path, fixture);
      if (path === 'experiment') expect(result).toEqual({ transitioned: true });
      expect(wakes.at(-1)).toEqual([member.domain]);
      const { pair } = await findGroupRelationship(
        database.db,
        fixture.threadId,
        member,
      );
      const intents = await database.db.query.relationshipIntent.findMany({
        where: eq(tables.relationshipIntent.pairId, pair!.id),
        orderBy: tables.relationshipIntent.authorSide,
      });
      expect(pair?.active).toBe(false);
      // Side A is the sweep's authored revocation; side B (the member's own
      // intent) stays as seeded — only local members author side B here.
      expect(
        intents.map((intent) => [intent.authorSide, intent.status]),
      ).toEqual([
        ['A', 'REVOKED'],
        ['B', 'ACCEPTED'],
      ]);
      // No local identity: the roster fact stays, the audience closes, and the
      // departure travels as one RELATIONSHIP_INTENT REVOKED peer event.
      const roster = await database.db.execute<{ operation: string }>(sql`
        SELECT operation FROM "GroupMetaMemberFeed"
        WHERE "threadId" = ${fixture.threadId} AND "memberAccount" = ${member.account}
        ORDER BY "feedId" DESC LIMIT 1
      `);
      expect(roster.rows[0]?.operation).toBe('UPSERT');
      const audience = await database.db.query.threadAudience.findFirst({
        where: and(
          eq(tables.threadAudience.threadId, fixture.threadId),
          eq(tables.threadAudience.targetDomain, member.domain),
        ),
      });
      expect(audience).toBeUndefined();
      const peerEvent = await database.db.query.peerStateFeed.findFirst({
        where: and(
          eq(tables.peerStateFeed.namespaceId, member.namespaceId),
          eq(tables.peerStateFeed.account, fixture.groupAccount),
          eq(tables.peerStateFeed.subjectAccount, member.account),
          eq(tables.peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
      expect(peerEvent?.body).toMatchObject({ status: 'REVOKED' });
      const tasksAfter = await threadTasks(fixture.threadId);
      expect(tasksAfter['FAN_OUT_ACCOUNT_THREAD_CONTENT'] ?? 0).toBe(
        tasksBefore['FAN_OUT_ACCOUNT_THREAD_CONTENT'] ?? 0,
      );
      expect(tasksAfter['REVOKE_USER_RELATIONSHIP'] ?? 0).toBe(0);
    },
  );
});
