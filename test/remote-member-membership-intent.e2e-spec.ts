import { and, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { withBusinessLockCapture } from './business-lock-capture.js';
import * as tables from '../src/database/schema.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationStateFeedPushService } from '../src/federation/federation-state-feed-push.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { GroupRelationshipMutationService } from '../src/group/membership-intent/shared/group-relationship-mutation.service.js';
import {
  RemoteMemberMembershipIntentService,
  type RemoteMemberMembershipIntentDependencies,
} from '../src/group/membership-intent/received/remote-member-membership-intent.service.js';
import { seedFederatedPeerNamespace, seedUser } from './seed.js';

const PEER_DOMAIN = `remote-member-${process.pid}.example`;
const GROUP_ACCOUNT = '!remote-member-group';

interface Fixture {
  threadId: number;
  groupAccount: string;
  member: { account: string; namespaceId: number };
}

describe('remote member membership intents on the authoritative group', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let applier: RemoteMemberMembershipIntentService;
  let sequence = 0;
  const businessLocks: string[] = [];
  let namespaceId: number;

  function ackBody(
    overrides?: Partial<
      Parameters<RemoteMemberMembershipIntentService['execute']>[0]['body']
    >,
  ) {
    return {
      status: 'ACCEPTED' as const,
      profileNamespaceId: namespaceId,
      profileRev: 3,
      note: 'op-apply',
      requestedAt: Date.now() - 10_000,
      expiresAt: null,
      messageEndSeq: 5,
      tombstoneEndSeq: 1,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Schedulers stay stopped: the database rows are the assertion surface.
    app = fixture.createNestApplication(new FastifyAdapter());
    database = app.get(DatabaseService);
    const deps: RemoteMemberMembershipIntentDependencies = {
      database: withBusinessLockCapture(database, businessLocks),
      clientFeed: app.get(ClientStateFeedService),
      peerFeed: app.get(PeerStateFeedService),
      federation: app.get(FederationStateFeedPushService),
      relationshipMutations: app.get(GroupRelationshipMutationService),
    };
    applier = new RemoteMemberMembershipIntentService(deps);
    namespaceId = await seedFederatedPeerNamespace(database.db, PEER_DOMAIN);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  /** An authoritative local group whose remote member already completed the
   * membership: both directions ACCEPTED, the pair established, the roster
   * fact written — the exact state a replayed ACK lands on. */
  async function seedMembershipFixture(completed: boolean): Promise<Fixture> {
    sequence += 1;
    const owner = await seedUser(app, `remote-owner-${sequence}`);
    const [group] = await database.db
      .insert(tables.groupAccount)
      .values({ account: `${GROUP_ACCOUNT}-${sequence}`, defaultProfileRev: 1 })
      .returning();
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount: group!.account,
        groupDomain: 'local',
        groupAccountId: group!.id,
        authorityNamespaceId: 0,
        federationRoundsEnabled: true,
        updatedAt: new Date(),
      })
      .returning();
    await database.db
      .insert(tables.groupMeta)
      .values({ threadId: thread!.id, metaEndId: 1 });
    const memberAccount = `remote-member-${sequence}`;
    const [_pair] = await database.db
      .insert(tables.relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: group!.account,
        // The locally hosted group always sits on side A at namespace 0; the
        // remote member carries its own namespace on side B.
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: memberAccount,
        endpointBNamespaceId: namespaceId,
        threadId: thread!.id,
        active: completed,
        established: completed,
        updatedAt: new Date(),
      })
      .returning();
    if (completed)
      await database.db.insert(tables.relationshipIntent).values([
        {
          authorAccount: group!.account,
          authorNamespaceId: 0,
          profileNamespaceId: 0,
          receiverAccount: memberAccount,
          receiverNamespaceId: namespaceId,
          status: 'ACCEPTED',
          profileRev: 1,
          note: '',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          requestedAt: new Date(Date.now() - 5_000),
          expiresAt: null,
        },
        {
          authorAccount: memberAccount,
          authorNamespaceId: namespaceId,
          profileNamespaceId: namespaceId,
          receiverAccount: group!.account,
          receiverNamespaceId: 0,
          status: 'ACCEPTED',
          profileRev: 3,
          note: 'op-apply',
          messageEndSeq: 5,
          tombstoneEndSeq: 1,
          requestedAt: new Date(Date.now() - 10_000),
          expiresAt: null,
        },
      ]);
    if (completed)
      await database.db.insert(tables.groupMetaMemberFeed).values({
        threadId: thread!.id,
        feedId: 1,
        memberAccount,
        profileNamespaceId: namespaceId,
        operation: 'MEMBER_UPSERT',
        body: {
          role: 'MEMBER',
          profileNamespaceId: namespaceId,
          profileRev: 3,
        },
      });
    await database.db.insert(tables.accountThreadState).values({
      accountId: owner.id,
      threadId: thread!.id,
      role: 'OWNER',
      updatedAt: new Date(),
    });
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: group!.account,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: owner.account,
      endpointBNamespaceId: 0,
      threadId: thread!.id,
      active: true,
      established: true,
      updatedAt: new Date(),
    });
    return {
      threadId: thread!.id,
      groupAccount: group!.account,
      member: {
        account: memberAccount,
        namespaceId,
      },
    };
  }

  const seedCompletedMembership = () => seedMembershipFixture(true);

  const intentsOf = (fixture: Fixture) =>
    database.db
      .select({
        authorAccount: tables.relationshipIntent.authorAccount,
        status: tables.relationshipIntent.status,
        messageEndSeq: tables.relationshipIntent.messageEndSeq,
      })
      .from(tables.relationshipIntent)
      .where(
        or(
          // group-authored direction
          and(
            eq(tables.relationshipIntent.authorAccount, fixture.groupAccount),
            eq(tables.relationshipIntent.authorNamespaceId, 0),
            eq(
              tables.relationshipIntent.receiverAccount,
              fixture.member.account,
            ),
            eq(
              tables.relationshipIntent.receiverNamespaceId,
              fixture.member.namespaceId,
            ),
          ),
          // member-authored direction
          and(
            eq(tables.relationshipIntent.authorAccount, fixture.member.account),
            eq(
              tables.relationshipIntent.authorNamespaceId,
              fixture.member.namespaceId,
            ),
            eq(tables.relationshipIntent.receiverAccount, fixture.groupAccount),
            eq(tables.relationshipIntent.receiverNamespaceId, 0),
          ),
        ),
      );

  const pairOf = async (fixture: Fixture) =>
    (
      await database.db
        .select({
          active: tables.relationshipPair.active,
          established: tables.relationshipPair.established,
        })
        .from(tables.relationshipPair)
        .where(
          and(
            eq(tables.relationshipPair.threadId, fixture.threadId),
            eq(
              tables.relationshipPair.endpointBAccount,
              fixture.member.account,
            ),
          ),
        )
    )[0]!;

  const rosterCount = async (fixture: Fixture) =>
    (
      await database.db
        .select({ id: tables.groupMetaMemberFeed.feedId })
        .from(tables.groupMetaMemberFeed)
        .where(eq(tables.groupMetaMemberFeed.threadId, fixture.threadId))
    ).length;

  async function seedPendingApplication(): Promise<Fixture> {
    const fixture = await seedMembershipFixture(false);
    const requestedAt = Date.now();
    expect(
      (
        await applier.execute({
          threadId: fixture.threadId,
          member: fixture.member,
          body: ackBody({
            status: 'REQUESTED',
            requestedAt,
            expiresAt: requestedAt + 60_000,
          }),
        })
      ).routed,
    ).toBe('recorded-request');
    return fixture;
  }

  const groupPeerIntentRows = (fixture: Fixture) =>
    database.db
      .select({
        feedId: tables.peerStateFeed.feedId,
        body: tables.peerStateFeed.body,
      })
      .from(tables.peerStateFeed)
      .where(
        and(
          eq(tables.peerStateFeed.namespaceId, fixture.member.namespaceId),
          eq(tables.peerStateFeed.account, fixture.groupAccount),
          eq(tables.peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
          eq(tables.peerStateFeed.subjectAccount, fixture.member.account),
        ),
      );

  it('does not invent a group direction when a remote applicant withdraws', async () => {
    const fixture = await seedPendingApplication();
    expect(
      (await intentsOf(fixture)).map((intent) => intent.authorAccount),
    ).toEqual([fixture.member.account]);
    const [before] = await database.db
      .select({ endId: tables.identityNamespace.stateFeedEndId })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, fixture.member.namespaceId));
    const result = await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: ackBody({ status: 'REVOKED', requestedAt: null, expiresAt: null }),
    });
    expect(result.routed).toBe('rejection');
    expect(
      (await intentsOf(fixture)).map((intent) => [
        intent.authorAccount,
        intent.status,
      ]),
    ).toEqual([[fixture.member.account, 'REVOKED']]);
    expect(await groupPeerIntentRows(fixture)).toEqual([]);
    const [after] = await database.db
      .select({ endId: tables.identityNamespace.stateFeedEndId })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, fixture.member.namespaceId));
    expect(after!.endId).toBe(before!.endId);
    expect(await pairOf(fixture)).toMatchObject({
      active: false,
      established: false,
    });
  });

  it('concludes a still-effective group invitation when the remote member declines', async () => {
    const fixture = await seedMembershipFixture(false);
    const [_pair] = await database.db
      .select({ id: tables.relationshipPair.id })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, fixture.threadId),
          eq(tables.relationshipPair.endpointBAccount, fixture.member.account),
        ),
      );
    const requestedAt = new Date();
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: fixture.groupAccount,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: fixture.member.account,
      receiverNamespaceId: fixture.member.namespaceId,
      status: 'REQUESTED',
      profileRev: 1,
      note: 'invitation',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 60_000),
    });
    const result = await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: ackBody({ status: 'REVOKED', requestedAt: null, expiresAt: null }),
    });
    expect(result.routed).toBe('rejection');
    expect(
      (await intentsOf(fixture)).map((intent) => [
        intent.authorAccount,
        intent.status,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [fixture.groupAccount, 'REVOKED'],
        [fixture.member.account, 'REVOKED'],
      ]),
    );
    const feed = await groupPeerIntentRows(fixture);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.body).toMatchObject({ status: 'REVOKED' });
    const feedId = feed[0]!.feedId;
    await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: ackBody({ status: 'REVOKED', requestedAt: null, expiresAt: null }),
    });
    expect((await groupPeerIntentRows(fixture))[0]!.feedId).toBe(feedId);
    expect(await pairOf(fixture)).toMatchObject({
      active: false,
      established: false,
    });
  });

  it('treats a rostered member replayed ACK as a completion, never a revocation', async () => {
    const fixture = await seedCompletedMembership();
    // The replay carries heads advanced past the stored B-side: exactly what a
    // member's home node sends after the member chatted elsewhere.
    const result = await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: ackBody({ messageEndSeq: 7 }),
    });
    expect(result.routed).toBe('completion');

    const intents = await intentsOf(fixture);
    expect(
      intents.find((row) => row.authorAccount === fixture.groupAccount)!.status,
    ).toBe('ACCEPTED');
    expect(
      intents.find((row) => row.authorAccount === fixture.member.account),
    ).toMatchObject({
      status: 'ACCEPTED',
      messageEndSeq: 7,
    });
    expect(await pairOf(fixture)).toMatchObject({
      active: true,
      established: true,
    });
    // No roster coordinate, no departure fact, no system message.
    expect(await rosterCount(fixture)).toBe(1);
    expect(
      await database.db
        .select({ id: tables.message.id })
        .from(tables.message)
        .where(eq(tables.message.threadId, fixture.threadId)),
    ).toEqual([]);
  });

  it('concludes the group direction when a remote pending member revokes', async () => {
    const fixture = await seedCompletedMembership();
    const [pair] = await database.db
      .select({ id: tables.relationshipPair.id })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, fixture.threadId),
          eq(tables.relationshipPair.endpointBAccount, fixture.member.account),
        ),
      );
    const requestedAt = new Date();
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.id, pair!.id));
    await database.db
      .update(tables.relationshipIntent)
      .set({
        status: 'REQUESTED',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 60_000),
      })
      .where(
        or(
          and(
            eq(tables.relationshipIntent.authorAccount, fixture.groupAccount),
            eq(tables.relationshipIntent.authorNamespaceId, 0),
            eq(
              tables.relationshipIntent.receiverAccount,
              fixture.member.account,
            ),
            eq(
              tables.relationshipIntent.receiverNamespaceId,
              fixture.member.namespaceId,
            ),
          ),
          and(
            eq(tables.relationshipIntent.authorAccount, fixture.member.account),
            eq(
              tables.relationshipIntent.authorNamespaceId,
              fixture.member.namespaceId,
            ),
            eq(tables.relationshipIntent.receiverAccount, fixture.groupAccount),
            eq(tables.relationshipIntent.receiverNamespaceId, 0),
          ),
        ),
      );
    await database.db
      .delete(tables.groupMetaMemberFeed)
      .where(
        and(
          eq(tables.groupMetaMemberFeed.threadId, fixture.threadId),
          eq(tables.groupMetaMemberFeed.memberAccount, fixture.member.account),
        ),
      );

    const result = await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: {
        ...ackBody(),
        status: 'REVOKED',
        requestedAt: null,
      },
    });
    expect(result.routed).toBe('rejection');
    expect((await intentsOf(fixture)).map((intent) => intent.status)).toEqual([
      'REVOKED',
      'REVOKED',
    ]);
    expect(await pairOf(fixture)).toMatchObject({ active: false });
    expect(
      await database.db
        .select({ id: tables.message.id })
        .from(tables.message)
        .where(eq(tables.message.threadId, fixture.threadId)),
    ).toEqual([]);
  });

  it('retains a late member ACK without republishing an already revoked group direction', async () => {
    const fixture = await seedCompletedMembership();
    // An owner kick already closed side A and the pair before the old ACK
    // arrived from the member's home.
    const [pair] = await database.db
      .select({ id: tables.relationshipPair.id })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, fixture.threadId),
          eq(tables.relationshipPair.endpointBAccount, fixture.member.account),
        ),
      );
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, fixture.groupAccount),
          eq(tables.relationshipIntent.authorNamespaceId, 0),
          eq(tables.relationshipIntent.receiverAccount, fixture.member.account),
          eq(
            tables.relationshipIntent.receiverNamespaceId,
            fixture.member.namespaceId,
          ),
        ),
      );
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.id, pair!.id));
    const [before] = await database.db
      .select({ endId: tables.identityNamespace.stateFeedEndId })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, fixture.member.namespaceId));
    const result = await applier.execute({
      threadId: fixture.threadId,
      member: fixture.member,
      body: ackBody({ note: 'replayed-ack' }),
    });
    expect(result.routed).toBe('noop:dropped-ack');
    const intents = await intentsOf(fixture);
    expect(
      intents.find((row) => row.authorAccount === fixture.groupAccount)!.status,
    ).toBe('REVOKED');
    expect(
      intents.find((row) => row.authorAccount === fixture.member.account)!
        .status,
    ).toBe('ACCEPTED');
    expect((await pairOf(fixture)).active).toBe(false);
    expect(await groupPeerIntentRows(fixture)).toEqual([]);
    const [after] = await database.db
      .select({ endId: tables.identityNamespace.stateFeedEndId })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, fixture.member.namespaceId));
    expect(after!.endId).toBe(before!.endId);
  });
});
