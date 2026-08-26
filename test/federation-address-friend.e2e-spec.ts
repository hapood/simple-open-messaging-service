import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  clientStateFeed,
  federatedFriendRequest,
  relationshipPair,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  truncateFederationDbs,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import { registerAndLogin } from './federation-test-helpers.js';

describe('federated Address friend request shells', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceId: number;
  let bobId: number;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);
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

  it('keeps lookup Address-based, creates the requester shell, and establishes after accept', async () => {
    const lookup = await request(appA.baseUrl)
      .get('/api/v1/user/resolve-federated-stream')
      .query({ account: 'address-bob', domain: FED_DOMAIN_B })
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Accept', 'text/event-stream');
    expect(lookup.status).toBe(200);
    expect(lookup.text).toContain('event: resolved');
    expect(lookup.text).toContain('"id":0');

    expect(
      await appA.database.query.user.findFirst({
        where: and(
          eq(user.account, 'address-bob'),
          eq(user.domain, FED_DOMAIN_B),
        ),
      }),
    ).toBeUndefined();

    const sent = await request(appA.baseUrl)
      .post('/api/v1/invite/federated-friend')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        account: 'address-bob',
        domain: FED_DOMAIN_B,
        displayName: 'Address Bob',
        note: 'address request',
      });
    expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
    expect(sent.body.data).toEqual({
      account: 'address-bob',
      domain: FED_DOMAIN_B,
    });
    const requesterStub = await appA.database.query.user.findFirst({
      where: and(
        eq(user.account, 'address-bob'),
        eq(user.domain, FED_DOMAIN_B),
      ),
    });
    expect(requesterStub).toBeDefined();
    const requesterShell =
      await appA.database.query.threadParticipant.findFirst({
        where: and(eq(threadParticipant.userId, aliceId)),
      });
    expect(requesterShell).toBeDefined();

    const incoming = await vi.waitFor(
      async () => {
        const row = await appB.database.query.federatedFriendRequest.findFirst({
          where: and(
            eq(federatedFriendRequest.localUserId, bobId),
            eq(federatedFriendRequest.remoteAccount, 'address-alice'),
            eq(federatedFriendRequest.remoteDomain, FED_DOMAIN_A),
            eq(federatedFriendRequest.direction, 'INCOMING'),
            eq(federatedFriendRequest.status, 'REQUESTED'),
          ),
        });
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(
      incoming.expiresAt!.getTime() - incoming.requestedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);
    expect(
      await appB.database.query.user.findFirst({
        where: and(
          eq(user.account, 'address-alice'),
          eq(user.domain, FED_DOMAIN_A),
        ),
      }),
    ).toBeUndefined();

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
      }),
    });

    const accepted = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ account: 'address-alice', domain: FED_DOMAIN_A });
    expect(accepted.body.code, JSON.stringify(accepted.body)).toBe(
      BusinessCode.OK,
    );

    await vi.waitFor(
      async () => {
        const [bobStubOnA, aliceStubOnB] = await Promise.all([
          appA.database.query.user.findFirst({
            where: and(
              eq(user.account, 'address-bob'),
              eq(user.domain, FED_DOMAIN_B),
            ),
          }),
          appB.database.query.user.findFirst({
            where: and(
              eq(user.account, 'address-alice'),
              eq(user.domain, FED_DOMAIN_A),
            ),
          }),
        ]);
        expect(bobStubOnA).toBeDefined();
        expect(aliceStubOnB).toBeDefined();
        const [pairA, pairB] = await Promise.all([
          appA.database.query.relationshipPair.findFirst({
            where: and(
              eq(relationshipPair.userLowId, Math.min(aliceId, bobStubOnA!.id)),
              eq(
                relationshipPair.userHighId,
                Math.max(aliceId, bobStubOnA!.id),
              ),
              eq(relationshipPair.active, true),
            ),
          }),
          appB.database.query.relationshipPair.findFirst({
            where: and(
              eq(relationshipPair.userLowId, Math.min(bobId, aliceStubOnB!.id)),
              eq(
                relationshipPair.userHighId,
                Math.max(bobId, aliceStubOnB!.id),
              ),
              eq(relationshipPair.active, true),
            ),
          }),
        ]);
        expect(pairA).toBeDefined();
        expect(pairB).toBeDefined();

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
});
