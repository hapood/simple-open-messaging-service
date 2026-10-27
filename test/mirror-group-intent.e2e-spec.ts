import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { ProfiledAddress } from '../shared/profiled-address.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { withBusinessLockCapture } from './business-lock-capture.js';
import { businessAccountScopeKey } from '../src/common/locks/account-business-lock.js';
import * as tables from '../src/database/schema.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { ClientGroupMetaFeedService } from '../src/client-state-feed/client-group-meta-feed.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';
import { FederationStateFeedPushService } from '../src/federation/federation-state-feed-push.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { GroupRelationshipMutationService } from '../src/group/membership-intent/shared/group-relationship-mutation.service.js';
import { MemberAuthoredGroupMembershipIntentService } from '../src/group/membership-intent/authored/member-authored-group-membership-intent.service.js';
import { MirrorGroupMembershipIntentService } from '../src/group/membership-intent/received/mirror-group-membership-intent.service.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { seedFederatedPeerNamespace, seedUser } from './seed.js';

const _ownDomain = loadFederationConfig().domain;

const ORIGIN_DOMAIN = `mirror-origin-${process.pid}.example`;
const GROUP_ACCOUNT = '!mirror-group';

interface GroupRef {
  account: string;
  domain: string;
  namespaceId: number;
}

interface MemberRef {
  id: number;
  account: string;
}

