import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bootFederationTriple,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  FED_DOMAIN_C,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  registerAndLogin,
} from './federation-test-helpers.js';
import { waitForAcceptedDurableTask } from './durable-task-helpers.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  assertFederationMessageWire,
  assertFederationWireSchema,
} from './support/federation-wire-schema.js';

/** Three actual processes with distinct databases: A owns the group; B and C host same-name members. */
describe('three-node group wire convergence', () => {
  let appA: FedApp;
  let appB: FedApp;
  let appC: FedApp;
  let proxyA: S2sProxy;
  let proxyB: S2sProxy;
  let proxyC: S2sProxy;
  let alice: Awaited<ReturnType<typeof registerAndLogin>>;
  let bob: Awaited<ReturnType<typeof registerAndLogin>>;
  let carol: Awaited<ReturnType<typeof registerAndLogin>>;
  let group: string;
  let originThread: number;
  let mirrorB: number;
  let mirrorC: number;
  let homeBOnA: number;
  let homeCOnA: number;

  async function post(app: FedApp, token: string, path: string, body: object) {
    const response = await request(app.baseUrl)
      .post(`/api/v1/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    return response.body;
  }

  async function namespace(app: FedApp, domain: string) {
    const row = await app.database.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.domain, domain),
        isNull(tables.identityNamespace.retiredAt),
      ),
    });
    expect(row).toBeDefined();
    return row!.id;
  }

  async function findText(app: FedApp, threadId: number, text: string) {
    return vi.waitFor(
      async () => {
        const rows = await app.database.query.message.findMany({
          where: and(
            eq(tables.message.threadId, threadId),
            eq(tables.message.contentType, 'PURE_TEXT'),
          ),
        });
        const found = rows.filter(
          (row) => JSON.parse(row.content).text === text,
        );
        expect(
          found,
          `${app.baseUrl} thread=${threadId} text=${text}`,
        ).toHaveLength(1);
        return found[0];
      },
      { timeout: 20_000, interval: 100 },
    );
  }

  beforeAll(async () => {
    ({ appA, appB, appC, proxyA, proxyB, proxyC } =
      await bootFederationTriple());
    alice = await registerAndLogin(appA, 'originowner', 'Origin owner');
    // Deliberately equal account strings under different home identities.
    bob = await registerAndLogin(appB, 'member', 'Member B');
    carol = await registerAndLogin(appC, 'member', 'Member C');
    for (const [remote, person, domain] of [
      [appB, bob, FED_DOMAIN_B],
      [appC, carol, FED_DOMAIN_C],
    ] as const) {
      await establishFederatedFriendship({
        local: appA,
        remote,
        localUserId: alice.id,
        remoteUserId: person.id,
        localToken: alice.token,
        remoteToken: person.token,
        localAccount: alice.account,
        remoteAccount: person.account,
        localDomain: FED_DOMAIN_A,
        remoteDomain: domain,
      });
    }
    homeBOnA = await namespace(appA, FED_DOMAIN_B);
    homeCOnA = await namespace(appA, FED_DOMAIN_C);
    expect(homeBOnA).not.toBe(homeCOnA);
    const created = await post(appA, alice.token, 'group/create', {
      name: 'Three-node contract',
    });
    originThread = created.data.threadId;
    const thread = await appA.database.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, originThread),
    });
    group = thread!.groupAccount!;
    await post(appA, alice.token, 'group/invite', {
      groupId: originThread,
      users: [
        { account: bob.account, namespaceId: homeBOnA },
        { account: carol.account, namespaceId: homeCOnA },
      ],
    });
    const mirrors: number[] = [];
    for (const [remote, person] of [
      [appB, bob],
      [appC, carol],
    ] as const) {
      const mirror = await vi.waitFor(
        async () => {
          const row = await remote.database.query.messageThread.findFirst({
            where: eq(tables.messageThread.groupAccount, group),
          });
          expect(row).toBeDefined();
          return row!;
        },
        { timeout: 20_000, interval: 100 },
      );
      const accepted = await post(remote, person.token, 'group/join-request', {
        groupId: mirror.id,
      });
      await waitForAcceptedDurableTask(remote.database, accepted);
      await vi.waitFor(
        async () => {
          const state =
            await remote.database.query.accountThreadState.findFirst({
              where: and(
                eq(tables.accountThreadState.threadId, mirror.id),
                eq(tables.accountThreadState.accountId, person.id),
              ),
            });
          expect(state?.role).toBe('MEMBER');
        },
        { timeout: 20_000, interval: 100 },
      );
      mirrors.push(mirror.id);
    }
    [mirrorB, mirrorC] = mirrors;
    for (const [remote, mirror] of [
      [appB, mirrorB],
      [appC, mirrorC],
    ] as const) {
      await vi.waitFor(
        async () => {
          const facts =
            await remote.database.query.groupMetaMemberFeed.findMany({
              where: eq(tables.groupMetaMemberFeed.threadId, mirror),
            });
          for (const ns of [homeBOnA, homeCOnA]) {
            expect(
              facts.some(
                (fact) =>
                  fact.operation === 'MEMBER_UPSERT' &&
                  fact.body.account === 'member' &&
                  fact.body.namespaceId === ns,
              ),
            ).toBe(true);
          }
        },
        { timeout: 20_000, interval: 100 },
      );
    }
    proxyA.clearRequestLog();
    proxyB.clearRequestLog();
    proxyC.clearRequestLog();
  }, 180_000);

  afterAll(async () => {
    await Promise.all([appA?.close(), appB?.close(), appC?.close()]);
    await Promise.all([proxyA?.close(), proxyB?.close(), proxyC?.close()]);
  }, 120_000);

  it('converges mentions, reply coordinates and authoritative receipts without pulling mirror copies', async () => {
    const mentionText = `target-${randomUUID()} [@Member C](somfp://user/${homeCOnA}/member)`;
    await post(appA, alice.token, 'send-message', {
      threadId: originThread,
      clientMessageId: randomUUID(),
      content: JSON.stringify({ text: mentionText }),
    });
    const [targetA, targetB, targetC] = await Promise.all([
      findText(appA, originThread, mentionText),
      findText(appB, mirrorB, mentionText),
      findText(appC, mirrorC, mentionText),
    ]);
    expect(targetB.originSeq).toBe(targetA.seq);
    expect(targetC.originSeq).toBe(targetA.seq);
    await vi.waitFor(
      async () => {
        const stateC = await appC.database.query.accountThreadState.findFirst({
          where: and(
            eq(tables.accountThreadState.threadId, mirrorC),
            eq(tables.accountThreadState.accountId, carol.id),
          ),
        });
        expect(stateC?.lastMentionSeq).toBe(targetC.seq);
      },
      { timeout: 20_000, interval: 100 },
    );
    const stateB = await appB.database.query.accountThreadState.findFirst({
      where: and(
        eq(tables.accountThreadState.threadId, mirrorB),
        eq(tables.accountThreadState.accountId, bob.id),
      ),
    });
    expect(stateB?.lastMentionSeq ?? 0).toBe(0);

    const replyText = `reply-${randomUUID()}`;
    const sent = await post(appB, bob.token, 'send-message', {
      threadId: mirrorB,
      clientMessageId: randomUUID(),
      content: JSON.stringify({ text: replyText }),
      quoteTargetSeq: targetB.seq,
    });
    const [replyA, replyB, replyC] = await Promise.all([
      findText(appA, originThread, replyText),
      findText(appB, mirrorB, replyText),
      findText(appC, mirrorC, replyText),
    ]);
    expect(replyB.seq).toBe(sent.data.seq);
    await vi.waitFor(
      async () => {
        const accepted = await appB.database.query.message.findFirst({
          where: eq(tables.message.id, replyB.id),
        });
        expect(accepted?.originSeq).toBe(replyA.seq);
        expect(accepted?.federationPayloadVerification).toBe('VERIFIED');
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(replyC.originSeq).toBe(replyA.seq);
    expect(replyC.profileNamespaceId).toBe(homeBOnA);
    expect(replyC.profileNamespaceId).not.toBe(homeCOnA);
    for (const row of [replyA, replyB, replyC]) {
      expect(row.payloadDigest).toBe(replyA.payloadDigest);
      expect(JSON.parse(row.content).quote.digest).toBe(targetA.payloadDigest);
    }
    expect(JSON.parse(replyA.content).quote).toMatchObject({
      seq: targetA.seq,
      namespaceId: 0,
    });
    expect(JSON.parse(replyC.content).quote).toMatchObject({
      seq: targetA.seq,
      namespaceId: await namespace(appC, FED_DOMAIN_A),
    });

    const fromC = `from-c-${randomUUID()}`;
    await post(appC, carol.token, 'send-message', {
      threadId: mirrorC,
      clientMessageId: randomUUID(),
      content: JSON.stringify({ text: fromC }),
    });
    const [fromCA, fromCB, fromCC] = await Promise.all([
      findText(appA, originThread, fromC),
      findText(appB, mirrorB, fromC),
      findText(appC, mirrorC, fromC),
    ]);
    await vi.waitFor(
      async () => {
        const accepted = await appC.database.query.message.findFirst({
          where: eq(tables.message.id, fromCC.id),
        });
        expect(accepted?.originSeq).toBe(fromCA.seq);
        expect(accepted?.federationPayloadVerification).toBe('VERIFIED');
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(fromCB.originSeq).toBe(fromCA.seq);
    expect(fromCB.profileNamespaceId).toBe(homeCOnA);

    for (const [proxy, memberHome] of [
      [proxyB, true],
      [proxyC, true],
      [proxyA, false],
    ] as const) {
      const pages = proxy
        .requestLog()
        .filter(
          (entry) =>
            entry.method === 'GET' &&
            new URL(entry.path, 'http://proxy.invalid').pathname ===
              '/s2s/v1/messages' &&
            new URL(entry.path, 'http://proxy.invalid').searchParams.get(
              'account',
            ) === group,
        );
      expect(pages.length).toBeGreaterThan(0);
      let successful = 0;
      for (const entry of pages) {
        const query = new URL(entry.path, 'http://proxy.invalid').searchParams;
        expect(query.get('includeSelf')).toBe(memberHome ? 'false' : 'true');
        if (entry.status !== 200 || !entry.responseBody) continue;
        const envelope = JSON.parse(entry.responseBody);
        if (envelope.code !== BusinessCode.OK) continue;
        successful++;
        assertFederationWireSchema('urn:somfp:v1:message-query', envelope.data);
        for (const item of envelope.data.messages) {
          assertFederationMessageWire(item);
          if (memberHome) {
            expect(item.author).toEqual({ account: 'member', namespaceId: 0 });
          }
        }
      }
      expect(successful).toBeGreaterThan(0);
    }
  }, 120_000);
});
