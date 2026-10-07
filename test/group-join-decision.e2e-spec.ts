import {
  relationshipPairBusinessKey,
  lockRelationshipPairsInTx,
  type PairAddressScope,
} from '../src/common/locks/relationship-pair-business-lock.js';
import { businessAccountScopeKey } from '../src/common/locks/account-business-lock.js';
import { localIdentityDomain } from './support/local-domain.js';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';
import {
  admitGroupMembershipProjectionFanoutInTx,
  groupMembershipProjectionFanoutKey,
} from '../src/group/membership-intent/shared/group-membership-projection-fanout.js';
import { GroupMembershipProjectionFanoutService } from '../src/group/membership-intent/shared/group-membership-projection-fanout.service.js';
import { mintGroupMemberPairInTx } from '../src/group/membership-intent/shared/group-member-pair-mint.js';
import { withMessageDigest } from './support/message-fixture.js';
import { insertPendingTaskInTx } from '../src/durable-task/task-admission.js';
import { seedFederatedPeerNamespace } from './seed.js';
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
import { and, eq, or, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { GroupRole } from '../src/database/enums.js';
import { GroupService } from '../src/group/group.service.js';
import {
  GroupAuthoredMembershipIntentService,
  type GroupAuthoredMembershipIntentDependencies,
} from '../src/group/membership-intent/authored/group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from '../src/group/membership-intent/authored/member-authored-group-membership-intent.service.js';
import { GroupRosterRoleService } from '../src/group/roster-role/group-roster-role.service.js';
import { withBusinessLockCapture } from './business-lock-capture.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationStateFeedPushService } from '../src/federation/federation-state-feed-push.service.js';
import { GroupRelationshipMutationService } from '../src/group/membership-intent/shared/group-relationship-mutation.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { lockBusinessAccountsInTx } from '../src/common/locks/account-business-lock.js';
import { readCurrentGroupMemberInTx } from '../src/group/meta/current-group-roster.js';
import { findGroupRelationship, seedUser } from './seed.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pairScope(
  pair: typeof tables.relationshipPair.$inferSelect,
): PairAddressScope {
  return {
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

/** This suite hosts every group locally, so the group endpoint authors from
 * namespace 0 while members carry their own namespaces. */
function groupDirection(
  groupAccount: string,
  memberAccount: string,
  memberNamespaceId = 0,
) {
  return and(
    eq(tables.relationshipIntent.authorAccount, groupAccount),
    eq(tables.relationshipIntent.authorNamespaceId, 0),
    eq(tables.relationshipIntent.receiverAccount, memberAccount),
    eq(tables.relationshipIntent.receiverNamespaceId, memberNamespaceId),
  );
}

function memberDirection(
  groupAccount: string,
  memberAccount: string,
  memberNamespaceId = 0,
) {
  return and(
    eq(tables.relationshipIntent.authorAccount, memberAccount),
    eq(tables.relationshipIntent.authorNamespaceId, memberNamespaceId),
    eq(tables.relationshipIntent.receiverAccount, groupAccount),
    eq(tables.relationshipIntent.receiverNamespaceId, 0),
  );
}

/** Flow-entry group advisory: the mutation writers hold row locks only. */
async function lockGroupScopeInTx(
  tx: DatabaseTransaction,
  threadId: number,
): Promise<void> {
  const thread = await tx.query.messageThread.findFirst({
    where: eq(tables.messageThread.id, threadId),
    columns: { groupAccount: true, authorityNamespaceId: true },
  });
  if (!thread?.groupAccount)
    throw new Error(`group thread ${threadId} is missing its scope address`);
  await lockBusinessAccountsInTx(tx, [
    {
      account: thread.groupAccount,
      profileNamespaceId: thread.authorityNamespaceId,
    },
  ]);
}

describe('group join decision', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let deps: GroupAuthoredMembershipIntentDependencies;
  let services: {
    groups: GroupService;
    intents: RelationshipIntentService;
    mutations: GroupRelationshipMutationService;
    previews: ThreadPreviewService;
    rosterRoles: GroupRosterRoleService;
  };
  let authoredIntents: GroupAuthoredMembershipIntentService;
  const businessLocks: string[] = [];
  let sequence = 0;

  /** Dispatches one ACK/REVOKE decision to the intent service. */
  async function runDecision(params: {
    threadId: number;
    managerUserId: number;
    target: { account: string; domain: string };
    scope: 'APPLICATION';
    decision: 'ACCEPTED' | 'REVOKED';
  }): Promise<void> {
    await authoredIntents.execute(params);
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
      relationshipMutations: app.get(GroupRelationshipMutationService),
    };
    services = {
      groups: app.get(GroupService),
      intents: app.get(RelationshipIntentService),
      mutations: app.get(GroupRelationshipMutationService),
      previews: app.get(ThreadPreviewService),
      rosterRoles: app.get(GroupRosterRoleService),
    };
    authoredIntents = new GroupAuthoredMembershipIntentService(deps);
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

  async function fixture() {
    const prefix = `join-${++sequence}`;
    const owner = await seedUser(app, `${prefix}-owner`);
    const applicant = await seedUser(app, `${prefix}-member`);
    const created = await services.groups.createNewGroup({
      owner: owner.id,
      name: 'Join authoredIntents',
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, created.threadId),
    });
    const group = { ...created, account: thread!.groupAccount! };
    await database.db.transaction(async (tx) => {
      await lockGroupScopeInTx(tx, group.threadId);
      return services.mutations.writeMemberRelationshipIntentInTx(
        tx,
        group.threadId,
        applicant.id,
        'REQUESTED',
        [],
        'please',
      );
    });
    const { pair } = await findGroupRelationship(
      database.db,
      group.threadId,
      applicant.id,
    );
    const _intent = await database.db.query.relationshipIntent.findFirst({
      where: memberDirection(group.account, applicant.account),
    });
    return {
      owner,
      applicant,
      group,
      pair: pair!,
      requestDirection: memberDirection(group.account, applicant.account),
      params: {
        threadId: group.threadId,
        managerUserId: owner.id,
        target: {
          account: applicant.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
        scope: 'APPLICATION' as const,
        decision: 'ACCEPTED' as const,
      },
    };
  }

  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    const { pair } = await findGroupRelationship(
      database.db,
      f.group.threadId,
      f.applicant.id,
    );
    const intents = await database.db.query.relationshipIntent.findMany({
      where: or(
        groupDirection(f.group.account, f.applicant.account),
        memberDirection(f.group.account, f.applicant.account),
      ),
    });
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupMemberInTx(tx, f.group.threadId, f.applicant.id),
    );
    const participant = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, f.group.threadId),
        eq(tables.accountThreadState.accountId, f.applicant.id),
      ),
    });
    const audience = await database.db.query.threadAudience.findFirst({
      where: and(
        eq(tables.threadAudience.threadId, f.group.threadId),
        eq(tables.threadAudience.localUserId, f.applicant.id),
      ),
    });
    const projection = await database.db.query.groupRequestProjection.findFirst(
      {
        where: and(
          eq(tables.groupRequestProjection.threadId, f.group.threadId),
          eq(tables.groupRequestProjection.memberAccount, f.applicant.account),
        ),
      },
    );
    const feed = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(tables.clientStateFeed.userId, f.applicant.id),
        eq(tables.clientStateFeed.account, f.group.account),
        eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    const head = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.accountId, f.owner.id),
        eq(tables.accountThreadState.threadId, f.group.threadId),
      ),
    });
    return {
      pair,
      intents,
      roster,
      participant,
      audience,
      projection,
      feed,
      head,
    };
  }

  it('accepts a pending source application when the roster is stale but the pair is inactive', async () => {
    const f = await fixture();
    const [{ nextFeedId }] = (
      await database.pool.query<{ nextFeedId: number }>(
        `SELECT COALESCE(max("feedId"), 0) + 100 AS "nextFeedId"
         FROM "GroupMetaMemberFeed" WHERE "threadId" = $1`,
        [f.group.threadId],
      )
    ).rows;
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId: f.group.threadId,
      feedId: nextFeedId,
      memberAccount: f.applicant.account,
      profileNamespaceId: 0,
      operation: 'MEMBER_UPSERT',
      body: { role: 'MEMBER', profileRev: 1 },
    });
    expect((await state(f)).roster).toMatchObject({ role: 'MEMBER' });
    expect((await state(f)).pair?.active).toBe(false);

    expect(await authoredIntents.execute(f.params)).toMatchObject({
      status: 'APPLIED',
    });
    expect((await state(f)).pair?.active).toBe(true);
    const joined = (
      await database.pool.query<{ content: { type: string } }>(
        `SELECT content FROM "Message" WHERE "threadId" = $1
         AND "contentType" = 'SYSTEM' ORDER BY seq DESC LIMIT 1`,
        [f.group.threadId],
      )
    ).rows[0];
    expect(joined.content.type).toBe('GROUP_JOINED');
  });

  it('rejects an inactive source application without a departure even when the roster is stale', async () => {
    const f = await fixture();
    const [{ nextFeedId }] = (
      await database.pool.query<{ nextFeedId: number }>(
        `SELECT COALESCE(max("feedId"), 0) + 100 AS "nextFeedId"
         FROM "GroupMetaMemberFeed" WHERE "threadId" = $1`,
        [f.group.threadId],
      )
    ).rows;
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId: f.group.threadId,
      feedId: nextFeedId,
      memberAccount: f.applicant.account,
      profileNamespaceId: 0,
      operation: 'MEMBER_UPSERT',
      body: { role: 'MEMBER', profileRev: 1 },
    });
    const before = (
      await database.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM "Message"
         WHERE "threadId" = $1 AND "contentType" = 'SYSTEM'`,
        [f.group.threadId],
      )
    ).rows[0].count;

    expect(
      await authoredIntents.execute({ ...f.params, decision: 'REVOKED' }),
    ).toMatchObject({ status: 'APPLIED' });
    expect((await state(f)).pair?.active).toBe(false);
    const after = (
      await database.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM "Message"
         WHERE "threadId" = $1 AND "contentType" = 'SYSTEM'`,
        [f.group.threadId],
      )
    ).rows[0].count;
    expect(after).toBe(before);
    expect((await state(f)).roster).toMatchObject({ role: 'MEMBER' });
  });

  function rosteredMember(threadId: number, userId: number) {
    return database.db.transaction((tx) =>
      readCurrentGroupMemberInTx(tx, threadId, userId),
    );
  }

  async function dissolveGroup(groupAccount: string): Promise<void> {
    await database.db
      .update(tables.groupAccount)
      .set({ dissolvedAt: new Date() })
      .where(eq(tables.groupAccount.account, groupAccount));
  }

  /** Seeds accepted group-member pairs so the authorization set reaches its size. */
  async function fillAuthorizedPairs(
    groupAccount: string,
    threadId: number,
    count: number,
  ): Promise<void> {
    await database.db.execute(sql`
      WITH inserted AS (
        INSERT INTO "RelationshipPair" (kind, "endpointAType", "endpointAAccount",
          "endpointANamespaceId", "endpointBType", "endpointBAccount",
          "endpointBNamespaceId", "threadId")
        SELECT 'GROUP_MEMBER', 'GROUP', ${groupAccount}, 0, 'USER', 'capacity-' || i, 0, ${threadId}
        FROM generate_series(1, ${count}) i
        RETURNING "endpointBAccount"
      )
      INSERT INTO "RelationshipIntent"
        ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
         status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq", "requestedAt", "updatedAt")
      SELECT ${groupAccount}, 0, "endpointBAccount", 0, 'ACCEPTED', 0, 0, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM inserted
    `);
  }

  it('preserves acceptance and rejection effects', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    for (const decision of ['ACCEPTED', 'REVOKED'] as const) {
      const f = await fixture();
      const locks = vi.spyOn(
        RelationshipIntentService.prototype,
        'lockGroupMutationInTx',
      );
      await runDecision({
        ...f.params,
        decision,
      });
      expect(locks).toHaveBeenCalledTimes(0);
      const result = await state(f);
      expect(result.pair?.active).toBe(decision === 'ACCEPTED');
      expect(
        result.intents
          .map((intent) => [intent.authorAccount, intent.status])
          .sort(),
      ).toEqual(
        [
          [f.group.account, decision],
          [f.applicant.account, 'REQUESTED'],
        ].sort(),
      );
      expect(result.projection).toMatchObject({
        direction: 'APPLICATION',
        status: decision === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
      });
      expect(result.feed?.body).toMatchObject({
        status: decision,
        note: decision === 'ACCEPTED' ? 'please' : '',
      });
      if (decision === 'REVOKED')
        expect(result.feed?.body).toMatchObject({
          requestStatus: 'REJECTED',
          requestDirection: 'OUTGOING',
        });
      if (decision === 'ACCEPTED') {
        expect(result.roster).toMatchObject({
          role: 'MEMBER',
          profileRev: 1,
        });
        expect(result.participant).toMatchObject({
          role: 'MEMBER',
          messageVisibleThroughSeq: null,
        });
        expect(result.audience).toBeDefined();
      } else {
        expect(result.roster).toBeUndefined();
        expect(result.participant).toBeUndefined();
        expect(result.audience).toBeUndefined();
      }
      locks.mockRestore();
    }
  });

  it.each([
    { history: true, existingFloor: null },
    { history: false, existingFloor: null },
    { history: false, existingFloor: 2 },
  ] as const)(
    'activates a federated applicant (history=$history, existingFloor=$existingFloor)',
    async ({ history, existingFloor }) => {
      const notifications: Array<{ namespaceIds: number[] }> = [];
      vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockImplementation(
        async (namespaceIds) => {
          notifications.push({ namespaceIds: [...namespaceIds] });
        },
      );
      const prefix = `join-remote-${++sequence}`;
      const owner = await seedUser(app, `${prefix}-owner`);
      const created = await services.groups.createNewGroup({
        owner: owner.id,
        name: 'Remote applicant',
      });
      const createdThread = await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, created.threadId),
      });
      const group = {
        ...created,
        account: createdThread!.groupAccount!,
        domain: createdThread!.groupDomain!,
      };
      const domain = `${prefix}.test`;
      const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
      const member = { account: `${prefix}-member`, domain, namespaceId };
      await database.db
        .update(tables.messageThread)
        .set({ curSeq: 3 })
        .where(eq(tables.messageThread.id, group.threadId));
      if (!history)
        await database.db
          .insert(tables.systemSetting)
          .values({
            key: FEDERATION_HISTORY_ACCESS_SETTING_KEY,
            value: 'false',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: tables.systemSetting.key,
            set: { value: 'false' },
          });
      if (existingFloor !== null)
        await database.db.insert(tables.threadAudience).values({
          threadId: group.threadId,
          targetDomain: domain,
          targetNamespaceId: namespaceId,
          localUserId: null,
          groupMetaVisibleAfter: 0,
          messageAccessAfterSeq: existingFloor,
        });

      await database.db.insert(tables.profileTable).values({
        account: member.account,
        publisherNamespaceId: member.namespaceId,
        profileNamespaceId: member.namespaceId,
        profileRev: 7,
        displayName: 'Remote member',
        avatar: '',
        bio: '',
      });
      await database.db.transaction(async (tx) => {
        await mintGroupMemberPairInTx(tx, {
          threadId: group.threadId,
          groupAccount: group.account,
          groupNamespaceId: 0,
          memberAccount: member.account,
          profileNamespaceId: namespaceId,
        });
        await tx.insert(tables.relationshipIntent).values({
          authorAccount: member.account,
          authorNamespaceId: namespaceId,
          profileNamespaceId: namespaceId,
          receiverAccount: group.account,
          receiverNamespaceId: 0,
          status: 'REQUESTED',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          profileRev: 7,
          note: 'remote application',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        await services.mutations.writeGroupRequestEffectsInTx(
          tx,
          group.threadId,
          group.threadId,
          member,
          [],
          'REQUESTED',
          'APPLICATION',
          true,
        );
      });
      const { _pair } = await findGroupRelationship(
        database.db,
        group.threadId,
        member,
      );
      const _request = await database.db.query.relationshipIntent.findFirst({
        where: memberDirection(group.account, member.account, namespaceId),
      });
      const locks = vi.spyOn(
        RelationshipIntentService.prototype,
        'lockGroupMutationInTx',
      );
      notifications.length = 0;
      await runDecision({
        threadId: group.threadId,
        managerUserId: owner.id,
        target: member,
        scope: 'APPLICATION',
        decision: 'ACCEPTED',
      });
      expect(notifications).toEqual([{ namespaceIds: [namespaceId] }]);
      expect(locks).toHaveBeenCalledTimes(0);
      const roster = await database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, group.threadId, member),
      );
      expect(roster).toMatchObject({
        domain,
        namespaceId,
        role: 'MEMBER',
        profileRev: 7,
      });
      const audience = await database.db.query.threadAudience.findFirst({
        where: and(
          eq(tables.threadAudience.threadId, group.threadId),
          eq(tables.threadAudience.targetNamespaceId, namespaceId),
        ),
      });
      expect(audience?.messageAccessAfterSeq).toBe(
        existingFloor ?? (history ? 0 : 3),
      );
      const relationship = await database.db.query.peerStateFeed.findFirst({
        where: and(
          eq(tables.peerStateFeed.namespaceId, namespaceId),
          eq(tables.peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
          eq(tables.peerStateFeed.subjectAccount, member.account),
        ),
      });
      expect(relationship?.body).toMatchObject({
        status: 'ACCEPTED',
        note: 'remote application',
        profileRev: 1,
      });
      const head = await database.db.query.peerStateFeed.findFirst({
        where: and(
          eq(tables.peerStateFeed.namespaceId, namespaceId),
          eq(tables.peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
        ),
      });
      expect(head).toBeDefined();
    },
  );

  it('initializes a retained local read state without hiding history', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    for (const blocked of [false, true]) {
      const f = await fixture();
      await database.db.transaction(async (tx) => {
        await tx
          .delete(tables.message)
          .where(eq(tables.message.threadId, f.group.threadId));
        await tx
          .update(tables.messageThread)
          .set({ curSeq: 3 })
          .where(eq(tables.messageThread.id, f.group.threadId));
        await tx.insert(tables.message).values(
          withMessageDigest(
            [1, 2, 3].map((seq) => ({
              threadId: f.group.threadId,
              seq,
              creatorAccount: f.owner.account,
              contentType: 'PURE_TEXT' as const,
              content: JSON.stringify({ text: `old message ${seq}` }),
              updatedAt: new Date(),
            })),
          ),
        );
        await tx.insert(tables.accountThreadState).values({
          accountId: f.applicant.id,
          threadId: f.group.threadId,
          role: 'ADMIN',
          lastReadSeq: 1,
          messageEndSeq: 2,
          unreadCount: blocked ? 0 : 1,
          previewSeqs: [2],
          lastMentionSeq: 2,
          messageVisibleThroughSeq: 2,
          blocked,
          muted: true,
          alias: 'keep alias',
        });
      });
      await runDecision(f.params);
      const result = await state(f);
      expect(result.participant).toMatchObject({
        role: 'MEMBER',
        lastReadSeq: 3,
        unreadCount: 0,
        previewSeqs: [],
        lastMentionSeq: null,
        messageVisibleThroughSeq: null,
        blocked,
        muted: true,
        alias: 'keep alias',
        messageEndSeq: 2,
      });
      const threadState = (
        await app.get(ThreadFeedService).queryThreadFeedDelta(f.applicant.id, {
          after: 0,
        })
      ).items.find((item) => item.threadId === f.group.threadId);
      expect(threadState).toMatchObject({
        conversationState: 'ACTIVE',
        role: 'MEMBER',
        blocked,
        profileAccount: f.group.account,
        profileRev: 1,
      });
      expect(threadState?.profileRev).toBe(
        result.intents.find(
          (intent) => intent.authorAccount === f.group.account,
        )?.profileRev,
      );
      expect(result.feed?.body).toMatchObject({ established: true });
      expect(
        await database.db.query.message.findMany({
          where: eq(tables.message.threadId, f.group.threadId),
        }),
      ).toHaveLength(4);
    }
  });

  it('advances manager projection and profile heads without losing read watermarks', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    const before = await state(f);
    await database.db.transaction(async (tx) => {
      await tx
        .update(tables.accountThreadState)
        .set({
          joinRequestEndFeedId: before.projection!.feedId,
          joinRequestReadFeedId: before.projection!.feedId,
        })
        .where(
          and(
            eq(tables.accountThreadState.accountId, f.owner.id),
            eq(tables.accountThreadState.threadId, f.group.threadId),
          ),
        );
      await tx.insert(tables.profileTable).values({
        account: f.applicant.account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 2,
        displayName: 'Updated profile',
        avatar: '',
        bio: 'updated',
      });
      await tx
        .update(tables.account)
        .set({ defaultProfileRev: 2 })
        .where(eq(tables.account.id, f.applicant.id));
      await tx.insert(tables.profileTable).values({
        account: f.group.account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 2,
        displayName: 'Updated group',
        avatar: '',
        bio: '',
      });
      await tx
        .update(tables.groupAccount)
        .set({ defaultProfileRev: 2 })
        .where(eq(tables.groupAccount.account, f.group.account));
    });
    const seeded = await state(f);
    const seededProfile = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(tables.clientStateFeed.userId, f.owner.id),
        eq(tables.clientStateFeed.eventType, 'PROFILE'),
        eq(tables.clientStateFeed.account, f.applicant.account),
      ),
    });
    await runDecision(f.params);
    const after = await state(f);
    // Membership refers to the applicant-authored revision, not its newer default profile.
    expect(after.roster?.profileRev).toBe(1);
    // The projection keeps the request-time fields written at application time.
    expect(after.projection).toMatchObject({
      status: 'ACCEPTED',
      memberProfileRev: 1,
      note: 'please',
    });
    const profile = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(tables.clientStateFeed.userId, f.owner.id),
        eq(tables.clientStateFeed.eventType, 'PROFILE'),
        eq(tables.clientStateFeed.account, f.applicant.account),
      ),
    });
    const head = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.accountId, f.owner.id),
        eq(tables.accountThreadState.threadId, f.group.threadId),
      ),
    });
    expect(head).toMatchObject({
      joinRequestEndFeedId: after.projection!.feedId,
      joinRequestReadFeedId: before.projection!.feedId,
    });
    // Acceptance does not refresh the manager's profile entry and leaves the
    // projection row's feed position untouched.
    expect(profile).toEqual(seededProfile);
    expect(after.projection!.feedId).toBe(before.projection!.feedId);
    // Acceptance leaves the manager's thread-head watermarks untouched.
    expect(after.head).toMatchObject({
      joinRequestEndFeedId: seeded.head!.joinRequestEndFeedId,
      joinRequestReadFeedId: seeded.head!.joinRequestReadFeedId,
    });
    const metaProfile = await database.db.query.groupMeta.findFirst({
      where: eq(tables.groupMeta.threadId, f.group.threadId),
    });
    expect(metaProfile?.profileRev).toBe(2);
  });

  it('serializes two approvals without duplicating membership', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      authoredIntents.execute(f.params),
      authoredIntents.execute(f.params),
    ]);
    expect(outcomes.every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    const rejected = outcomes.find(
      (result) =>
        result.status === 'fulfilled' && result.value.status === 'REJECTED',
    );
    expect(rejected).toMatchObject({
      value: { status: 'REJECTED', code: BusinessCode.INVITE_EXPIRED },
    });
    const result = await state(f);
    expect(result.pair?.active).toBe(true);
    expect(result.projection).toMatchObject({
      direction: 'APPLICATION',
      status: 'ACCEPTED',
    });
    const joins = await database.db.query.groupMetaMemberFeed.findMany({
      where: and(
        eq(tables.groupMetaMemberFeed.threadId, f.group.threadId),
        eq(tables.groupMetaMemberFeed.memberAccount, f.applicant.account),
      ),
    });
    expect(joins).toHaveLength(1);
  });

  it('rejects an unauthorized manager and an expired request without changing membership', async () => {
    const f = await fixture();
    await expect(
      authoredIntents.execute({
        ...f.params,
        managerUserId: f.applicant.id,
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
    await database.db
      .update(tables.relationshipIntent)
      .set({ requestedAt: new Date(0), expiresAt: new Date(1) })
      .where(f.requestDirection);
    await expect(authoredIntents.execute(f.params)).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.INVITE_EXPIRED,
    });
    expect((await state(f)).pair?.active).toBe(false);
  });

  it('acquires the group then the pair business lock once before row locks', async () => {
    const f = await fixture();
    businessLocks.length = 0;
    await authoredIntents.execute(f.params);
    const scope = pairScope(f.pair);
    expect(businessLocks).toEqual([
      businessAccountScopeKey({
        account: f.group.account,
        profileNamespaceId: 0,
      }),
      relationshipPairBusinessKey(scope),
    ]);
    const [addressA, addressB] = scope.addresses;
    const reversed: PairAddressScope = {
      kind: scope.kind,
      addresses: [addressB, addressA],
    };
    expect(relationshipPairBusinessKey(reversed)).toBe(
      relationshipPairBusinessKey(scope),
    );
  });

  it('waits for a competing pair business lock before applying the ACK', async () => {
    const f = await fixture();
    const ready = deferred();
    const release = deferred();
    let blockerPid = 0;
    const blocker = database.db.transaction(async (tx) => {
      await lockRelationshipPairsInTx(tx, [pairScope(f.pair)]);
      blockerPid = (
        await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      ).rows[0].pid;
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const result = authoredIntents.execute(f.params).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(async () => {
        const waiting = await database.pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [blockerPid],
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      expect((await state(f)).pair?.active).toBe(false);
    } finally {
      release.resolve();
      await blocker;
    }
    expect(await result).toBeUndefined();
    expect((await state(f)).pair?.active).toBe(true);
  });

  it('merges pending thread fan-out work instead of superseding it', async () => {
    const f = await fixture();
    const scope = JSON.stringify(['THREAD_FANOUT', f.group.threadId]);
    await database.db.transaction(async (tx) => {
      await insertPendingTaskInTx(tx, {
        kind: 'PROJECTION',
        scopeType: 'THREAD',
        scopeKey: scope,
        taskType: 'FAN_OUT_THREAD_CONTENT',
        payload: {
          threadId: f.group.threadId,
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
        },
        coalescingKey: scope,
      });
    });
    const pending = await database.db.query.durableTask.findFirst({
      where: and(
        eq(tables.durableTask.scopeKey, scope),
        eq(tables.durableTask.status, 'PENDING'),
      ),
    });
    await authoredIntents.execute(f.params);
    const after = await database.db.query.durableTask.findMany();
    // Group creation may already have admitted both channels. Acceptance
    // advances their pending payloads to the new system-message boundary.
    const federationScope = JSON.stringify([
      'FEDERATION_THREAD_FANOUT',
      f.group.threadId,
    ]);
    const [message] = (
      await database.pool.query(
        'SELECT max(seq) AS seq FROM "Message" WHERE "threadId" = $1',
        [f.group.threadId],
      )
    ).rows;
    expect(after.find((task) => task.id === pending!.id)).toMatchObject({
      status: 'PENDING',
      payload: {
        threadId: f.group.threadId,
        messageEndSeq: Number(message.seq),
      },
    });
    expect(
      after.find((task) => task.scopeKey === federationScope),
    ).toMatchObject({
      status: 'PENDING',
      taskType: 'FAN_OUT_FEDERATION_THREAD_CONTENT',
      payload: {
        threadId: f.group.threadId,
        messageEndSeq: Number(message.seq),
      },
    });
  });

  it('rejects a pending application without admitting any fan-out', async () => {
    const f = await fixture();
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const before = await database.db.query.durableTask.findMany();
    const messagesBefore = await database.db.query.message.findMany();
    await authoredIntents.execute({ ...f.params, decision: 'REVOKED' });
    expect(await database.db.query.durableTask.findMany()).toEqual(before);
    expect(await database.db.query.message.findMany()).toEqual(messagesBefore);
  });

  it('acceptance admits both thread fan-out channels', async () => {
    const f = await fixture();
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    await authoredIntents.execute(f.params);
    const after = await database.db.query.durableTask.findMany();
    const scopes = new Set([
      JSON.stringify(['FEDERATION_THREAD_FANOUT', f.group.threadId]),
      JSON.stringify(['THREAD_FANOUT', f.group.threadId]),
    ]);
    const admitted = after.filter((task) => scopes.has(task.scopeKey));
    expect(admitted.map((task) => task.taskType).sort()).toEqual([
      'FAN_OUT_FEDERATION_THREAD_CONTENT',
      'FAN_OUT_THREAD_CONTENT',
    ]);
    expect(admitted.every((task) => task.scopeType === 'THREAD')).toBe(true);
    const [message] = (
      await database.pool.query(
        `SELECT seq, content FROM "Message" WHERE "threadId" = $1
           ORDER BY seq DESC LIMIT 1`,
        [f.group.threadId],
      )
    ).rows;
    expect(message.content).toMatchObject({ type: 'GROUP_JOINED' });
    for (const task of admitted) {
      expect(task.payload).toMatchObject({
        threadId: f.group.threadId,
        messageEndSeq: Number(message.seq),
      });
      expect(task.checkpoint).toEqual({});
    }
    // The new member's row publishes the canonical Meta coordinate immediately.
    const participant = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, f.group.threadId),
        eq(tables.accountThreadState.accountId, f.applicant.id),
      ),
    });
    const [meta] = (
      await database.pool.query(
        'SELECT "metaEndId"::text FROM "GroupMeta" WHERE "threadId" = $1',
        [f.group.threadId],
      )
    ).rows;
    expect(participant?.groupMetaFeedEndId).toBe(Number(meta.metaEndId));
    const [profileFact] = (
      await database.pool.query(
        `SELECT "feedId", (body ->> 'profileRev')::integer AS rev
           FROM "GroupMetaMemberFeed"
           WHERE "threadId" = $1 AND operation = 'GROUP_PROFILE'`,
        [f.group.threadId],
      )
    ).rows;
    expect(participant?.threadProfileRev).toBe(profileFact.rev);
    expect(participant?.profileSourceId).toBe(profileFact.feedId);
  });

  it('syncs the manager watermark once and never regresses it', async () => {
    const f = await fixture();
    // An invitation gives the second direction its own event, so the sync must
    // publish both streams onto their own columns instead of their sum.
    const invitee = await seedUser(app, `join-${f.owner.id}-invitee`);
    await database.db.transaction(async (tx) => {
      await lockGroupScopeInTx(tx, f.group.threadId);
      await services.mutations.writeGroupRelationshipIntentInTx(
        tx,
        f.group.threadId,
        invitee.id,
        'join us',
        'REQUESTED',
        [],
        'INVITATION',
      );
    });
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
    const key = groupMembershipProjectionFanoutKey(f.group.threadId);
    await database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: f.group.account, profileNamespaceId: 0 },
      ]);
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId: f.group.threadId,
        groupAccount: f.group.account,
      });
    });
    const [task] = await database.db.query.durableTask.findMany({
      where: eq(tables.durableTask.coalescingKey, key),
    });
    await database.db
      .update(tables.durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(eq(tables.durableTask.id, task.id));
    const ownerBefore = await database.db.query.account.findFirst({
      where: eq(tables.account.id, f.owner.id),
      columns: { threadFeedEndId: true, clientStateFeedEndId: true },
    });
    const execution = app.get(GroupMembershipProjectionFanoutService);
    await execution.execute(task, { threadId: f.group.threadId });
    const ownerAfter = await database.db.query.account.findFirst({
      where: eq(tables.account.id, f.owner.id),
      columns: { threadFeedEndId: true, clientStateFeedEndId: true },
    });
    expect(ownerAfter?.threadFeedEndId).toBe(ownerBefore!.threadFeedEndId + 1);
    expect(ownerAfter?.clientStateFeedEndId).toBe(
      ownerBefore!.clientStateFeedEndId,
    );
    // One post-commit notification carries the updated thread head.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual([
      expect.objectContaining({ userId: f.owner.id }),
    ]);
    const [counter] = await database.db
      .select({
        applicationEndId: tables.groupMeta.applicationEndId,
        invitationEndId: tables.groupMeta.invitationEndId,
      })
      .from(tables.groupMeta)
      .where(eq(tables.groupMeta.threadId, f.group.threadId));
    const managerState = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, f.group.threadId),
        eq(tables.accountThreadState.accountId, f.owner.id),
      ),
    });
    expect(managerState?.joinRequestEndFeedId).toBe(counter.applicationEndId);
    expect(managerState?.groupInviteEndFeedId).toBe(counter.invitationEndId);
    expect(managerState?.joinRequestReadFeedId).toBe(0);

    // A second pass from the committed checkpoint finds no remaining manager.
    await execution.execute(task, { threadId: f.group.threadId });
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(tables.durableTask.id, task.id),
          columns: { checkpoint: true },
        })
      )?.checkpoint,
    ).toEqual({ afterManagerId: String(f.owner.id) });

    // GC deletions and stale reads must not move a published watermark back.
    await database.db
      .update(tables.accountThreadState)
      .set({ joinRequestEndFeedId: 999_999, groupInviteEndFeedId: 999_999 })
      .where(eq(tables.accountThreadState.id, managerState!.id));
    await database.db
      .update(tables.durableTask)
      .set({ checkpoint: { afterManagerId: '0' } })
      .where(eq(tables.durableTask.id, task.id));
    await execution.execute(task, { threadId: f.group.threadId });
    const [regressed] = await database.db.query.accountThreadState.findMany({
      where: eq(tables.accountThreadState.id, managerState!.id),
    });
    expect(regressed?.joinRequestEndFeedId).toBe(999_999);
    expect(regressed?.groupInviteEndFeedId).toBe(999_999);
  });

  it('numbers applications and invitations independently', async () => {
    const f = await fixture();
    const counterBefore = await database.db.query.groupMeta.findFirst({
      where: eq(tables.groupMeta.threadId, f.group.threadId),
    });
    const applicationBefore =
      await database.db.query.groupRequestProjection.findFirst({
        where: and(
          eq(tables.groupRequestProjection.threadId, f.group.threadId),
          eq(tables.groupRequestProjection.direction, 'APPLICATION'),
        ),
      });
    // Inviting a fresh user stays REQUESTED; inviting the pending applicant
    // would auto-accept into membership instead of projecting an invitation.
    const invitee = await seedUser(app, `join-${f.owner.id}-invitee`);
    await database.db.transaction(async (tx) => {
      await lockGroupScopeInTx(tx, f.group.threadId);
      await services.mutations.writeGroupRelationshipIntentInTx(
        tx,
        f.group.threadId,
        invitee.id,
        'join us',
        'REQUESTED',
        [],
        'INVITATION',
      );
    });
    const rows = await database.db.query.groupRequestProjection.findMany({
      where: eq(tables.groupRequestProjection.threadId, f.group.threadId),
    });
    // The invitation advances only its own counter; the application retains
    // its prior feed position even when group creation used earlier numbers.
    const feedIds = Object.fromEntries(
      rows.map((row) => [row.direction, row.feedId]),
    );
    const counterAfter = await database.db.query.groupMeta.findFirst({
      where: eq(tables.groupMeta.threadId, f.group.threadId),
    });
    expect(feedIds.APPLICATION).toBe(applicationBefore!.feedId);
    expect(feedIds.INVITATION).toBe(counterBefore!.invitationEndId + 1);
    expect(counterAfter?.applicationEndId).toBe(
      counterBefore!.applicationEndId,
    );
    expect(counterAfter?.invitationEndId).toBe(
      counterBefore!.invitationEndId + 1,
    );
  });

  it('replaces pending join-request work while preserving a worker claim', async () => {
    const f = await fixture();
    const key = groupMembershipProjectionFanoutKey(f.group.threadId);
    const admit = () =>
      database.db.transaction(async (tx) => {
        await lockBusinessAccountsInTx(tx, [
          { account: f.group.account, profileNamespaceId: 0 },
        ]);
        await admitGroupMembershipProjectionFanoutInTx(tx, {
          threadId: f.group.threadId,
          groupAccount: f.group.account,
        });
      });
    await admit();
    const [first] = await database.db.query.durableTask.findMany({
      where: and(
        eq(tables.durableTask.coalescingKey, key),
        eq(tables.durableTask.status, 'PENDING'),
      ),
    });
    await admit();
    const tasks = await database.db.query.durableTask.findMany({
      where: eq(tables.durableTask.coalescingKey, key),
    });
    expect(tasks.find((task) => task.id === first.id)?.status).toBe(
      'SUPERSEDED',
    );
    expect(tasks.filter((task) => task.status === 'PENDING')).toHaveLength(1);

    const [second] = await database.db.query.durableTask.findMany({
      where: and(
        eq(tables.durableTask.coalescingKey, key),
        eq(tables.durableTask.status, 'PENDING'),
      ),
    });
    await database.db
      .update(tables.durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(eq(tables.durableTask.id, second.id));
    await admit();
    const after = await database.db.query.durableTask.findMany({
      where: eq(tables.durableTask.coalescingKey, key),
    });
    expect(after.find((task) => task.id === second.id)).toMatchObject({
      status: 'PROCESSING',
    });
    expect(after.filter((task) => task.status === 'PENDING')).toHaveLength(1);
  });

  it('preserves a concurrent worker claim and admits one pending successor', async () => {
    const f = await fixture();
    const scope = JSON.stringify(['THREAD_FANOUT', f.group.threadId]);
    await database.db.transaction(async (tx) => {
      await insertPendingTaskInTx(tx, {
        kind: 'PROJECTION',
        scopeType: 'THREAD',
        scopeKey: scope,
        taskType: 'FAN_OUT_THREAD_CONTENT',
        payload: {
          threadId: f.group.threadId,
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
        },
        coalescingKey: scope,
      });
    });
    const pending = await database.db.query.durableTask.findFirst({
      where: and(
        eq(tables.durableTask.scopeKey, scope),
        eq(tables.durableTask.status, 'PENDING'),
      ),
    });
    const ready = deferred();
    const release = deferred();
    let blockerPid = 0;
    const claim = database.db.transaction(async (tx) => {
      blockerPid = (
        await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      ).rows[0].pid;
      await tx
        .update(tables.durableTask)
        .set({
          status: 'PROCESSING',
          startedAt: sql`clock_timestamp()`,
          checkpoint: { phase: 'FEED', afterAccountId: 7 },
        })
        .where(eq(tables.durableTask.id, pending!.id));
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const outcome = authoredIntents.execute(f.params).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(async () => {
        const waiting = await database.pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [blockerPid],
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
    } finally {
      release.resolve();
      await claim;
    }
    expect(await outcome).toBeUndefined();
    const tasks = await database.db.query.durableTask.findMany({
      where: eq(tables.durableTask.scopeKey, scope),
    });
    expect(tasks.find((task) => task.id === pending!.id)).toMatchObject({
      status: 'PROCESSING',
      checkpoint: { phase: 'FEED', afterAccountId: 7 },
    });
    expect(tasks.filter((task) => task.status === 'PENDING')).toHaveLength(1);
    const successor = tasks.find((task) => task.status === 'PENDING');
    expect(successor?.taskType).toBe('FAN_OUT_THREAD_CONTENT');
    expect(successor?.checkpoint).toEqual({});
  });

  it('rolls back relationship, roster, feeds and tasks on a late failure and permits retry', async () => {
    const f = await fixture();
    const before = await state(f);
    const tasksBefore = await database.db.query.durableTask.findMany();
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
    await expect(authoredIntents.execute(f.params)).rejects.toThrow(
      'late failure',
    );
    expect(await state(f)).toEqual(before);
    expect(await database.db.query.durableTask.findMany()).toEqual(tasksBefore);
    expect(notify).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    failure.mockRestore();
    await authoredIntents.execute(f.params);
    expect((await state(f)).pair?.active).toBe(true);
  });

  it.each(['withdraw', 'revoke-manager', 'dissolve'] as const)(
    'revalidates after waiting for concurrent %s',
    async (operation) => {
      const f = await fixture();
      const ready = deferred();
      const release = deferred();
      let blockerPid = 0;
      const blocker = database.db.transaction(
        async (tx: DatabaseTransaction) => {
          await lockBusinessAccountsInTx(tx, [
            { account: f.group.account, profileNamespaceId: 0 },
          ]);
          blockerPid = (
            await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            )
          ).rows[0].pid;
          ready.resolve();
          await release.promise;
          if (operation === 'withdraw') {
            await services.mutations.writeMemberRelationshipIntentInTx(
              tx,
              f.group.threadId,
              f.applicant.id,
              'REVOKED',
              [],
            );
          } else if (operation === 'revoke-manager') {
            // Follow the real writer's group lock protocol; removing mutual authorization is sufficient.
            const { pair: ownerPair } = await findGroupRelationship(
              tx,
              f.group.threadId,
              f.owner.id,
            );
            await tx
              .update(tables.relationshipPair)
              .set({ active: false })
              .where(eq(tables.relationshipPair.id, ownerPair!.id));
          } else {
            await tx
              .update(tables.groupAccount)
              .set({ dissolvedAt: new Date() })
              .where(eq(tables.groupAccount.account, f.group.account));
          }
        },
      );
      await ready.promise;
      const outcome = authoredIntents.execute(f.params);
      try {
        await vi.waitFor(async () => {
          const waiting = await database.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [blockerPid],
          );
          expect(waiting.rowCount).toBeGreaterThan(0);
        });
      } finally {
        release.resolve();
        await blocker;
      }
      const result = await outcome;
      if (operation === 'withdraw')
        expect(result).toMatchObject({
          status: 'NO_OP',
          reason: 'ALREADY_REVOKED',
        });
      else if (operation === 'revoke-manager')
        expect(result).toMatchObject({
          status: 'REJECTED',
          code: BusinessCode.GROUP_FORBIDDEN,
        });
      else
        expect(result).toMatchObject({
          status: 'REJECTED',
          code: BusinessCode.GROUP_DISSOLVED,
        });
      expect((await state(f)).pair?.active).toBe(false);
    },
  );

  it('unified revocation kicks a rostered local member with the full membership effect set', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    await authoredIntents.execute({ ...f.params, decision: 'ACCEPTED' });
    expect((await state(f)).pair?.active).toBe(true);
    await authoredIntents.execute({
      ...f.params,
      decision: 'REVOKED',
      scope: 'MEMBER',
    });
    const after = await state(f);
    expect(after.pair?.active).toBe(false);
    expect(after.roster).toBeUndefined();
    expect(after.audience).toBeUndefined();
    // The relationship intent is revoked, while the already accepted request
    // projection remains accepted as historical request state.
    expect(after.projection).toMatchObject({ status: 'ACCEPTED' });
    expect(after.feed?.body).toMatchObject({
      status: 'REVOKED',
      // The kicked member's pair was established before; only a rejected
      // applicant (never activated) reads established false.
      established: true,
    });
    // GROUP_LEFT pins the kicked member's read watermark and carries the identity.
    const [message] = (
      await database.pool.query(
        `SELECT m.seq, m.content FROM "Message" m WHERE m."threadId" = $1
           AND m."contentType" = 'SYSTEM' ORDER BY m.id DESC LIMIT 1`,
        [f.group.threadId],
      )
    ).rows;
    expect(message.content).toMatchObject({
      type: 'GROUP_LEFT',
      member: {
        account: f.applicant.account,
      },
    });
    const { rows: watermark } = await database.pool.query(
      `SELECT "messageVisibleThroughSeq" FROM "AccountThreadState"
        WHERE "threadId" = $1 AND "accountId" = $2`,
      [f.group.threadId, f.applicant.id],
    );
    expect(Number(watermark[0].messageVisibleThroughSeq)).toBe(message.seq);
    // The roster's last fact is the departure.
    const [lastFact] = (
      await database.pool.query(
        `SELECT operation FROM "GroupMetaMemberFeed" WHERE "threadId" = $1
           AND "memberAccount" = $2 ORDER BY "feedId" DESC LIMIT 1`,
        [f.group.threadId, f.applicant.account],
      )
    ).rows;
    expect(lastFact.operation).toBe('MEMBER_DEPART');
    // The departure admits both thread fan-out channels.
    const fanoutTasks = (
      await database.pool.query(
        `SELECT "taskType" FROM "DurableTask" WHERE status = 'PENDING'
           AND "scopeType" = 'THREAD' AND "scopeKey" = ANY($1::text[])`,
        [
          [
            JSON.stringify(['THREAD_FANOUT', f.group.threadId]),
            JSON.stringify(['FEDERATION_THREAD_FANOUT', f.group.threadId]),
          ],
        ],
      )
    ).rows;
    expect(
      fanoutTasks.map((task: { taskType: string }) => task.taskType).sort(),
    ).toEqual(['FAN_OUT_FEDERATION_THREAD_CONTENT', 'FAN_OUT_THREAD_CONTENT']);
    expect(
      (
        await database.pool.query(
          `SELECT 1 FROM "DurableTask" WHERE status = 'PENDING'
            AND "taskType" = 'FAN_OUT_THREAD_CONTENT' AND "scopeKey" = $1`,
          [JSON.stringify(['THREAD_FANOUT', f.group.threadId])],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await database.pool.query(
          `SELECT 1 FROM "DurableTask" WHERE status = 'PENDING'
            AND "taskType" = 'FAN_OUT_ACCOUNT_THREAD_CONTENT' AND "scopeKey" = $1`,
          [
            JSON.stringify([
              'ACCOUNT_THREAD_FANOUT',
              f.group.threadId,
              f.applicant.id,
            ]),
          ],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('unified revocation kicks a rostered remote member through the peer feed', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const prefix = `join-kick-remote-${++sequence}`;
    const owner = await seedUser(app, `${prefix}-owner`);
    const created = await services.groups.createNewGroup({
      owner: owner.id,
      name: 'Remote kick',
    });
    const kickThread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, created.threadId),
    });
    const group = {
      ...created,
      account: kickThread!.groupAccount!,
      domain: kickThread!.groupDomain!,
    };
    const domain = `${prefix}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const member = { account: `${prefix}-member`, domain, namespaceId };
    await database.db.insert(tables.profileTable).values({
      account: member.account,
      publisherNamespaceId: member.namespaceId,
      profileNamespaceId: member.namespaceId,
      profileRev: 5,
      displayName: 'Remote kicked',
      avatar: '',
      bio: '',
    });
    await database.db.transaction(async (tx) => {
      await mintGroupMemberPairInTx(tx, {
        threadId: group.threadId,
        groupAccount: group.account,
        groupNamespaceId: 0,
        memberAccount: member.account,
        profileNamespaceId: namespaceId,
      });
      await tx.insert(tables.relationshipIntent).values({
        authorAccount: member.account,
        authorNamespaceId: namespaceId,
        profileNamespaceId: namespaceId,
        receiverAccount: group.account,
        receiverNamespaceId: 0,
        status: 'REQUESTED',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        profileRev: 5,
        note: 'remote kick application',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await services.mutations.writeGroupRequestEffectsInTx(
        tx,
        group.threadId,
        group.threadId,
        member,
        [],
        'REQUESTED',
        'APPLICATION',
        true,
      );
    });
    const { _pair } = await findGroupRelationship(
      database.db,
      group.threadId,
      member,
    );
    const _request = await database.db.query.relationshipIntent.findFirst({
      where: memberDirection(group.account, member.account, namespaceId),
    });
    const params = {
      threadId: group.threadId,
      managerUserId: owner.id,
      target: member,
      scope: 'APPLICATION' as const,
    };
    await authoredIntents.execute({ ...params, decision: 'ACCEPTED' });
    await authoredIntents.execute({
      ...params,
      decision: 'REVOKED',
      scope: 'MEMBER',
    });
    const audience = await database.db.query.threadAudience.findFirst({
      where: and(
        eq(tables.threadAudience.threadId, group.threadId),
        eq(tables.threadAudience.targetNamespaceId, namespaceId),
      ),
    });
    expect(audience).toBeUndefined();
    const relationship = await database.db.query.peerStateFeed.findFirst({
      where: and(
        eq(tables.peerStateFeed.namespaceId, namespaceId),
        eq(tables.peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        eq(tables.peerStateFeed.subjectAccount, member.account),
      ),
    });
    expect(relationship?.body).toMatchObject({ status: 'REVOKED' });
    // Remote members get no local departure fanout.
    expect(
      (
        await database.pool.query(
          `SELECT 1 FROM "DurableTask" WHERE status = 'PENDING'
            AND "taskType" = 'FAN_OUT_ACCOUNT_THREAD_CONTENT'
            AND "scopeKey" = $1`,
          [
            JSON.stringify([
              'business-scope',
              'ACCOUNT',
              'local',
              group.account,
            ]),
          ],
        )
      ).rowCount,
    ).toBe(0);
    const [lastFact] = (
      await database.pool.query(
        `SELECT operation FROM "GroupMetaMemberFeed" WHERE "threadId" = $1
           AND "memberAccount" = $2 ORDER BY "feedId" DESC LIMIT 1`,
        [group.threadId, member.account],
      )
    ).rows;
    expect(lastFact.operation).toBe('MEMBER_DEPART');
  });

  it('unified revocation only removes members strictly below the operator role', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    // The accepted applicant becomes the administrator whose reach is under test.
    await authoredIntents.execute({
      ...f.params,
      decision: 'ACCEPTED',
    });
    await services.rosterRoles.execute({
      threadId: f.group.threadId,
      operatorUserId: f.owner.id,
      kind: 'SET_ROLE',
      target: {
        account: f.applicant.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      role: GroupRole.ADMIN,
    });
    const junior = await seedUser(app, `join-${++sequence}-junior`);
    await database.db.transaction((tx) =>
      services.mutations.writeMemberRelationshipIntentInTx(
        tx,
        f.group.threadId,
        junior.id,
        'REQUESTED',
        [],
        '',
      ),
    );
    const admin = f.applicant;
    // An administrator removes a member.
    await authoredIntents.execute({
      threadId: f.group.threadId,
      managerUserId: admin.id,
      target: {
        account: junior.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      scope: 'MEMBER',
      decision: 'REVOKED',
    });
    expect(await rosteredMember(f.group.threadId, junior.id)).toBeUndefined();
    // The owner, a peer manager, and the administrator themselves are out of reach.
    for (const target of [f.owner, admin]) {
      await expect(
        authoredIntents.execute({
          threadId: f.group.threadId,
          managerUserId: admin.id,
          target: {
            account: target.account,
            domain: localIdentityDomain(),
            namespaceId: 0,
          },
          scope: 'MEMBER',
          decision: 'REVOKED',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        code: BusinessCode.GROUP_FORBIDDEN,
      });
      expect(await rosteredMember(f.group.threadId, target.id)).toBeDefined();
    }
    // The owner still outranks the administrator.
    await authoredIntents.execute({
      threadId: f.group.threadId,
      managerUserId: f.owner.id,
      target: {
        account: admin.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      scope: 'MEMBER',
      decision: 'REVOKED',
    });
    expect(await rosteredMember(f.group.threadId, admin.id)).toBeUndefined();
  });

  it('unified revocation still rejects on a dissolved group but forbids removing members', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    // A rostered member is out of reach once the group is dissolved.
    const kicked = await fixture();
    await authoredIntents.execute({
      ...kicked.params,
      decision: 'ACCEPTED',
    });
    await dissolveGroup(kicked.group.account);
    await expect(
      authoredIntents.execute({
        ...kicked.params,
        decision: 'REVOKED',
        scope: 'MEMBER',
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_DISSOLVED,
    });
    expect(await state(kicked)).toMatchObject({ roster: expect.anything() });

    // A pending application may still be rejected there (v1 semantics).
    const rejected = await fixture();
    await dissolveGroup(rejected.group.account);
    await authoredIntents.execute({
      ...rejected.params,
      decision: 'REVOKED',
    });
    const after = await state(rejected);
    expect(
      after.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [rejected.group.account, 'REVOKED'],
        [rejected.applicant.account, 'REQUESTED'],
      ].sort(),
    );
    expect(after.roster).toBeUndefined();
    expect(after.pair?.active).toBe(false);
  });

  it('acceptance enforces the server capacity and keeps an invited slot', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    // The owner plus 998 accepted pairs reach the limit; a fresh applicant
    // would consume a new slot.
    const f = await fixture();
    await fillAuthorizedPairs(f.group.account, f.group.threadId, 998);
    await expect(authoredIntents.execute(f.params)).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FULL,
    });
    const rejected = await state(f);
    expect(rejected.pair?.active).toBe(false);
    expect(rejected.roster).toBeUndefined();

    // The invitee's own outstanding invitation already occupies a slot, so
    // completing it succeeds at the limit (idempotent retries stay safe).
    const invited = await fixture();
    const { _pair } = await findGroupRelationship(
      database.db,
      invited.group.threadId,
      invited.applicant.id,
    );
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'ACCEPTED', expiresAt: null, updatedAt: new Date() })
      .where(memberDirection(invited.group.account, invited.applicant.account));
    const requestedAt = new Date();
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: invited.group.account,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: invited.applicant.account,
      receiverNamespaceId: 0,
      status: 'REQUESTED',
      profileRev: 0,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });
    // Owner (1) + invitee's invitation (1) + 997 filled = the limit.
    await fillAuthorizedPairs(
      invited.group.account,
      invited.group.threadId,
      997,
    );
    const admitted = await authoredIntents.execute({
      ...invited.params,
      decision: 'ACCEPTED',
      scope: 'INVITATION',
    });
    expect(admitted.status, JSON.stringify(admitted)).toBe('APPLIED');
    expect(await state(invited)).toMatchObject({
      roster: expect.objectContaining({ role: 'MEMBER' }),
    });
  });

  it('unified acceptance treats a withdrawn application as a silent no-op', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    await database.db.transaction(async (tx) => {
      await lockGroupScopeInTx(tx, f.group.threadId);
      await services.mutations.writeMemberRelationshipIntentInTx(
        tx,
        f.group.threadId,
        f.applicant.id,
        'REVOKED',
        [],
      );
    });
    await expect(
      authoredIntents.execute({ ...f.params, decision: 'ACCEPTED' }),
    ).resolves.toMatchObject({
      status: 'NO_OP',
      reason: 'ALREADY_REVOKED',
    });
    const result = await state(f);
    expect(result.pair?.active).toBe(false);
    // The application is member-authored (side B); the group never authored a row.
    expect(result.intents.map((intent) => intent.status)).toEqual(['REVOKED']);
    // The withdrawal itself flipped the projection; the no-op left it untouched.
    expect(result.projection).toMatchObject({ status: 'WITHDRAWN' });
  });

  it('unified acceptance completes an invitation whose invitee already acked', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    // Seed the entry state directly: the group authored an outstanding
    // invitation (side A REQUESTED) and the invitee has already acked (side B
    // ACCEPTED) without any legacy activation having run.
    const { _pair } = await findGroupRelationship(
      database.db,
      f.group.threadId,
      f.applicant.id,
    );
    await database.db
      .update(tables.relationshipIntent)
      .set({
        status: 'ACCEPTED',
        note: '',
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(memberDirection(f.group.account, f.applicant.account));
    const invitationRequestedAt = new Date();
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: f.group.account,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: f.applicant.account,
      receiverNamespaceId: 0,
      status: 'REQUESTED',
      profileRev: 0,
      note: 'you are invited',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      requestedAt: invitationRequestedAt,
      expiresAt: new Date(
        invitationRequestedAt.getTime() + 7 * 24 * 60 * 60 * 1000,
      ),
      updatedAt: new Date(),
    });
    await authoredIntents.execute({
      ...f.params,
      decision: 'ACCEPTED',
      scope: 'INVITATION',
    });
    const result = await state(f);
    expect(result.pair?.active).toBe(true);
    expect(
      result.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [f.group.account, 'ACCEPTED'],
        [f.applicant.account, 'ACCEPTED'],
      ].sort(),
    );
    expect(result.roster).toMatchObject({ role: 'MEMBER' });
    expect(result.audience).toBeDefined();
    // The group's invitation note survives the promotion.
    expect(
      result.intents.find((intent) => intent.authorAccount === f.group.account)
        ?.note,
    ).toBe('you are invited');
  });

  it('unified request collapses a pending application into the acceptance path', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    await authoredIntents.execute({
      threadId: f.group.threadId,
      managerUserId: f.owner.id,
      decision: 'REQUESTED',
      target: {
        account: f.applicant.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      note: 'ignored',
    });
    const result = await state(f);
    expect(result.pair?.active).toBe(true);
    expect(
      result.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [f.group.account, 'ACCEPTED'],
        [f.applicant.account, 'REQUESTED'],
      ].sort(),
    );
    expect(result.roster).toMatchObject({ role: 'MEMBER' });
    // The applicant's own note wins, exactly like a direct ACK; no INVITATION
    // projection row is created on the way in.
    expect(result.feed?.body).toMatchObject({
      status: 'ACCEPTED',
      note: 'please',
    });
    expect(result.projection).toMatchObject({
      direction: 'APPLICATION',
      status: 'ACCEPTED',
    });
  });

  it('unified request completes an outstanding invitation (req + ack = ack)', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    const { _pair } = await findGroupRelationship(
      database.db,
      f.group.threadId,
      f.applicant.id,
    );
    await database.db
      .update(tables.relationshipIntent)
      .set({
        status: 'ACCEPTED',
        note: '',
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(memberDirection(f.group.account, f.applicant.account));
    const requestedAt = new Date();
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: f.group.account,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: f.applicant.account,
      receiverNamespaceId: 0,
      status: 'REQUESTED',
      profileRev: 0,
      note: 'you are invited',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });
    await authoredIntents.execute({
      threadId: f.group.threadId,
      managerUserId: f.owner.id,
      decision: 'REQUESTED',
      target: {
        account: f.applicant.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      note: 'ignored',
    });
    const result = await state(f);
    expect(result.pair?.active).toBe(true);
    expect(
      result.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [f.group.account, 'ACCEPTED'],
        [f.applicant.account, 'ACCEPTED'],
      ].sort(),
    );
    expect(
      result.intents.find((intent) => intent.authorAccount === f.group.account)
        ?.note,
    ).toBe('you are invited');
    expect(result.roster).toMatchObject({ role: 'MEMBER' });
  });

  it('unified request invites a fresh local member with projection-only effects', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const owner = await seedUser(app, `join-req-${++sequence}-owner`);
    const invitee = await seedUser(app, `join-req-${sequence}-invitee`);
    const created = await services.groups.createNewGroup({
      owner: owner.id,
      name: 'Invite authoredIntents',
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, created.threadId),
    });
    const group = { ...created, account: thread!.groupAccount! };
    const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
    const tasksBefore = await database.db.query.durableTask.findMany();
    const [metaBefore] = await database.db
      .select()
      .from(tables.groupMeta)
      .where(eq(tables.groupMeta.threadId, group.threadId));
    const messagesBefore = await database.pool.query(
      'SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1',
      [group.threadId],
    );
    businessLocks.length = 0;
    await authoredIntents.execute({
      threadId: group.threadId,
      managerUserId: owner.id,
      decision: 'REQUESTED',
      target: {
        account: invitee.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      note: 'join us',
    });
    // Account scope first, then pair scope, once each, like ACK and REVOKE.
    expect(businessLocks).toEqual([
      businessAccountScopeKey({
        account: group.account,
        profileNamespaceId: 0,
      }),
      relationshipPairBusinessKey({
        kind: 'GROUP_MEMBER',
        addresses: [
          { account: group.account, profileNamespaceId: 0 },
          { account: invitee.account, profileNamespaceId: 0 },
        ],
      }),
    ]);
    const { pair } = await findGroupRelationship(
      database.db,
      group.threadId,
      invitee.id,
    );
    expect(pair).toMatchObject({ active: false, established: false });
    const intents = await database.db.query.relationshipIntent.findMany({
      where: groupDirection(group.account, invitee.account),
    });
    expect(
      intents.map((intent) => [intent.authorAccount, intent.status]),
    ).toEqual([[group.account, 'REQUESTED']]);
    expect(intents[0].note).toBe('join us');
    expect(intents[0].expiresAt).toBeInstanceOf(Date);
    // No membership, no system message, no meta facts.
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupMemberInTx(tx, group.threadId, invitee.id),
    );
    expect(roster).toBeUndefined();
    const messages = await database.pool.query(
      'SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1',
      [group.threadId],
    );
    expect(messages.rows[0].n).toBe(messagesBefore.rows[0].n);
    const [meta] = await database.db
      .select()
      .from(tables.groupMeta)
      .where(eq(tables.groupMeta.threadId, group.threadId));
    // Only the invitation stream advanced; membership facts stay untouched.
    expect(meta).toMatchObject({
      applicationEndId: metaBefore.applicationEndId,
      invitationEndId: metaBefore.invitationEndId + 1,
      metaEndId: metaBefore.metaEndId,
    });
    // One INVITATION projection row for the manager, numbered by the group.
    const projection = await database.db.query.groupRequestProjection.findFirst(
      {
        where: and(
          eq(tables.groupRequestProjection.threadId, group.threadId),
          eq(tables.groupRequestProjection.direction, 'INVITATION'),
          eq(tables.groupRequestProjection.memberAccount, invitee.account),
          eq(tables.groupRequestProjection.profileNamespaceId, 0),
        ),
      },
    );
    expect(projection).toMatchObject({
      status: 'REQUESTED',
      note: 'join us',
      feedId: meta.invitationEndId,
      memberProfileRev: 0,
    });
    // The invitee learns through the compacted relationship feed.
    const feed = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(tables.clientStateFeed.userId, invitee.id),
        eq(tables.clientStateFeed.account, group.account),
        eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    expect(feed?.body).toMatchObject({
      status: 'REQUESTED',
      note: 'join us',
      established: false,
      threadId: group.threadId,
    });
    // Only the projection fan-out task is admitted.
    const inserted = (await database.db.query.durableTask.findMany()).filter(
      (task) => !tasksBefore.some((previous) => previous.id === task.id),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      taskType: 'FAN_OUT_GROUP_PROJECTION',
      coalescingKey: groupMembershipProjectionFanoutKey(group.threadId),
      checkpoint: { afterManagerId: '0' },
    });
    // Only the invitee is woken in-process; managers learn through the
    // projection fan-out task's per-manager watermark advance.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual([
      { userId: invitee.id, feedId: feed!.feedId },
    ]);
  });

  it('unified request invites a fresh remote member through the peer feed', async () => {
    const notifications: number[][] = [];
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockImplementation(
      async (namespaceIds) => {
        notifications.push([...namespaceIds]);
      },
    );
    const owner = await seedUser(app, `join-req-${++sequence}-owner`);
    const created = await services.groups.createNewGroup({
      owner: owner.id,
      name: 'Remote invite',
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, created.threadId),
    });
    const domain = `join-req-${sequence}.test`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const member = {
      account: `join-req-${sequence}-member`,
      domain,
      namespaceId,
    };
    await database.db.insert(tables.profileTable).values({
      account: member.account,
      publisherNamespaceId: member.namespaceId,
      profileNamespaceId: member.namespaceId,
      profileRev: 7,
      displayName: 'Remote invitee',
      avatar: '',
      bio: '',
    });
    await authoredIntents.execute({
      threadId: created.threadId,
      managerUserId: owner.id,
      decision: 'REQUESTED',
      target: { account: member.account, domain },
      note: 'join us',
    });
    expect(notifications).toEqual([[namespaceId]]);
    const { pair } = await findGroupRelationship(
      database.db,
      created.threadId,
      member,
    );
    expect(pair).toMatchObject({
      active: false,
      endpointANamespaceId: 0,
      endpointBNamespaceId: namespaceId,
    });
    const peerFeed = await database.db.query.peerStateFeed.findFirst({
      where: and(
        eq(tables.peerStateFeed.namespaceId, namespaceId),
        eq(tables.peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        eq(tables.peerStateFeed.subjectAccount, member.account),
      ),
    });
    // With no side B yet, the invitation carries the group's own profile
    // reference — the same authored write the legacy invite performs.
    const [groupProfile] = await database.db
      .select({ rev: tables.groupAccount.defaultProfileRev })
      .from(tables.groupAccount)
      .where(eq(tables.groupAccount.account, thread!.groupAccount!));
    expect(peerFeed?.body).toMatchObject({
      status: 'REQUESTED',
      profileRev: groupProfile.rev,
      note: 'join us',
    });
    // The federated audience opens at invite time, floor zero with history on.
    const audience = await database.db.query.threadAudience.findFirst({
      where: and(
        eq(tables.threadAudience.threadId, created.threadId),
        eq(tables.threadAudience.targetNamespaceId, namespaceId),
      ),
    });
    expect(audience).toMatchObject({
      messageAccessAfterSeq: 0,
      groupMetaVisibleAfter: 0,
    });
  });

  it('unified request re-invites a withdrawn applicant and no-ops for members, strangers, and dissolved groups', async () => {
    vi.spyOn(deps.federation, 'pushStateFeedNamespaces').mockResolvedValue(
      undefined,
    );
    const f = await fixture();
    await database.db.transaction(async (tx) => {
      await lockGroupScopeInTx(tx, f.group.threadId);
      await services.mutations.writeMemberRelationshipIntentInTx(
        tx,
        f.group.threadId,
        f.applicant.id,
        'REVOKED',
        [],
      );
    });
    // Side B REVOKED receives a fresh invitation without touching side B.
    await authoredIntents.execute({
      threadId: f.group.threadId,
      managerUserId: f.owner.id,
      decision: 'REQUESTED',
      target: {
        account: f.applicant.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
      note: 'again',
    });
    let result = await state(f);
    expect(result.pair?.active).toBe(false);
    expect(
      result.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [f.group.account, 'REQUESTED'],
        [f.applicant.account, 'REVOKED'],
      ].sort(),
    );
    expect(
      result.intents.find((intent) => intent.authorAccount === f.group.account)
        ?.note,
    ).toBe('again');

    // A rostered member is already satisfied: silent no-op, no tasks.
    const g = await fixture();
    await authoredIntents.execute(g.params);
    const tasksBefore = await database.db.query.durableTask.findMany();
    await authoredIntents.execute({
      threadId: g.group.threadId,
      managerUserId: g.owner.id,
      decision: 'REQUESTED',
      target: {
        account: g.applicant.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      },
    });
    result = await state(g);
    expect(
      result.intents
        .map((intent) => [intent.authorAccount, intent.status])
        .sort(),
    ).toEqual(
      [
        [g.group.account, 'ACCEPTED'],
        [g.applicant.account, 'REQUESTED'],
      ].sort(),
    );
    expect(
      (await database.db.query.durableTask.findMany()).filter(
        (task) => !tasksBefore.some((previous) => previous.id === task.id),
      ),
    ).toEqual([]);

    // A stranger with no local account is not found; the minted pair rolls back.
    const ghost = `join-req-${sequence}-ghost`;
    await expect(
      authoredIntents.execute({
        threadId: g.group.threadId,
        managerUserId: g.owner.id,
        decision: 'REQUESTED',
        target: {
          account: ghost,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.NOT_FOUND,
    });
    const ghostPair = await database.pool.query(
      `SELECT id FROM "RelationshipPair" WHERE kind = 'GROUP_MEMBER'
         AND "endpointBAccount" = $1 AND "endpointBNamespaceId" = 0 AND "threadId" = $2`,
      [ghost, g.group.threadId],
    );
    expect(ghostPair.rowCount).toBe(0);

    // A non-manager is forbidden.
    await expect(
      authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.applicant.id,
        decision: 'REQUESTED',
        target: {
          account: f.applicant.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });

    // A dissolved group is a normal business rejection before any write: no
    // pair is minted and no exception interrupts the caller.
    await database.db
      .update(tables.groupAccount)
      .set({ dissolvedAt: new Date() })
      .where(eq(tables.groupAccount.account, f.group.account));
    const pairsBefore = await database.pool.query(
      'SELECT count(*)::int AS n FROM "RelationshipPair" WHERE "threadId" = $1',
      [f.group.threadId],
    );
    await expect(
      authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        decision: 'REQUESTED',
        target: {
          account: g.applicant.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_DISSOLVED,
    });
    const pairsAfter = await database.pool.query(
      'SELECT count(*)::int AS n FROM "RelationshipPair" WHERE "threadId" = $1',
      [f.group.threadId],
    );
    expect(pairsAfter.rows[0].n).toBe(pairsBefore.rows[0].n);
  });

  describe('group membership', () => {
    let membership: MemberAuthoredGroupMembershipIntentService;

    beforeAll(() => {
      membership = new MemberAuthoredGroupMembershipIntentService({
        database: deps.database,
        clientFeed: deps.clientFeed,
        relationshipMutations: services.mutations,
        federation: deps.federation,
      });
    });

    /** Owner plus a fresh prospective member around one authoritative group. */
    async function memberFixture() {
      const prefix = `member-${++sequence}`;
      const owner = await seedUser(app, `${prefix}-owner`);
      const member = await seedUser(app, `${prefix}-member`);
      const created = await services.groups.createNewGroup({
        owner: owner.id,
        name: 'Membership authoredIntents',
      });
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, created.threadId),
      });
      const group = { ...created, account: thread!.groupAccount! };
      return { owner, member, group };
    }

    // The group account's '!' prefix sorts before member accounts, matching
    // the historical side-letter order of group-authored first.
    const intentsOf = (f: Awaited<ReturnType<typeof memberFixture>>) =>
      database.db.query.relationshipIntent
        .findMany({
          where: or(
            groupDirection(f.group.account, f.member.account),
            memberDirection(f.group.account, f.member.account),
          ),
        })
        .then((rows) =>
          rows.sort((left, right) =>
            left.authorAccount.localeCompare(right.authorAccount),
          ),
        );

    it('applies to join, refreshes the application, and admits the projection fan-out', async () => {
      const f = await memberFixture();
      const messagesBefore = await database.pool.query(
        'SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1',
        [f.group.threadId],
      );
      const initialMeta = await database.db.query.groupMeta.findFirst({
        where: eq(tables.groupMeta.threadId, f.group.threadId),
      });
      const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
        note: 'let me in',
      });
      const { pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      expect(pair).toMatchObject({ active: false, established: false });
      const intents = await intentsOf(f);
      expect(intents.map((i) => [i.authorAccount, i.status])).toEqual([
        [f.member.account, 'REQUESTED'],
      ]);
      expect(intents[0].note).toBe('let me in');
      expect(intents[0].expiresAt).toBeInstanceOf(Date);
      // No membership, no system message, no meta facts.
      const roster = await database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, f.group.threadId, f.member.id),
      );
      expect(roster).toBeUndefined();
      const messages = await database.pool.query(
        'SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1',
        [f.group.threadId],
      );
      expect(messages.rows[0].n).toBe(messagesBefore.rows[0].n);
      const [metaBefore] = await database.db
        .select()
        .from(tables.groupMeta)
        .where(eq(tables.groupMeta.threadId, f.group.threadId));
      expect(metaBefore).toMatchObject({
        applicationEndId: initialMeta!.applicationEndId + 1,
        invitationEndId: initialMeta!.invitationEndId,
      });
      // One APPLICATION projection row for the manager, numbered by the group.
      const projection =
        await database.db.query.groupRequestProjection.findFirst({
          where: and(
            eq(tables.groupRequestProjection.threadId, f.group.threadId),
            eq(tables.groupRequestProjection.direction, 'APPLICATION'),
            eq(tables.groupRequestProjection.memberAccount, f.member.account),
          ),
        });
      expect(projection).toMatchObject({
        status: 'REQUESTED',
        note: 'let me in',
        feedId: metaBefore.applicationEndId,
      });
      // The applicant learns through their own compacted outgoing feed row.
      const feed = await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(tables.clientStateFeed.userId, f.member.id),
          eq(tables.clientStateFeed.account, f.group.account),
          eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
      expect(feed?.body).toMatchObject({
        status: 'REQUESTED',
        note: 'let me in',
        direction: 'OUTGOING',
        threadId: f.group.threadId,
      });
      // The projection fan-out task carries the per-manager notification.
      const tasks = await database.db.query.durableTask.findMany();
      expect(
        tasks.find(
          (task) =>
            task.taskType === 'FAN_OUT_GROUP_PROJECTION' &&
            task.status === 'PENDING',
        ),
      ).toMatchObject({ checkpoint: { afterManagerId: '0' } });
      // Only the applicant is woken in-process; managers ride the task.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toEqual([
        { userId: f.member.id, feedId: Number(feed!.feedId) },
      ]);

      // A live application is refreshed: new number, note, and expiry.
      notify.mockClear();
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
        note: 'again please',
      });
      const [refreshedMeta] = await database.db
        .select()
        .from(tables.groupMeta)
        .where(eq(tables.groupMeta.threadId, f.group.threadId));
      expect(refreshedMeta.applicationEndId).toBe(
        metaBefore.applicationEndId + 1,
      );
      const refreshed =
        await database.db.query.groupRequestProjection.findFirst({
          where: and(
            eq(tables.groupRequestProjection.threadId, f.group.threadId),
            eq(tables.groupRequestProjection.direction, 'APPLICATION'),
            eq(tables.groupRequestProjection.memberAccount, f.member.account),
          ),
        });
      expect(refreshed).toMatchObject({
        feedId: refreshedMeta.applicationEndId,
        note: 'again please',
      });
      const refreshedPair = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      expect(refreshedPair.pair!.id).toBe(pair!.id);
    });

    it('completes an outstanding invitation from the member side', async () => {
      const f = await memberFixture();
      await authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        decision: 'REQUESTED',
        target: {
          account: f.member.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
        note: 'join us',
      });
      const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'ACCEPTED',
      });
      const { pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      expect(pair).toMatchObject({ active: true, established: true });
      const intents = await intentsOf(f);
      expect(intents.map((i) => [i.authorAccount, i.status])).toEqual([
        [f.group.account, 'ACCEPTED'],
        [f.member.account, 'ACCEPTED'],
      ]);
      // Completing the invitation preserves the group's own note on both sides.
      expect(intents[0].note).toBe('join us');
      expect(intents[1].note).toBe('join us');
      const roster = await database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, f.group.threadId, f.member.id),
      );
      expect(roster).toMatchObject({ role: 'MEMBER' });
      const joined = await database.pool.query(
        `SELECT count(*)::int AS n FROM "Message"
         WHERE "threadId" = $1 AND "contentType" = 'SYSTEM'
           AND content->>'type' = 'GROUP_JOINED'`,
        [f.group.threadId],
      );
      expect(joined.rows[0].n).toBe(1);
      // The INVITATION row flips; no APPLICATION row was ever created.
      const rows = await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(tables.groupRequestProjection.threadId, f.group.threadId),
          eq(tables.groupRequestProjection.memberAccount, f.member.account),
        ),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'INVITATION',
        status: 'ACCEPTED',
      });
      // Only the member is woken in-process.
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('collapses req + outstanding invitation into acceptance', async () => {
      const f = await memberFixture();
      await authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        decision: 'REQUESTED',
        target: {
          account: f.member.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
        note: 'join us',
      });
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
        note: 'oh hi',
      });
      const { pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      expect(pair).toMatchObject({ active: true, established: true });
      const intents = await intentsOf(f);
      expect(intents.map((i) => [i.authorAccount, i.status])).toEqual([
        [f.group.account, 'ACCEPTED'],
        [f.member.account, 'ACCEPTED'],
      ]);
      const rows = await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(tables.groupRequestProjection.threadId, f.group.threadId),
          eq(tables.groupRequestProjection.memberAccount, f.member.account),
        ),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'INVITATION',
        status: 'ACCEPTED',
      });
    });

    it('withdraws a pending application silently for managers', async () => {
      const f = await memberFixture();
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
        note: 'let me in',
      });
      const tasksBefore = await database.db.query.durableTask.findMany();
      const notify = vi.spyOn(deps.clientFeed, 'notifyFeedUpdates');
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REVOKED',
      });
      const { _pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      const intents = await intentsOf(f);
      expect(intents.map((i) => [i.authorAccount, i.status])).toEqual([
        [f.member.account, 'REVOKED'],
      ]);
      const projection =
        await database.db.query.groupRequestProjection.findFirst({
          where: and(
            eq(tables.groupRequestProjection.threadId, f.group.threadId),
            eq(tables.groupRequestProjection.direction, 'APPLICATION'),
            eq(tables.groupRequestProjection.memberAccount, f.member.account),
          ),
        });
      expect(projection).toMatchObject({ status: 'WITHDRAWN' });
      // No departure facts: the applicant was never rostered.
      const departures = await database.pool.query(
        `SELECT count(*)::int AS n FROM "GroupMetaMemberFeed"
         WHERE "threadId" = $1 AND operation = 'MEMBER_DEPART'`,
        [f.group.threadId],
      );
      expect(departures.rows[0].n).toBe(0);
      // Decision-time silence: no new tasks, only the member's own wake.
      const newTasks = (await database.db.query.durableTask.findMany()).filter(
        (task) => !tasksBefore.some((previous) => previous.id === task.id),
      );
      expect(newTasks).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('declines an outstanding invitation without touching side A', async () => {
      const f = await memberFixture();
      await authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        decision: 'REQUESTED',
        target: {
          account: f.member.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
        note: 'join us',
      });
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REVOKED',
      });
      const { _pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      const intents = await intentsOf(f);
      expect(intents.map((i) => [i.authorAccount, i.status])).toEqual([
        [f.group.account, 'REQUESTED'],
        [f.member.account, 'REVOKED'],
      ]);
      const projection =
        await database.db.query.groupRequestProjection.findFirst({
          where: and(
            eq(tables.groupRequestProjection.threadId, f.group.threadId),
            eq(tables.groupRequestProjection.direction, 'INVITATION'),
            eq(tables.groupRequestProjection.memberAccount, f.member.account),
          ),
        });
      expect(projection).toMatchObject({ status: 'REJECTED' });
    });

    it('leaves the roster with the full departure effect', async () => {
      const f = await memberFixture();
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
      });
      const _applied = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      const _sideB = await database.db.query.relationshipIntent.findFirst({
        where: memberDirection(f.group.account, f.member.account),
      });
      await authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        target: {
          account: f.member.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
        scope: 'APPLICATION',
        decision: 'ACCEPTED',
      });
      const before = await database.db.query.durableTask.findMany();
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REVOKED',
      });
      const { pair } = await findGroupRelationship(
        database.db,
        f.group.threadId,
        f.member.id,
      );
      expect(pair).toMatchObject({ active: false });
      const roster = await database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, f.group.threadId, f.member.id),
      );
      expect(roster).toBeUndefined();
      const departed = await database.pool.query(
        `SELECT count(*)::int AS n FROM "GroupMetaMemberFeed"
         WHERE "threadId" = $1 AND operation = 'MEMBER_DEPART'`,
        [f.group.threadId],
      );
      expect(departed.rows[0].n).toBe(1);
      const left = await database.pool.query(
        `SELECT count(*)::int AS n FROM "Message"
         WHERE "threadId" = $1 AND "contentType" = 'SYSTEM'
           AND content->>'type' = 'GROUP_LEFT'`,
        [f.group.threadId],
      );
      expect(left.rows[0].n).toBe(1);
      const after = await database.db.query.durableTask.findMany();
      const added = after.filter(
        (task) => !before.some((previous) => previous.id === task.id),
      );
      expect(added.map((task) => task.taskType)).toEqual(
        expect.arrayContaining(['FAN_OUT_ACCOUNT_THREAD_CONTENT']),
      );
      // The departure merges its heads into the still-pending join fan-out
      // instead of admitting a second content task.
      const threadFanout = after.find(
        (task) =>
          task.taskType === 'FAN_OUT_THREAD_CONTENT' &&
          task.status === 'PENDING' &&
          task.payload.threadId === f.group.threadId,
      );
      expect(threadFanout).toBeTruthy();
      const leftSeq = await database.pool.query(
        `SELECT max(seq)::int AS n FROM "Message"
         WHERE "threadId" = $1 AND content->>'type' = 'GROUP_LEFT'`,
        [f.group.threadId],
      );
      expect(Number(threadFanout!.payload.messageEndSeq)).toBe(
        leftSeq.rows[0].n,
      );
      const rows = await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(tables.groupRequestProjection.threadId, f.group.threadId),
          eq(tables.groupRequestProjection.memberAccount, f.member.account),
        ),
      });
      expect(rows.every((row) => row.status === 'ACCEPTED')).toBe(true);
    });

    it('rejects and no-ops the edges', async () => {
      const f = await memberFixture();
      // Nothing to accept, nothing to revoke.
      await expect(
        membership.execute({
          threadId: f.group.threadId,
          memberUserId: f.member.id,
          decision: 'ACCEPTED',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        code: BusinessCode.NOT_FOUND,
      });
      await expect(
        membership.execute({
          threadId: f.group.threadId,
          memberUserId: f.member.id,
          decision: 'REVOKED',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        code: BusinessCode.NOT_FOUND,
      });

      // A dissolved group returns a normal business rejection; disband owns
      // departures for members already on the roster.
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'REQUESTED',
      });
      await authoredIntents.execute({
        threadId: f.group.threadId,
        managerUserId: f.owner.id,
        decision: 'REQUESTED',
        target: {
          account: f.member.account,
          domain: localIdentityDomain(),
          namespaceId: 0,
        },
      });
      await membership.execute({
        threadId: f.group.threadId,
        memberUserId: f.member.id,
        decision: 'ACCEPTED',
      });
      await database.db
        .update(tables.groupAccount)
        .set({ dissolvedAt: new Date() })
        .where(eq(tables.groupAccount.account, f.group.account));
      const pairsBefore = await database.pool.query(
        'SELECT count(*)::int AS n FROM "RelationshipPair" WHERE "threadId" = $1',
        [f.group.threadId],
      );
      await expect(
        membership.execute({
          threadId: f.group.threadId,
          memberUserId: f.member.id,
          decision: 'REVOKED',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        code: BusinessCode.GROUP_DISSOLVED,
      });

      // A stranger's positive direction is rejected before pair allocation.
      const stranger = await seedUser(app, `member-${++sequence}-stranger`);
      await expect(
        membership.execute({
          threadId: f.group.threadId,
          memberUserId: stranger.id,
          decision: 'REQUESTED',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        code: BusinessCode.GROUP_DISSOLVED,
      });
      const pairsAfter = await database.pool.query(
        'SELECT count(*)::int AS n FROM "RelationshipPair" WHERE "threadId" = $1',
        [f.group.threadId],
      );
      expect(pairsAfter.rows[0].n).toBe(pairsBefore.rows[0].n);
    });
  });
});
