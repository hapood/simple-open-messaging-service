import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, or, sql } from 'drizzle-orm';
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
    expect(lookup.text).not.toContain('"relationship"');
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
    expect(lookup.text).not.toContain('"relationship"');

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

    const aliceNamespaceOnB =
      (await appB.database.query.identityNamespace.findFirst({
        where: eq(identityNamespace.domain, FED_DOMAIN_A),
      }))!;
    const incoming = await vi.waitFor(
      async () => {
        const rows = await appB.database.execute<{
          requestedAt: Date;
          expiresAt: Date;
        }>(sql`
          SELECT intent."requestedAt", intent."expiresAt"
          FROM "RelationshipIntent" intent
          WHERE intent.status = 'REQUESTED'
            AND intent."authorAccount" = 'address-alice'
            AND intent."authorNamespaceId" = ${aliceNamespaceOnB.id}
            AND intent."receiverAccount" = 'address-bob'
            AND intent."receiverNamespaceId" = 0
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
        const remoteNamespaceId = pairB!.endpointBNamespaceId;
        expect(JSON.parse(acceptingSideNotice!.content).participants).toEqual(
          expect.arrayContaining([
            {
              account: 'address-alice',
              domain: FED_DOMAIN_A,
              namespaceId: remoteNamespaceId,
              profileRev: expect.any(Number),
            },
            {
              account: 'address-bob',
              domain: 'local',
              namespaceId: 0,
              profileRev: expect.any(Number),
            },
          ]),
        );

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
          eq(
            relationshipIntent.authorAccount,
            relationship.firstEndpoint.account,
          ),
          eq(
            relationshipIntent.authorNamespaceId,
            relationship.firstEndpoint.namespaceId,
          ),
          eq(
            relationshipIntent.receiverAccount,
            relationship.secondEndpoint.account,
          ),
          eq(
            relationshipIntent.receiverNamespaceId,
            relationship.secondEndpoint.namespaceId,
          ),
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
          eq(relationshipIntent.authorAccount, mirrored.secondEndpoint.account),
          eq(
            relationshipIntent.authorNamespaceId,
            mirrored.secondEndpoint.namespaceId,
          ),
          eq(
            relationshipIntent.receiverAccount,
            mirrored.firstEndpoint.account,
          ),
          eq(
            relationshipIntent.receiverNamespaceId,
            mirrored.firstEndpoint.namespaceId,
          ),
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

  it('propagates a second rejection when the recipient direction is already revoked', async () => {
    const alice = await registerAndLogin(
      appA,
      'address-reject-alice',
      'Reject Alice',
    );
    const bob = await registerAndLogin(
      appB,
      'address-reject-bob',
      'Reject Bob',
    );
    const target = { account: bob.account, domain: FED_DOMAIN_B };
    const reverseTarget = { account: alice.account, domain: FED_DOMAIN_A };
    const send = async (note: string) => {
      const response = await request(appA.baseUrl)
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ ...target, displayName: 'Reject Bob', note });
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
    };
    const reject = async () => {
      const response = await request(appB.baseUrl)
        .post('/api/v1/relationship/revoke')
        .set('Authorization', `Bearer ${bob.token}`)
        .send(reverseTarget);
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
    };
    const requesterRequestFeed = () =>
      appA.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, alice.id),
          eq(clientStateFeed.account, alice.account),
          eq(clientStateFeed.subjectAccount, bob.account),
          eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    const requesterRevokeFeed = () =>
      appA.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, alice.id),
          eq(clientStateFeed.account, bob.account),
          eq(clientStateFeed.subjectAccount, alice.account),
          eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    const recipientFeed = () =>
      appB.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bob.id),
          eq(clientStateFeed.account, alice.account),
          eq(clientStateFeed.subjectAccount, bob.account),
          eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    const peerRevoke = () =>
      appB.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.account, bob.account),
          eq(peerStateFeed.subjectAccount, alice.account),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });

    const lookup = await request(appA.baseUrl)
      .get('/api/v1/user/resolve-federated-stream')
      .query(target)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Accept', 'text/event-stream');
    expect(lookup.status).toBe(200);
    expect(lookup.text).toContain('event: resolved');

    await send('first request');
    await vi.waitFor(
      async () => {
        expect((await recipientFeed())?.body).toMatchObject({
          status: 'REQUESTED',
          note: 'first request',
        });
      },
      { timeout: 15_000, interval: 100 },
    );
    await reject();
    const firstTerminal = await vi.waitFor(
      async () => {
        const row = await requesterRevokeFeed();
        expect(row?.body).toMatchObject({
          status: 'REVOKED',
          requestStatus: 'REJECTED',
          requestDirection: 'OUTGOING',
        });
        return row!;
      },
      { timeout: 15_000, interval: 100 },
    );
    const firstPeerRevoke = (await peerRevoke())!;

    await send('second request');
    await vi.waitFor(
      async () => {
        expect((await recipientFeed())?.body).toMatchObject({
          status: 'REQUESTED',
          note: 'second request',
        });
        expect((await requesterRequestFeed())?.body).toMatchObject({
          status: 'REQUESTED',
          note: 'second request',
        });
      },
      { timeout: 15_000, interval: 100 },
    );
    const secondPending = (await requesterRequestFeed())!;
    expect(secondPending.feedId).toBeGreaterThan(firstTerminal.feedId);
    await reject();
    const secondPeerRevoke = (await peerRevoke())!;
    expect(secondPeerRevoke.body).toEqual(firstPeerRevoke.body);
    expect(secondPeerRevoke.feedId).toBeGreaterThan(firstPeerRevoke.feedId);
    await vi.waitFor(
      async () => {
        const terminal = await requesterRevokeFeed();
        expect(terminal?.feedId).toBeGreaterThan(secondPending.feedId);
        expect(terminal?.body).toMatchObject({
          status: 'REVOKED',
          requestStatus: 'REJECTED',
          requestDirection: 'OUTGOING',
        });
      },
      { timeout: 15_000, interval: 100 },
    );
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
          where: or(
            and(
              eq(
                relationshipIntent.authorAccount,
                relationship.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relationship.groupEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relationship.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relationship.memberEndpoint.namespaceId,
              ),
            ),
            and(
              eq(
                relationshipIntent.authorAccount,
                relationship.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relationship.memberEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relationship.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relationship.groupEndpoint.namespaceId,
              ),
            ),
          ),
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
          where: or(
            and(
              eq(
                relationshipIntent.authorAccount,
                relation.firstEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relation.firstEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relation.secondEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relation.secondEndpoint.namespaceId,
              ),
            ),
            and(
              eq(
                relationshipIntent.authorAccount,
                relation.secondEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relation.secondEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relation.firstEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relation.firstEndpoint.namespaceId,
              ),
            ),
          ),
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
              eq(relationshipIntent.authorAccount, rel.secondEndpoint.account),
              eq(
                relationshipIntent.authorNamespaceId,
                rel.secondEndpoint.namespaceId,
              ),
              eq(relationshipIntent.receiverAccount, rel.firstEndpoint.account),
              eq(
                relationshipIntent.receiverNamespaceId,
                rel.firstEndpoint.namespaceId,
              ),
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
