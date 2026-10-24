import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  resolveFederatedCard,
  seedUserWithoutProfile,
} from './federation-test-helpers.js';
import { waitForReceivedRequest } from './support/received-request.js';
import { waitForAcceptedDurableTasks } from './durable-task-helpers.js';
import * as tables from '../src/database/schema.js';
import {
  groupState,
  groupStateFields,
} from '../src/group/shared/group-state.js';

/** Revision zero is account existence without a snapshot, throughout real signed federation. */
describe('federated no-profile account lifecycle', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  const alice = 'emptyalice';
  const bob = 'emptybob';
  const poll = { timeout: 30_000, interval: 100 };

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  async function post(app: FedApp, token: string, path: string, body: object) {
    const response = await request(app.baseUrl)
      .post(`/api/v1/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.code, JSON.stringify(response.body)).toBe(0);
    return response;
  }

  async function namespace(app: FedApp, domain: string) {
    const row = await app.database.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
    });
    expect(row?.active).toBe(true);
    return row!.id;
  }

  async function memberFact(app: FedApp, threadId: number) {
    const rows = await app.database
      .select()
      .from(tables.groupMetaMemberFeed)
      .where(
        and(
          eq(tables.groupMetaMemberFeed.threadId, threadId),
          eq(tables.groupMetaMemberFeed.operation, 'MEMBER_UPSERT'),
          sql`${tables.groupMetaMemberFeed.body} ->> 'account' = ${bob}`,
        ),
      );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function sendAndReceive(
    sender: FedApp,
    receiver: FedApp,
    token: string,
    senderThread: number,
    receiverThread: number,
    text: string,
    rev: number,
  ) {
    await post(sender, token, 'send-message', {
      threadId: senderThread,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text }),
    });
    await vi.waitFor(async () => {
      const row = await receiver.database.query.message.findFirst({
        where: and(
          eq(tables.message.threadId, receiverThread),
          eq(tables.message.content, JSON.stringify({ text })),
        ),
      });
      expect(row).toMatchObject({ profileRev: rev });
    }, poll);
  }

  it('preserves zero intent, roster, and message references until new profile evidence arrives', async () => {
    const userA = await seedUserWithoutProfile(appA, alice);
    const userB = await seedUserWithoutProfile(appB, bob);
    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: userA.id,
      remoteUserId: userB.id,
      localToken: userA.token,
      remoteToken: userB.token,
      localAccount: alice,
      remoteAccount: bob,
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
    });
    const nsB = await namespace(appA, FED_DOMAIN_B);
    const nsA = await namespace(appB, FED_DOMAIN_A);

    async function assertZeroIntents() {
      for (const app of [appA, appB]) {
        const intents = await app.database.query.relationshipIntent.findMany({
          where: and(
            eq(tables.relationshipIntent.authorAccount, bob),
            eq(tables.relationshipIntent.status, 'ACCEPTED'),
          ),
        });
        expect(intents.length).toBeGreaterThan(0);
        expect(intents.every((intent) => intent.profileRev === 0)).toBe(true);
      }
    }
    await assertZeroIntents();
    await sendAndReceive(
      appB,
      appA,
      userB.token,
      friendship.remoteThreadId,
      friendship.localThreadId,
      'zero-p2p',
      0,
    );

    const created = await post(appA, userA.token, 'group/create', {
      name: 'No profile members',
    });
    const originThread = created.body.data.threadId as number;
    const [originGroup] = await appA.database
      .select({ account: groupStateFields.account })
      .from(groupState)
      .where(eq(groupStateFields.id, originThread));
    const groupAccount = originGroup.account;
    const invited = await post(appA, userA.token, 'group/invite', {
      groupId: originThread,
      users: [
        {
          account: bob,
          namespaceId: nsB,
          snapshot: { displayName: bob, avatar: null },
        },
      ],
    });
    await waitForAcceptedDurableTasks(appA.database, invited.body);
    const invitation = await waitForReceivedRequest(appB.baseUrl, userB.token, {
      kind: 'GROUP_INVITATION',
      author: { account: groupAccount, namespaceId: nsA },
      receiver: { account: bob, namespaceId: 0 },
    });
    const accepted = await post(appB, userB.token, 'group/join-request', {
      requestId: invitation.id,
    });
    expect(accepted.body.data.status).toBe('OK');
    const mirror = await vi.waitFor(async () => {
      const [row] = await appB.database
        .select({ id: groupStateFields.id })
        .from(groupState)
        .where(eq(groupStateFields.account, groupAccount));
      expect(row).toBeDefined();
      expect((await memberFact(appB, row.id)).body).toMatchObject({
        profileRev: 0,
      });
      expect((await memberFact(appA, originThread)).body).toMatchObject({
        profileRev: 0,
      });
      return row;
    }, poll);
    const beforeFact = await memberFact(appA, originThread);
    const beforeMirrorFact = await memberFact(appB, mirror.id);
    await sendAndReceive(
      appB,
      appA,
      userB.token,
      mirror.id,
      originThread,
      'zero-group',
      0,
    );

    for (const app of [appA, appB]) {
      const snapshots = await app.database.query.profileTable.findMany({
        where: eq(tables.profileTable.account, bob),
      });
      expect(snapshots).toEqual([]);
    }
    const exactBobRequests = () =>
      proxy.requestLog().filter((entry) => {
        const path = new URL(entry.path, appA.baseUrl).pathname;
        return (
          (path.includes('/account-profiles/') && path.includes(`/${bob}/`)) ||
          (path.includes('/group-member-profiles/') &&
            path.includes(`/${bob}/`))
        );
      });
    expect(exactBobRequests()).toEqual([]);

    await post(appB, userB.token, 'user/update-profile', {
      name: 'Published Bob',
      bio: 'First real snapshot',
    });
    const local = await appB.database.query.account.findFirst({
      where: eq(tables.account.id, userB.id),
    });
    expect(local?.defaultProfileRev).toBe(1);
    await assertZeroIntents();
    const resolved = await resolveFederatedCard(
      appA,
      userA.token,
      bob,
      FED_DOMAIN_B,
    );
    expect(resolved.event).toBe('resolved');
    expect(resolved.data.user).toMatchObject({ name: 'Published Bob' });
    expect(await memberFact(appA, originThread)).toMatchObject({
      feedId: beforeFact.feedId,
      body: { profileRev: 0 },
    });
    expect(await memberFact(appB, mirror.id)).toMatchObject({
      feedId: beforeMirrorFact.feedId,
      body: { profileRev: 0 },
    });

    await sendAndReceive(
      appB,
      appA,
      userB.token,
      friendship.remoteThreadId,
      friendship.localThreadId,
      'positive-p2p',
      1,
    );
    await sendAndReceive(
      appB,
      appA,
      userB.token,
      mirror.id,
      originThread,
      'positive-group',
      1,
    );
    await vi.waitFor(async () => {
      const fact = await memberFact(appA, originThread);
      expect(fact.body).toMatchObject({ profileRev: 1 });
      expect(fact.feedId).toBeGreaterThan(beforeFact.feedId);
      expect((await memberFact(appB, mirror.id)).body).toMatchObject({
        profileRev: 1,
      });
    }, poll);
    await assertZeroIntents();
    for (const [threadId, text] of [
      [friendship.localThreadId, 'zero-p2p'],
      [originThread, 'zero-group'],
    ] as const) {
      const old = await appA.database.query.message.findFirst({
        where: and(
          eq(tables.message.threadId, threadId),
          eq(tables.message.content, JSON.stringify({ text })),
        ),
      });
      expect(old?.profileRev).toBe(0);
    }
  }, 180_000);
});