function msFromNow(days: number): number {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

function invitationBody(
  overrides?: Partial<
    Parameters<MirrorGroupMembershipIntentService['execute']>[0]['body']
  >,
) {
  // One clock read: the TTL window must not overflow by a tick between the
  // two samples.
  const statusChangedAt = Date.now();
  return {
    status: 'REQUESTED' as const,
    profileNamespaceId: 0,
    profileRev: 3,
    note: 'join us',
    statusChangedAt,
    expiresAt: statusChangedAt + 7 * 24 * 60 * 60 * 1000,
    messageEndSeq: 5,
    tombstoneEndSeq: 1,
    ...overrides,
  };
}

function acceptanceBody(
  overrides?: Partial<
    Parameters<MirrorGroupMembershipIntentService['execute']>[0]['body']
  >,
) {
  return {
    status: 'ACCEPTED' as const,
    profileNamespaceId: 0,
    profileRev: 3,
    note: 'join us',
    statusChangedAt: Date.now(),
    expiresAt: null,
    messageEndSeq: 5,
    tombstoneEndSeq: 1,
    ...overrides,
  };
}

function wireBody(
  body: Parameters<MirrorGroupMembershipIntentService['execute']>[0]['body'],
) {
  const { profileNamespaceId, ...rest } = body;
  return { ...rest, namespaceId: profileNamespaceId };
}

/** jsonb columns arrive parsed on this driver; accept both shapes anyway. */
function bodyOf(row: { body: unknown }): Record<string, any> {
  return typeof row.body === 'string'
    ? JSON.parse(row.body)
    : (row.body as Record<string, any>);
}

function revocationBody() {
  return {
    status: 'REVOKED' as const,
    profileNamespaceId: 0,
    profileRev: 3,
    note: '',
    statusChangedAt: Date.now(),
    expiresAt: null,
  };
}

describe('mirror group intent application', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let applier: MirrorGroupMembershipIntentService;
  let sequence = 0;
  const businessLocks: string[] = [];
  let group: GroupRef;

  async function run(
    member: MemberRef,
    item: Parameters<MirrorGroupMembershipIntentService['execute']>[0]['body'],
  ) {
    return applier.execute({
      group,
      memberAccount: member.account,
      body: item,
    });
  }

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Schedulers stay stopped: the committed outbox is the assertion surface.
    app = fixture.createNestApplication(new FastifyAdapter());
    database = app.get(DatabaseService);
    applier = new MirrorGroupMembershipIntentService(
      withBusinessLockCapture(database, businessLocks),
      app.get(ClientStateFeedService),
      app.get(PeerStateFeedService),
      app.get(FederationStateFeedPushService),
      app.get(GroupRelationshipMutationService),
    );
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      ORIGIN_DOMAIN,
    );
    group = { account: GROUP_ACCOUNT, domain: ORIGIN_DOMAIN, namespaceId };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  async function member(prefix: string): Promise<MemberRef> {
    const seeded = await seedUser(app, `mirror-${prefix}-${++sequence}`);
    return { id: seeded.id, account: seeded.account };
  }

  /** One mirror shell exists per group identity; a fresh domain+namespace per
   * test keeps shells, threads, feeds, and task scopes isolated. */
  async function freshGroup(): Promise<void> {
    const domain = `mirror-origin-${process.pid}-${++sequence}.example`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    group = { account: GROUP_ACCOUNT, domain, namespaceId };
  }

  async function findPair(memberAccount: string) {
    const pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(tables.relationshipPair.kind, 'GROUP_MEMBER'),
        eq(tables.relationshipPair.endpointAType, 'USER'),
        eq(tables.relationshipPair.endpointAAccount, memberAccount),
        eq(tables.relationshipPair.endpointANamespaceId, 0),
        eq(tables.relationshipPair.endpointBType, 'GROUP'),
        eq(tables.relationshipPair.endpointBAccount, group.account),
        eq(tables.relationshipPair.endpointBNamespaceId, group.namespaceId),
      ),
    });
    // The group account's '!' prefix sorts before member accounts, matching
    // the historical group-authored (side A) first ordering.
    const intents = pair
      ? await database.db.query.relationshipIntent
          .findMany({
            where: or(
              and(
                eq(tables.relationshipIntent.authorAccount, group.account),
                eq(
                  tables.relationshipIntent.authorNamespaceId,
                  group.namespaceId,
                ),
                eq(tables.relationshipIntent.receiverAccount, memberAccount),
                eq(tables.relationshipIntent.receiverNamespaceId, 0),
              ),
              and(
                eq(tables.relationshipIntent.authorAccount, memberAccount),
                eq(tables.relationshipIntent.authorNamespaceId, 0),
                eq(tables.relationshipIntent.receiverAccount, group.account),
                eq(
                  tables.relationshipIntent.receiverNamespaceId,
                  group.namespaceId,
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
    return {
      pair,
      intents,
      sideA: intents.find((i) => i.authorAccount === group.account),
    };
  }

  async function requestRows(userId: number) {
    const user = await database.db.query.account.findFirst({
      where: eq(tables.account.id, userId),
    });
    if (!user) throw new Error('missing request-history reader');
    return database.db.query.relationshipRequest.findMany({
      where: or(
        and(
          eq(tables.relationshipRequest.kind, 'GROUP_INVITATION'),
          eq(tables.relationshipRequest.authorAccount, group.account),
          eq(tables.relationshipRequest.authorNamespaceId, group.namespaceId),
          eq(tables.relationshipRequest.receiverAccount, user.account),
          eq(tables.relationshipRequest.receiverNamespaceId, 0),
        ),
        and(
          eq(tables.relationshipRequest.kind, 'GROUP_APPLICATION'),
          eq(tables.relationshipRequest.authorAccount, user.account),
          eq(tables.relationshipRequest.authorNamespaceId, 0),
          eq(tables.relationshipRequest.receiverAccount, group.account),
          eq(tables.relationshipRequest.receiverNamespaceId, group.namespaceId),
        ),
      ),
      orderBy: desc(tables.relationshipRequest.id),
    });
  }

  async function peerItems(namespaceId: number) {
    return database.db.query.peerStateFeed.findMany({
      where: eq(tables.peerStateFeed.namespaceId, namespaceId),
      orderBy: desc(tables.peerStateFeed.feedId),
    });
  }

  /** The local join/leave boundaries minted at intent time on this mirror. */
  function boundaryMessages(threadId: number, marker: string) {
    return database.db.query.message.findMany({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.contentType, 'SYSTEM'),
        sql`${tables.message.content}::text like ${`%${marker}%`}`,
      ),
      orderBy: tables.message.seq,
    });
  }

  it('records a cold stranger invitation: shell anchor, inactive pair, intent and request history', async () => {
    await freshGroup();
    const bob = await member('cold');
    const { routed } = await run(bob, invitationBody());
    expect(routed).toBe('recorded-request');
    const { pair, sideA } = await findPair(bob.account);
    expect(pair).toBeDefined();
    expect(pair!.active).toBe(false);
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, pair!.threadId!),
    });
    expect(thread).toMatchObject({
      type: 'GROUP',
      groupAccount: group.account,
      authorityNamespaceId: group.namespaceId,
    });
    expect(sideA).toMatchObject({
      status: 'REQUESTED',
      note: 'join us',
      profileRev: 3,
      messageEndSeq: 5,
      tombstoneEndSeq: 1,
    });
    const requests = await requestRows(bob.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'GROUP_INVITATION',
      status: 'REQUESTED',
      note: 'join us',
      authorAccount: group.account,
      authorNamespaceId: group.namespaceId,
      receiverAccount: bob.account,
      receiverNamespaceId: 0,
      authorProfileNamespaceId: 0,
      authorProfileRev: 3,
      snapshot: null,
    });
    expect(sideA!.requestId).toBe(requests[0].id);
    // A request record is not a thread or a Group Meta roster fact.
    expect(requests[0]).not.toHaveProperty('threadId');
    expect(
      await database.db.query.groupMetaMemberFeed.findMany({
        where: eq(tables.groupMetaMemberFeed.threadId, pair!.threadId!),
      }),
    ).toHaveLength(0);
  });

  it('declines an exact mirror invitation without rewriting the remote intent or incoming head', async () => {
    await freshGroup();
    const bob = await member('exact-decline');
    await run(bob, invitationBody());
    const before = await findPair(bob.account);
    const [round] = await requestRows(bob.id);
    const head = await database.db.query.account.findFirst({
      where: eq(tables.account.id, bob.id),
      columns: { requestEndId: true, clientStateFeedEndId: true },
    });
    const service = app.get(MemberAuthoredGroupMembershipIntentService);
    vi.spyOn(
      app.get(FederationStateFeedPushService),
      'pushStateFeedNamespaces',
    ).mockResolvedValue(undefined);
    const command = {
      threadId: before.pair!.threadId!,
      memberUserId: bob.id,
      decision: 'REVOKED' as const,
    };
    const options = {
      requestDecision: { requestId: round.id, decision: 'REJECT' as const },
    };
    expect(await service.execute(command, options)).toEqual({
      status: 'APPLIED',
    });
    const after = await findPair(bob.account);
    expect(after.pair!.active).toBe(false);
    expect(after.sideA).toEqual(before.sideA);
    expect(
      after.intents.find((i) => i.authorAccount === bob.account),
    ).toMatchObject({ status: 'REVOKED', expiresAt: null });
    const [closed] = await requestRows(bob.id);
    expect(closed).toMatchObject({ id: round.id, status: 'REJECTED' });
    expect(
      await database.db.query.account.findFirst({
        where: eq(tables.account.id, bob.id),
        columns: { requestEndId: true, clientStateFeedEndId: true },
      }),
    ).toEqual(head);
    expect(
      await boundaryMessages(before.pair!.threadId!, 'GROUP_LEFT'),
    ).toHaveLength(0);
    expect(await service.execute(command, options)).toEqual({
      status: 'STALE_REQUEST',
    });
    expect((await requestRows(bob.id))[0]).toEqual(closed);
  });

  it('suppresses a replayed identical invitation (no write, no wake)', async () => {
    await freshGroup();
    const bob = await member('replay');
    const item = invitationBody();
    await run(bob, item);
    const before = await requestRows(bob.id);
    const headBefore = await database.db.query.account.findFirst({
      where: eq(tables.account.id, bob.id),
      columns: { requestEndId: true, clientStateFeedEndId: true },
    });
    const { routed } = await run(bob, item);
    expect(routed).toBe('recorded-request');
    expect(await requestRows(bob.id)).toEqual(before);
    expect(
      await database.db.query.account.findFirst({
        where: eq(tables.account.id, bob.id),
        columns: { requestEndId: true, clientStateFeedEndId: true },
      }),
    ).toEqual(headBefore);
  });

  it('no-ops an already expired invitation item', async () => {
    await freshGroup();
    const bob = await member('expired');
    const { routed } = await run(
      bob,
      invitationBody({
        statusChangedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        expiresAt: Date.now() - 24 * 60 * 60 * 1000,
      }),
    );
    expect(routed).toBe('noop:expired-request');
    expect(await findPair(bob.account)).toMatchObject({ pair: undefined });
  });

  it('completes a dangling acceptance on a received ACK: activation, sync state, ack-back', async () => {
    await freshGroup();
    const bob = await member('dangling');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    // The member accepted on this server: side B ACCEPTED authored locally,
    // pair still inactive — the origin's confirmation is pending.
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'ACCEPTED',
      profileRev: 1,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: null,
    });
    const ackItem = acceptanceBody();
    const { routed } = await run(bob, ackItem);
    expect(routed).toBe('completion');
    const after = await findPair(bob.account);
    expect(after.pair!.active).toBe(true);
    expect(after.pair!.established).toBe(true);
    expect(after.sideA).toMatchObject({ status: 'ACCEPTED', note: 'join us' });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, pair!.threadId!),
    });
    expect(thread!.federationRoundsEnabled).toBe(true);
    const ats = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, pair!.threadId!),
        eq(tables.accountThreadState.accountId, bob.id),
      ),
    });
    expect(ats).toBeDefined();
    const syncState =
      await database.db.query.federationThreadSyncState.findFirst({
        where: and(
          eq(tables.federationThreadSyncState.threadId, pair!.threadId!),
          eq(tables.federationThreadSyncState.namespaceId, group.namespaceId),
        ),
      });
    expect(syncState).toMatchObject({
      messageTargetSeq: 5,
      deletionTargetSeq: 1,
    });
    // The ack-back is a side-B ACCEPTED peer item authored by the member,
    // addressed to the origin group.
    const ack = (await peerItems(group.namespaceId)).find(
      (item) => bodyOf(item).status === 'ACCEPTED',
    );
    expect(ack).toBeDefined();
    expect(ack).toMatchObject({
      account: bob.account,
      namespaceId: group.namespaceId,
      subjectAccount: group.account,
      subjectNamespaceId: group.namespaceId,
    });
    const requests = await requestRows(bob.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'GROUP_INVITATION',
      status: 'ACCEPTED',
      authorAccount: group.account,
      authorNamespaceId: group.namespaceId,
      receiverAccount: bob.account,
      receiverNamespaceId: 0,
      authorProfileNamespaceId: 0,
      authorProfileRev: 3,
    });
    // The authoritative Group Meta delta will announce this join.
    const joins = await boundaryMessages(pair!.threadId!, 'GROUP_JOINED');
    expect(joins).toHaveLength(0);
    // A late duplicate ACK lands on the rostered no-op — never a write-back.
    const replay = await run(bob, ackItem);
    expect(replay.routed).toBe('noop:already-member');
  });

  it('promotes a live application on a received ACK (collapse path)', async () => {
    await freshGroup();
    const bob = await member('collapse');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    expect(pair).toBeDefined();
    // The member applied first; the invitation crossed it in flight.
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'REQUESTED',
      profileRev: 1,
      note: 'let me in',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: new Date(msFromNow(6)),
    });
    const { routed } = await run(bob, acceptanceBody());
    expect(routed).toBe('activated');
    const after = await findPair(bob.account);
    expect(after.pair!.active).toBe(true);
    const sideB = after.intents.find((i) => i.authorAccount === bob.account);
    // The acknowledgement conclusion rewrites side B with its own empty note.
    expect(sideB).toMatchObject({ status: 'ACCEPTED' });
    expect(sideB!.expiresAt).toBeNull();
  });

  it('completes a dangling acceptance on a fresh REQUESTED (re-invite auto-completes)', async () => {
    await freshGroup();
    const bob = await member('reinvite');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'ACCEPTED',
      profileRev: 1,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: null,
    });
    const { routed } = await run(bob, invitationBody());
    expect(routed).toBe('completion');
    const after = await findPair(bob.account);
    expect(after.pair!.active).toBe(true);
    expect(after.sideA!.status).toBe('REQUESTED');
    const ackItem = acceptanceBody();
    const confirmed = await run(bob, ackItem);
    expect(confirmed.routed).toBe('confirmed');
    expect((await findPair(bob.account)).sideA).toMatchObject({
      status: 'ACCEPTED',
      expiresAt: null,
    });
    expect(
      await boundaryMessages(pair!.threadId!, 'GROUP_JOINED'),
    ).toHaveLength(0);
    expect((await run(bob, ackItem)).routed).toBe('noop:already-member');
  });

  it('retains a late group ACK without republishing an already withdrawn member direction', async () => {
    await freshGroup();
    const bob = await member('mismatch');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    expect(pair).toBeDefined();
    // The member withdrew before the origin's acceptance landed.
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'REVOKED',
      profileRev: 1,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: null,
    });
    const outboundBefore = await peerItems(group.namespaceId);
    const [namespaceBefore] = await database.db
      .select({ endId: tables.federationFeedState.outboundStateFeedEndId })
      .from(tables.federationFeedState)
      .where(eq(tables.federationFeedState.namespaceId, group.namespaceId));
    const ackItem = acceptanceBody();
    const { routed } = await run(bob, ackItem);
    expect(routed).toBe('noop:dropped-ack');
    const after = await findPair(bob.account);
    expect(after.pair!.active).toBe(false);
    expect(after.sideA!.status).toBe('ACCEPTED');
    expect(
      after.intents.find((intent) => intent.authorAccount === bob.account)
        ?.status,
    ).toBe('REVOKED');
    expect(await peerItems(group.namespaceId)).toEqual(outboundBefore);
    const [namespaceAfter] = await database.db
      .select({ endId: tables.federationFeedState.outboundStateFeedEndId })
      .from(tables.federationFeedState)
      .where(eq(tables.federationFeedState.namespaceId, group.namespaceId));
    expect(namespaceAfter!.endId).toBe(namespaceBefore!.endId);
    expect((await run(bob, ackItem)).routed).toBe('noop:dropped-ack');
  });

  it('concludes a dangling acceptance on a received REVOKE without departure effects', async () => {
    await freshGroup();
    const bob = await member('conclusion');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'ACCEPTED',
      profileRev: 1,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: null,
    });
    const { routed } = await run(bob, revocationBody());
    expect(routed).toBe('dangling-conclusion');
    const after = await findPair(bob.account);
    // Side A revoked, side B concluded by the reverse task's contract, pair
    // never activated, and — critically — no GROUP_LEFT or roster MEMBER_DEPART was
    // written by the applier.
    expect(after.pair!.active).toBe(false);
    expect(after.sideA!.status).toBe('REVOKED');
    expect(
      await database.db.query.message.findMany({
        where: eq(tables.message.threadId, pair!.threadId!),
      }),
    ).toHaveLength(0);
    expect(
      await database.db.query.groupMetaMemberFeed.findMany({
        where: eq(tables.groupMetaMemberFeed.threadId, pair!.threadId!),
      }),
    ).toHaveLength(0);
    expect(
      after.intents.find((intent) => intent.authorAccount === bob.account)
        ?.status,
    ).toBe('REVOKED');
    const requests = await requestRows(bob.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'GROUP_INVITATION',
      status: 'WITHDRAWN',
      authorAccount: group.account,
      authorNamespaceId: group.namespaceId,
      receiverAccount: bob.account,
      receiverNamespaceId: 0,
    });
  });

  it('persists WITHDRAWN/INCOMING when a mirror invitation is revoked', async () => {
    await freshGroup();
    const bob = await member('withdraw-invite');
    await run(bob, invitationBody());
    await run(bob, revocationBody());
    const requests = await requestRows(bob.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'GROUP_INVITATION',
      status: 'WITHDRAWN',
      authorAccount: group.account,
      authorNamespaceId: group.namespaceId,
      receiverAccount: bob.account,
      receiverNamespaceId: 0,
    });
  });

  it('concludes a live application on rejection and permits a new request', async () => {
    await freshGroup();
    const bob = await member('rejection');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    const statusChangedAt = new Date();
    const expiresAt = new Date(msFromNow(6));
    // Explicit authored-round fixture: do not synthesize historical evidence
    // from a received REVOKED item that carries no request evidence.
    const [application] = await database.db
      .insert(tables.relationshipRequest)
      .values({
        kind: 'GROUP_APPLICATION',
        status: 'REQUESTED',
        authorAccount: bob.account,
        authorNamespaceId: 0,
        receiverAccount: group.account,
        receiverNamespaceId: group.namespaceId,
        authorProfileNamespaceId: 0,
        authorProfileRev: 1,
        snapshot: { displayName: 'Group at application', avatar: null },
        note: 'let me in',
        requestedAt: statusChangedAt,
        expiresAt,
      })
      .returning();
    await database.db.insert(tables.relationshipIntent).values({
      requestId: application.id,
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'REQUESTED',
      profileRev: 1,
      note: 'let me in',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt,
      expiresAt,
    });
    const { routed } = await run(bob, revocationBody());
    expect(routed).toBe('application-rejected');
    const after = await findPair(bob.account);
    expect(after.sideA!.status).toBe('REVOKED');
    const sideB = after.intents.find((i) => i.authorAccount === bob.account);
    expect(sideB!.status).toBe('REVOKED');
    const history = await requestRows(bob.id);
    expect(history.filter((row) => row.kind === 'GROUP_APPLICATION')).toEqual([
      expect.objectContaining({
        id: application.id,
        status: 'REJECTED',
        authorAccount: bob.account,
        authorNamespaceId: 0,
        receiverAccount: group.account,
        receiverNamespaceId: group.namespaceId,
      }),
    ]);

    const concluded = (await findPair(bob.account)).intents;
    const outbound = await peerItems(group.namespaceId);
    await run(bob, revocationBody());
    expect((await findPair(bob.account)).intents).toEqual(concluded);
    expect(await peerItems(group.namespaceId)).toEqual(outbound);
    expect(await requestRows(bob.id)).toEqual(history);
    await database.db.transaction((tx) =>
      app
        .get(GroupRelationshipMutationService)
        .writeMemberRelationshipIntentInTx(
          tx,
          pair!.threadId!,
          bob.id,
          'REQUESTED',
          [],
          'new application',
          {
            snapshot: { displayName: 'Group on new application', avatar: null },
          },
        ),
    );
    const renewed = await findPair(bob.account);
    expect(
      renewed.intents.find((intent) => intent.authorAccount === bob.account),
    ).toMatchObject({ status: 'REQUESTED', note: 'new application' });
  });

  it('allows a local mirror member to rejoin while the old Group Meta roster still shows them', async () => {
    await freshGroup();
    const bob = await member('stale-roster-rejoin');
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: bob.account,
      authorNamespaceId: 0,
      receiverAccount: group.account,
      receiverNamespaceId: group.namespaceId,
      profileNamespaceId: 0,
      status: 'ACCEPTED',
      profileRev: 1,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      statusChangedAt: new Date(),
      expiresAt: null,
    });
    await run(bob, acceptanceBody());
    expect((await findPair(bob.account)).pair?.active).toBe(true);
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId: pair!.threadId!,
      feedId: 1,
      operation: 'MEMBER_UPSERT',
      body: {
        account: bob.account,
        namespaceId: 0,
        role: 'MEMBER',
        profileRev: 1,
      },
    });
    const authored = app.get(MemberAuthoredGroupMembershipIntentService);
    expect(
      await authored.execute({
        threadId: pair!.threadId!,
        memberUserId: bob.id,
        decision: 'REVOKED',
      }),
    ).toMatchObject({ status: 'APPLIED' });
    expect((await findPair(bob.account)).pair?.active).toBe(false);
    expect(
      await authored.execute({
        threadId: pair!.threadId!,
        memberUserId: bob.id,
        decision: 'REQUESTED',
        snapshot: { displayName: 'Group at rejoin', avatar: null },
      }),
    ).toMatchObject({ status: 'APPLIED' });
    const rejoined = await findPair(bob.account);
    expect(rejoined.pair?.active).toBe(true);
    expect(
      rejoined.intents.find((intent) => intent.authorAccount === bob.account),
    ).toMatchObject({ status: 'ACCEPTED' });
  });

  it('consumes a content head before the approval of a departed member reapplication', async () => {
    await freshGroup();
    const bob = await member('head-before-rejoin');
    await run(bob, invitationBody());
    const authored = app.get(MemberAuthoredGroupMembershipIntentService);
    const { pair } = await findPair(bob.account);
    const threadId = pair!.threadId!;
    await authored.execute({
      threadId,
      memberUserId: bob.id,
      decision: 'ACCEPTED',
    });
    await run(bob, acceptanceBody());
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      operation: 'MEMBER_UPSERT',
      body: {
        account: bob.account,
        namespaceId: 0,
        role: 'MEMBER',
        profileRev: 1,
      },
    });
    await authored.execute({
      threadId,
      memberUserId: bob.id,
      decision: 'REVOKED',
    });
    await run(bob, revocationBody());
    await authored.execute({
      threadId,
      memberUserId: bob.id,
      decision: 'REQUESTED',
      snapshot: { displayName: 'Group at reapplication', avatar: null },
    });
    expect((await findPair(bob.account)).pair?.active).toBe(false);
    const retained = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, threadId),
        eq(tables.accountThreadState.accountId, bob.id),
      ),
    });
    expect(retained).toBeDefined();
    const beforeThread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
    });
    const beforeSync =
      await database.db.query.federationThreadSyncState.findFirst({
        where: and(
          eq(tables.federationThreadSyncState.threadId, threadId),
          eq(tables.federationThreadSyncState.namespaceId, group.namespaceId),
        ),
      });
    expect(beforeThread?.federationRoundsEnabled).toBe(true);
    expect(beforeSync?.authorizationEpoch).not.toBe(
      beforeThread?.authorizationEpoch,
    );
    const consumer = app.get(FederationStateFeedConsumerService);
    // A page boundary prevents the consumer's within-page intent prioritization
    // from moving the later approval ahead of this already-advertised head.
    const head = await database.db.transaction((tx) =>
      consumer.applyPageInTx(tx, group.domain, group.namespaceId, {
        items: [
          {
            account: group.account,
            eventType: 'THREAD_CONTENT_HEAD',
            feedId: '1',
            generatedAt: 0,
            body: {
              messageEndSeq: 7,
              tombstoneEndSeq: 1,
              groupMetaFeedEndId: 4,
            },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        profileNamespaceFeedEndId: '0',
        hasMore: false,
      }),
    );
    expect(
      head.threadRoundWakes.some((wake) => wake.direction === 'forward'),
    ).toBe(false);
    expect((await findPair(bob.account)).pair?.active).toBe(false);
    const accepted = acceptanceBody({ messageEndSeq: 7 });
    const result = await database.db.transaction((tx) =>
      consumer.applyPageInTx(tx, group.domain, group.namespaceId, {
        items: [
          {
            account: group.account,
            peerAccount: bob.account,
            eventType: 'RELATIONSHIP_INTENT',
            feedId: '2',
            generatedAt: 0,
            body: wireBody(accepted),
          },
        ],
        scannedThrough: '2',
        stateFeedEndId: '2',
        profileNamespaceFeedEndId: '0',
        hasMore: false,
      }),
    );
    expect((await findPair(bob.account)).pair?.active).toBe(true);
    expect(result.threadRoundWakes).toContainEqual({
      threadId,
      peerDomain: group.domain,
      namespaceId: group.namespaceId,
      direction: 'both',
    });
    const state = await database.db.query.federationThreadSyncState.findFirst({
      where: and(
        eq(tables.federationThreadSyncState.threadId, threadId),
        eq(tables.federationThreadSyncState.namespaceId, group.namespaceId),
      ),
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
    });
    expect(state?.authorizationEpoch).toBe(thread?.authorizationEpoch);
    expect(state?.messageTargetSeq).toBe(7);
  });

  it.each(['absent', 'MEMBER_UPSERT', 'MEMBER_DEPART'] as const)(
    'kicks without depending on Meta (%s): epoch advances only for the last member',
    async (metaState) => {
      await freshGroup();
      const alice = await member('kick-a');
      const bob = await member('kick-b');
      // Intent activation does not require a replicated roster. Exercise missing,
      // active, and already-departed Meta without letting it own the transition.
      await run(alice, invitationBody());
      const { pair: alicePair } = await findPair(alice.account);
      const threadId = alicePair!.threadId!;
      let rosterFeedId = 100;
      for (const m of [alice, bob]) {
        if (metaState !== 'absent')
          await database.db.insert(tables.groupMetaMemberFeed).values({
            threadId,
            feedId: rosterFeedId++,
            operation: metaState,
            body: {
              account: m.account,
              namespaceId: 0,
              role: 'MEMBER',
              profileRev: 99,
            },
          });
        await database.db.insert(tables.accountThreadState).values({
          accountId: m.id,
          threadId,
          role: 'MEMBER',
          lastReadSeq: 0,
        });
      }
      await database.db.insert(tables.relationshipPair).values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'USER',
        endpointAAccount: bob.account,
        endpointANamespaceId: 0,
        endpointBType: 'GROUP',
        endpointBAccount: group.account,
        endpointBNamespaceId: group.namespaceId,
        threadId,
        active: true,
        established: true,
      });
      await database.db.insert(tables.relationshipIntent).values([
        {
          authorAccount: group.account,
          authorNamespaceId: group.namespaceId,
          receiverAccount: bob.account,
          receiverNamespaceId: 0,
          profileNamespaceId: group.namespaceId,
          status: 'ACCEPTED',
          profileRev: 3,
          note: '',
          messageEndSeq: 5,
          tombstoneEndSeq: 1,
          statusChangedAt: new Date(),
          expiresAt: null,
        },
        {
          authorAccount: bob.account,
          authorNamespaceId: 0,
          receiverAccount: group.account,
          receiverNamespaceId: group.namespaceId,
          profileNamespaceId: 0,
          status: 'ACCEPTED',
          profileRev: 1,
          note: '',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          statusChangedAt: new Date(),
          expiresAt: null,
        },
      ]);
      // Activate Alice's pair the same way for the epoch gate: her acceptance is
      // pending (side B ACCEPTED seeded), the origin's ACK completes it.
      const aliceSideB = {
        authorAccount: alice.account,
        authorNamespaceId: 0,
        receiverAccount: group.account,
        receiverNamespaceId: group.namespaceId,
        profileNamespaceId: 0,
        status: 'ACCEPTED' as const,
        profileRev: 1,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        statusChangedAt: new Date(),
        expiresAt: null,
      };
      await database.db.insert(tables.relationshipIntent).values(aliceSideB);
      await run(alice, acceptanceBody());
      const epochBefore = (await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
      }))!.authorizationEpoch;

      const metaBefore = await database.db.query.groupMetaMemberFeed.findMany({
        where: eq(tables.groupMetaMemberFeed.threadId, threadId),
      });
      const metaFeed = app.get(ClientGroupMetaFeedService);
      await expect(
        metaFeed.resolveVisibleGroup(alice.id, { threadId }),
      ).resolves.toMatchObject({ groupId: threadId });
      const acceptedHistory = await requestRows(alice.id);
      expect(acceptedHistory).toHaveLength(1);
      expect(acceptedHistory[0].status).toBe('ACCEPTED');
      // Changing the current local profile must not replace request evidence.
      await database.db
        .update(tables.account)
        .set({ defaultProfileRev: 55 })
        .where(eq(tables.account.id, alice.id));
      await run(alice, revocationBody());
      await expect(
        metaFeed.resolveVisibleGroup(alice.id, { threadId }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
      for (const mode of ['full', 'delta'] as const) {
        await expect(
          metaFeed.serve(alice.id, threadId, group.account, mode, 0, 100),
        ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
      }
      await expect(
        metaFeed.resolveVisibleGroup(bob.id, { threadId }),
      ).resolves.toMatchObject({ groupId: threadId });
      expect((await findPair(alice.account)).pair!.active).toBe(false);
      let thread = (await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
      }))!;
      // Bob's pair is still active: the epoch must not advance yet.
      expect(thread.authorizationEpoch).toBe(epochBefore);
      // The received REVOKED intent owns the local departure notice and boundary.
      const aliceNotices = await boundaryMessages(threadId, 'GROUP_LEFT');
      expect(aliceNotices).toHaveLength(1);
      expect(JSON.parse(aliceNotices[0]!.content).member).toEqual({
        account: alice.account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
      } satisfies ProfiledAddress);

      await run(bob, revocationBody());
      expect(
        await database.db.query.groupMetaMemberFeed.findMany({
          where: eq(tables.groupMetaMemberFeed.threadId, threadId),
        }),
      ).toEqual(metaBefore);
      expect((await findPair(bob.account)).pair!.active).toBe(false);
      thread = (await database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
      }))!;
      expect(thread.authorizationEpoch).toBe(epochBefore + 1);
      expect(thread.federationRoundsEnabled).toBe(false);
      expect(
        (await findPair(alice.account)).intents.every(
          (i) => i.status === 'REVOKED',
        ),
      ).toBe(true);
      expect(
        (await findPair(bob.account)).intents.every(
          (i) => i.status === 'REVOKED',
        ),
      ).toBe(true);
      const notices = await boundaryMessages(threadId, 'GROUP_LEFT');
      expect(notices).toHaveLength(2);
      expect(
        notices.map(
          (notice) => JSON.parse(notice.content as string).member.account,
        ),
      ).toEqual([alice.account, bob.account]);
      // Departure is a membership operation, not a request conclusion.
      expect(await requestRows(alice.id)).toEqual(acceptedHistory);
    },
  );

  it('keeps positive origin facts applying to a dissolved mirror and re-forms membership', async () => {
    await freshGroup();
    const bob = await member('edges');
    expect(
      (
        await applier.execute({
          group,
          memberAccount: bob.account,
          body: acceptanceBody(),
        })
      ).routed,
    ).toBe('noop:no-mirror-anchor');
    // Seed a dissolved shell.
    await run(bob, invitationBody());
    const { pair } = await findPair(bob.account);
    await database.db
      .update(tables.messageThread)
      .set({ groupDissolvedAt: new Date() })
      .where(eq(tables.messageThread.id, pair!.threadId!));
    // A dissolved mirror is bookkeeping for lost read access, not a terminal
    // group: positive origin facts keep applying. An acceptance without a live
    // member direction records itself and repairs with the system REVOKED
    // write-back instead of no-oping on the dissolution.
    expect((await run(bob, acceptanceBody())).routed).toBe('mismatch');
    expect((await run(bob, invitationBody())).routed).toBe('recorded-request');
    expect((await run(bob, revocationBody())).routed).toBe('rejected');
  });

  it('locks the authority-domain group scope before the pair scope', async () => {
    await freshGroup();
    businessLocks.length = 0;
    const bob = await member('locks');
    await run(bob, invitationBody());
    const groupIndex = businessLocks.findIndex(
      (key) =>
        key ===
        businessAccountScopeKey({
          account: group.account,
          profileNamespaceId: group.namespaceId,
        }),
    );
    const pairIndex = businessLocks.findIndex((key) =>
      key.includes('GROUP_MEMBER'),
    );
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(pairIndex).toBeGreaterThan(groupIndex);
  });
});
