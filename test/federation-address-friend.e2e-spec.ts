import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import {
  messageThread,
  clientStateFeed,
  federationThreadSyncState,
  message,
  accountThreadState,
  account as user,
  identityNamespace,
  peerStateFeed,
  relationshipIntent,
  userQuotaDailyUsage,
} from '../src/database/schema.js';
import { ContentType } from '../src/database/enums.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import { registerAndLogin } from './federation-test-helpers.js';
import { findGroupRelationship, findP2PRelationship } from './seed.js';

describe('federated Address friend requests', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceId: number;
  let bobId: number;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    ({ id: aliceId, token: aliceToken } = await registerAndLogin(
      appA,
      'address-alice',
      'Address Alice',
    ));
    ({ id: bobId, token: bobToken } = await registerAndLogin(
      appB,
      'address-bob',
      'Address Bob',
    ));
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('resolves an explicit own-domain address as a local user', async () => {
    const lookup = await request(appA.baseUrl)
      .get('/api/v1/user/resolve-federated-stream')
      .query({ account: 'address-alice', domain: FED_DOMAIN_A })
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Accept', 'text/event-stream');

    expect(lookup.status).toBe(200);
    expect(lookup.text).toContain('event: resolved');
    expect(lookup.text).toContain(`\"id\":${aliceId}`);
    expect(lookup.text).toContain('"domain":"local"');
    expect(lookup.text).not.toContain('event: progress');
  });

  it('keeps foreign identities address-based and establishes the requester thread after accept', async () => {
    const lookup = await request(appA.baseUrl)
      .get('/api/v1/user/resolve-federated-stream')
      .query({ account: 'address-bob', domain: FED_DOMAIN_B })
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Accept', 'text/event-stream');
    expect(lookup.status).toBe(200);
    expect(lookup.text).toContain('event: resolved');
    expect(lookup.text).toContain('"id":0');

    expect(
      await appA.database.query.account.findFirst({
        where: and(
          eq(user.account, 'address-bob'),
          eq(user.domain, FED_DOMAIN_B),
        ),
      }),
    ).toBeUndefined();

    const sent = await request(appA.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        account: 'address-bob',
        domain: FED_DOMAIN_B,
        displayName: 'Address Bob',
        note: 'address request',
      });
    expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
    // The addressed request is synchronous now: the intent, the shell, and the
    // peer feed item are committed when the request answers.
    expect(sent.body.data).toEqual({ status: 'OK' });
    const requesterStub = await appA.database.query.account.findFirst({
      where: and(
        eq(user.account, 'address-bob'),
        eq(user.domain, FED_DOMAIN_B),
      ),
    });
    expect(requesterStub).toBeUndefined();
    const [requesterShell] = await appA.database
      .select({ id: accountThreadState.id })
      .from(accountThreadState)
      .where(eq(accountThreadState.accountId, aliceId))
      .limit(1);
    expect(requesterShell).toBeDefined();

    const incoming = await vi.waitFor(
      async () => {
        const rows = await appB.database.execute<{
          requestedAt: Date;
          expiresAt: Date;
        }>(sql`
          SELECT intent."requestedAt", intent."expiresAt"
          FROM "RelationshipIntent" intent
          JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
          WHERE pair.kind = 'P2P' AND intent.status = 'REQUESTED'
            AND ((intent."authorSide" = 'A'
                AND pair."endpointAAccount" = 'address-alice'
                AND pair."endpointADomain" = ${FED_DOMAIN_A}
                AND pair."endpointBAccount" = 'address-bob'
                AND pair."endpointBDomain" = 'local')
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = 'address-alice'
                AND pair."endpointBDomain" = ${FED_DOMAIN_A}
                AND pair."endpointAAccount" = 'address-bob'
                AND pair."endpointADomain" = 'local'))
          LIMIT 1
        `);
        const row = rows.rows[0];
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(
      new Date(incoming.expiresAt).getTime() -
        new Date(incoming.requestedAt).getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);
    const pendingClientIntent =
      await appB.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bobId),
          eq(clientStateFeed.account, 'address-alice'),
          eq(clientStateFeed.domain, FED_DOMAIN_A),
          eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
          eq(clientStateFeed.subjectAccount, 'address-bob'),
        ),
      });
    expect(pendingClientIntent).toMatchObject({
      subjectDomain: 'local',
      body: expect.objectContaining({
        status: 'REQUESTED',
        direction: 'INCOMING',
        peer: expect.objectContaining({
          account: 'address-alice',
          domain: FED_DOMAIN_A,
        }),
      }),
    });
    const accepted = await request(appB.baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ account: 'address-alice', domain: FED_DOMAIN_A });
    expect(accepted.body.code, JSON.stringify(accepted.body)).toBe(
      BusinessCode.OK,
    );
    // The address-only acceptance activates synchronously on the accepting
    // side; the origin learns through the peer state-feed push.
    expect(accepted.body.data).toMatchObject({ status: 'OK' });
    expect(typeof accepted.body.data.threadId).toBe('number');

    await vi.waitFor(
      async () => {
        const [nsB, nsA] = await Promise.all([
          appA.database.query.identityNamespace.findFirst({
            where: eq(identityNamespace.domain, FED_DOMAIN_B),
          }),
          appB.database.query.identityNamespace.findFirst({
            where: eq(identityNamespace.domain, FED_DOMAIN_A),
          }),
        ]);
        const bobOnA = {
          account: 'address-bob',
          domain: FED_DOMAIN_B,
          namespaceId: nsB!.id,
        };
        const aliceOnB = {
          account: 'address-alice',
          domain: FED_DOMAIN_A,
          namespaceId: nsA!.id,
        };
        const [relationshipA, relationshipB] = await Promise.all([
          findP2PRelationship(appA.database, aliceId, bobOnA),
          findP2PRelationship(appB.database, bobId, aliceOnB),
        ]);
        const pairA = relationshipA.pair;
        const pairB = relationshipB.pair;
        expect(pairA).toBeDefined();
        expect(pairB).toBeDefined();
        expect(pairA?.active).toBe(true);
        expect(pairB?.active).toBe(true);
        for (const [app, pair] of [
          [appA, pairA],
          [appB, pairB],
        ] as const) {
          const state =
            await app.database.query.federationThreadSyncState.findFirst({
              where: eq(federationThreadSyncState.threadId, pair!.threadId!),
            });
          expect(state).toMatchObject({
            messageTargetSeq: 0,
            deletionTargetSeq: 0,
          });
        }

        const acceptingSideNotice = await appB.database.query.message.findFirst(
          {
            where: and(
              eq(message.threadId, pairB!.threadId!),
              eq(message.contentType, ContentType.SYSTEM),
              sql`${message.content}::text like '%FRIEND_ADDED%'`,
            ),
          },
        );
        expect(acceptingSideNotice).toBeDefined();

        const bobClientIntents =
          await appB.database.query.clientStateFeed.findMany({
            where: and(
              eq(clientStateFeed.userId, bobId),
              eq(clientStateFeed.account, 'address-alice'),
              eq(clientStateFeed.domain, FED_DOMAIN_A),
              eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
              eq(clientStateFeed.subjectAccount, 'address-bob'),
            ),
          });
        expect(bobClientIntents).toHaveLength(1);
        expect(bobClientIntents[0]).toMatchObject({
          subjectDomain: 'local',
          body: expect.objectContaining({
            status: 'ACCEPTED',
            direction: 'INCOMING',
          }),
        });
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it('refreshes and revokes an outgoing request without a foreign account row', async () => {
    const charlie = await registerAndLogin(appB, 'address-charlie', 'Charlie');
    const target = { account: charlie.account, domain: FED_DOMAIN_B };
    const send = async (note: string) => {
      const response = await request(appA.baseUrl)
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ...target, displayName: 'Charlie', note });
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
      expect(response.body.data).toEqual({ status: 'OK' });
    };
    await send('original request');
    const namespace = await appA.database.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, FED_DOMAIN_B),
    });
    const relationship = await findP2PRelationship(appA.database, aliceId, {
      ...target,
      namespaceId: namespace!.id,
    });
    const readRequest = () =>
      appA.database.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.pairId, relationship.pair!.id),
          eq(relationshipIntent.authorSide, relationship.firstSide),
        ),
      });
    const before = await readRequest();
    expect(before?.status).toBe('REQUESTED');
    const requestCount = async () => {
      const rows = await appA.database
        .select({
          count: sql<number>`COALESCE(SUM(${userQuotaDailyUsage.count}), 0)::integer`,
        })
        .from(userQuotaDailyUsage)
        .where(
          and(
            eq(userQuotaDailyUsage.userId, aliceId),
            eq(userQuotaDailyUsage.category, 'requests'),
          ),
        );
      return rows[0].count;
    };
    const usedBeforeRefresh = await requestCount();
    await send('updated request');
    expect(await requestCount()).toBe(usedBeforeRefresh + 1);
    const refreshed = await readRequest();
    expect(refreshed).toMatchObject({
      id: before!.id,
      status: 'REQUESTED',
      note: 'updated request',
    });
    expect(refreshed!.requestedAt!.getTime()).toBeGreaterThan(
      before!.requestedAt!.getTime(),
    );
    expect(refreshed!.expiresAt!.getTime()).toBeGreaterThan(
      before!.expiresAt!.getTime(),
    );
    expect(
      refreshed!.expiresAt!.getTime() - refreshed!.requestedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);

    const readMirroredRequest = async () => {
      const remoteNamespace =
        await appB.database.query.identityNamespace.findFirst({
          where: eq(identityNamespace.domain, FED_DOMAIN_A),
        });
      const mirrored = await findP2PRelationship(appB.database, charlie.id, {
        account: 'address-alice',
        domain: FED_DOMAIN_A,
        namespaceId: remoteNamespace!.id,
      });
      expect(mirrored.pair).toBeDefined();
      return await appB.database.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.pairId, mirrored.pair!.id),
          eq(relationshipIntent.authorSide, mirrored.secondSide),
        ),
      });
    };
    await vi.waitFor(
      async () => {
        expect(await readMirroredRequest()).toMatchObject({
          status: 'REQUESTED',
          note: 'updated request',
          requestedAt: refreshed!.requestedAt,
          expiresAt: refreshed!.expiresAt,
        });
      },
      { timeout: 10_000, interval: 100 },
    );

    const revoked = await request(appA.baseUrl)
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send(target);
    expect(revoked.body.code, JSON.stringify(revoked.body)).toBe(
      BusinessCode.OK,
    );
    // The local authoring side is synchronous now: the revocation (and its
    // peer feed item) is committed when the request answers.
    expect(revoked.body.data).toEqual({ status: 'OK' });
    expect((await readRequest())?.status).toBe('REVOKED');
    await vi.waitFor(
      async () => {
        expect((await readMirroredRequest())?.status).toBe('REVOKED');
      },
      { timeout: 10_000, interval: 100 },
    );
    for (const app of [appA, appB]) {
      expect(
        await app.database.query.account.findMany({
          where: sql`${user.domain} <> 'local' OR ${user.namespaceId} <> 0`,
        }),
      ).toEqual([]);
    }
  });
  it('converges a federated kick through a system-operated local member revoke', async () => {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'Reverse kick' });
    expect(created.body.code).toBe(BusinessCode.OK);
    const threadId = created.body.data.threadId as number;
    const group = (await appA.database.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    }))!;
    const invite = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        groupId: threadId,
        users: [{ account: 'address-bob', domain: FED_DOMAIN_B }],
      });
    expect(invite.body.code).toBe(BusinessCode.OK);
    const authoredInvite = await appA.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.account, group.groupAccount!),
        eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        eq(peerStateFeed.subjectAccount, 'address-bob'),
      ),
    });
    expect(authoredInvite?.body).toMatchObject({
      status: 'REQUESTED',
      messageEndSeq: expect.any(Number),
      tombstoneEndSeq: expect.any(Number),
    });
    const mirror = await vi.waitFor(
      async () => {
        const row = await appB.database.query.messageThread.findFirst({
          where: and(
            eq(messageThread.groupAccount, group.groupAccount!),
            eq(messageThread.groupDomain, FED_DOMAIN_A),
          ),
        });
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 15_000, interval: 100 },
    );
    const accepted = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ groupId: mirror.id });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    const ns = (await appA.database.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, FED_DOMAIN_B),
    }))!;
    const remote = {
      account: 'address-bob',
      domain: FED_DOMAIN_B,
      namespaceId: ns.id,
    };
    await vi.waitFor(
      async () => {
        const rel = await findGroupRelationship(
          appA.database,
          threadId,
          remote,
        );
        expect(rel.pair?.active).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const kicked = await request(appA.baseUrl)
      .post('/api/v1/group/kick')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        groupId: threadId,
        account: remote.account,
        domain: remote.domain,
      });
    expect(kicked.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirror.id,
          bobId,
        );
        expect(relationship.pair?.active).toBe(false);
        const intents = await appB.database.query.relationshipIntent.findMany({
          where: eq(relationshipIntent.pairId, relationship.pair!.id),
        });
        expect(intents).toHaveLength(2);
        expect(intents.every((intent) => intent.status === 'REVOKED')).toBe(
          true,
        );
        const leftRow = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.contentType, ContentType.SYSTEM),
            sql`${message.content}::text like '%GROUP_LEFT%'`,
          ),
        });
        expect(leftRow).toBeDefined();
        expect(
          await appB.database.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.threadId, mirror.id),
              eq(accountThreadState.accountId, bobId),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 60_000);

  it('concludes a received revocation inline and permits reauthorization', async () => {
    const target = { account: 'address-bob', domain: FED_DOMAIN_B };
    const revoke = await request(appA.baseUrl)
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send(target);
    expect(revoke.body.code).toBe(BusinessCode.OK);
    expect(revoke.body.data).toEqual({ status: 'OK' });
    expect(
      await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, FED_DOMAIN_B),
          eq(peerStateFeed.account, 'address-alice'),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, 'address-bob'),
        ),
      }),
    ).toBeUndefined();
    const nsOnA = (await appA.database.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, FED_DOMAIN_B),
    }))!;
    await vi.waitFor(
      async () => {
        const relation = await findP2PRelationship(appA.database, aliceId, {
          ...target,
          namespaceId: nsOnA.id,
        });
        const intents = await appA.database.query.relationshipIntent.findMany({
          where: eq(relationshipIntent.pairId, relation.pair!.id),
        });
        // The composed revocation already revoked both directions when the
        // request answered, so the peer's reverse lands as a convergence no-op:
        // the initiator side no longer enqueues a RESPOND_TO_REVOKE ack task.
        expect(intents).not.toHaveLength(0);
        expect(intents.every((intent) => intent.status === 'REVOKED')).toBe(
          true,
        );
        expect(relation.pair?.active).toBe(false);
      },
      { timeout: 20_000, interval: 100 },
    );
    const requested = await request(appA.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        ...target,
        displayName: 'Address Bob',
        note: 're-authorize after revoke',
      });
    expect(requested.body.code).toBe(BusinessCode.OK);
    expect(requested.body.data).toEqual({ status: 'OK' });
    const ns = (await appB.database.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, FED_DOMAIN_A),
    }))!;
    const peer = {
      account: 'address-alice',
      domain: FED_DOMAIN_A,
      namespaceId: ns.id,
    };
    await vi.waitFor(
      async () => {
        const rel = await findP2PRelationship(appB.database, bobId, peer);
        expect(
          await appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, rel.pair!.id),
              eq(relationshipIntent.authorSide, rel.secondSide),
            ),
          }),
        ).toMatchObject({ status: 'REQUESTED' });
      },
      { timeout: 15_000, interval: 100 },
    );
    const accepted = await request(appB.baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ account: peer.account, domain: peer.domain });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data).toMatchObject({ status: 'OK' });
    expect(
      (await findP2PRelationship(appB.database, bobId, peer)).pair?.active,
    ).toBe(true);
    await vi.waitFor(
      async () => {
        const [headOnA, headOnB] = await Promise.all([
          appA.database.query.peerStateFeed.findFirst({
            where: and(
              eq(peerStateFeed.peerDomain, FED_DOMAIN_B),
              eq(peerStateFeed.account, 'address-alice'),
              eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
              eq(peerStateFeed.subjectAccount, 'address-bob'),
            ),
          }),
          appB.database.query.peerStateFeed.findFirst({
            where: and(
              eq(peerStateFeed.peerDomain, FED_DOMAIN_A),
              eq(peerStateFeed.account, 'address-bob'),
              eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
              eq(peerStateFeed.subjectAccount, 'address-alice'),
            ),
          }),
        ]);
        expect(headOnA?.body).toMatchObject({
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
        });
        expect(headOnB?.body).toMatchObject({
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
        });
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 80_000);
});
