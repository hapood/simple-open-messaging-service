import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { BusinessCode } from '../src/common/business-code.js';
import {
  message,
  forwardMessage,
  forwardBundle,
} from '../src/database/schema.js';
import type { ForwardWireBundle } from '../src/forward/forward-bundle.service.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  registerAndLogin,
} from './federation-test-helpers.js';

describe('federated history-forward reply references', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let threadA: number;
  let threadB: number;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await appA.database.execute(
      sql`SELECT setval(pg_get_serial_sequence('"ForwardBundle"', 'id'), ${9_007_199_254_740_993n}::bigint, false)`,
    );
    await appB.database.execute(
      sql`SELECT setval(pg_get_serial_sequence('"ForwardBundle"', 'id'), ${9_007_199_254_741_993n}::bigint, false)`,
    );
    const alice = await registerAndLogin(appA, 'bundlealice', 'Bundle Alice');
    const bob = await registerAndLogin(appB, 'bundlebob', 'Bundle Bob');
    tokenA = alice.token;
    tokenB = bob.token;
    const friends = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: alice.id,
      remoteUserId: bob.id,
      localToken: tokenA,
      remoteToken: tokenB,
      localAccount: 'bundlealice',
      remoteAccount: 'bundlebob',
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
    });
    threadA = friends.localThreadId;
    threadB = friends.remoteThreadId;
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  async function send(
    app: FedApp,
    token: string,
    threadId: number,
    text: string,
    quoteSeq?: number,
  ) {
    const response = await request(app.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId,
        clientMessageId: randomUUID(),
        contentType: 'PURE_TEXT',
        content: JSON.stringify({
          text,
          ...(quoteSeq === undefined ? {} : { quote: { seq: quoteSeq } }),
        }),
      });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    return response.body.data as { seq: number };
  }

  async function mirroredText(text: string) {
    return vi.waitFor(
      async () => {
        const rows = await appA.database.query.message.findMany({
          where: and(
            eq(message.threadId, threadA),
            eq(message.contentType, 'PURE_TEXT'),
          ),
        });
        const row = rows.find((row) => JSON.parse(row.content).text === text);
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 15_000, interval: 100 },
    );
  }

  async function forwardAndCompare(seqs: number[]) {
    const sent = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: threadA,
        clientMessageId: randomUUID(),
        mode: 'HISTORY',
        sourceMessages: seqs.map((seq) => ({ threadId: threadA, seq })),
      });
    expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
    const bundleId = JSON.parse(sent.body.data.content).bundleId;
    const local = await appA.database.query.forwardBundle.findFirst({
      where: (row, { eq }) => eq(row.sourceBundleId, bundleId),
    });
    expect(local).toBeDefined();
    const { bundle: imported, seq: remoteSeq } = await vi.waitFor(
      async () => {
        const row = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, threadB),
            eq(message.originSeq, sent.body.data.seq),
            eq(message.contentType, 'FORWARD'),
          ),
        });
        expect(row?.localState).toBe('READY');
        const bindings = await appB.database
          .select({ bundle: forwardBundle })
          .from(forwardMessage)
          .innerJoin(
            forwardBundle,
            eq(forwardBundle.id, forwardMessage.bundleId),
          )
          .where(eq(forwardMessage.messageId, row!.id));
        expect(bindings).toHaveLength(1);
        return { bundle: bindings[0].bundle, seq: row!.seq };
      },
      { timeout: 15_000, interval: 100 },
    );
    // Compare persisted content as well as public wire views: projecting both reads
    // to the wire alone hid the original local quote-coordinate leak.
    expect(imported.messages).toEqual(local!.messages);
    expect(typeof local!.id).toBe('bigint');
    expect(typeof imported.id).toBe('bigint');
    expect(local!.id).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(imported.id).not.toBe(local!.id);
    const page = await request(appB.baseUrl)
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: threadB,
        after: remoteSeq - 1,
        through: remoteSeq,
        take: 1,
      });
    expect(page.body.code).toBe(BusinessCode.OK);
    const projectedCard = JSON.parse(page.body.data.messages[0].content);
    expect(projectedCard.bundleId).toBe(bundleId);
    expect(projectedCard.bundleId).toMatch(/^[a-f0-9]{64}$/);
    const localIdRead = await request(appB.baseUrl)
      .get(`/api/v1/forward-bundles/${imported.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(localIdRead.body.code).toBe(BusinessCode.NOT_FOUND);
    const [localView, remoteView] = await Promise.all([
      request(appA.baseUrl)
        .get(`/api/v1/forward-bundles/${bundleId}`)
        .set('Authorization', `Bearer ${tokenA}`),
      request(appB.baseUrl)
        .get(`/api/v1/forward-bundles/${projectedCard.bundleId}`)
        .set('Authorization', `Bearer ${tokenB}`),
    ]);
    expect(localView.body.code).toBe(BusinessCode.OK);
    expect(remoteView.body.code).toBe(BusinessCode.OK);
    expect(remoteView.body.data.messages).toEqual(localView.body.data.messages);
    return local!.messages as ForwardWireBundle['messages'];
  }

  it('round trips nested private bigint references without exposing them in client cards or closures', async () => {
    const first = await send(
      appA,
      tokenA,
      threadA,
      `bigint-nested-${randomUUID()}`,
    );
    let sourceSeq = first.seq;
    for (let layer = 0; layer < 3; layer++) {
      const [
        sender,
        receiver,
        senderToken,
        receiverToken,
        sourceThread,
        receiverThread,
      ] =
        layer % 2 === 0
          ? ([appA, appB, tokenA, tokenB, threadA, threadB] as const)
          : ([appB, appA, tokenB, tokenA, threadB, threadA] as const);
      const sent = await request(sender.baseUrl)
        .post('/api/v1/send-forward')
        .set('Authorization', `Bearer ${senderToken}`)
        .send({
          threadId: sourceThread,
          sourceMessages: [{ threadId: sourceThread, seq: sourceSeq }],
          mode: 'HISTORY',
          clientMessageId: randomUUID(),
        });
      expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
      const wireId = JSON.parse(sent.body.data.content).bundleId;
      const carrier = await vi.waitFor(
        async () => {
          const row = await receiver.database.query.message.findFirst({
            where: and(
              eq(message.threadId, receiverThread),
              eq(message.originSeq, sent.body.data.seq),
              eq(message.contentType, 'FORWARD'),
              eq(
                message.creatorAccount,
                layer % 2 === 0 ? 'bundlealice' : 'bundlebob',
              ),
            ),
          });
          expect(row?.localState).toBe('READY');
          const bindings = await receiver.database
            .select({ bundleId: forwardMessage.bundleId, forwardBundle })
            .from(forwardMessage)
            .innerJoin(
              forwardBundle,
              eq(forwardBundle.id, forwardMessage.bundleId),
            )
            .where(eq(forwardMessage.messageId, row!.id));
          expect(bindings).toHaveLength(1);
          return { ...row!, forwardMessages: bindings };
        },
        { timeout: 15_000, interval: 100 },
      );
      const binding = carrier.forwardMessages[0];
      expect(typeof binding.bundleId).toBe('bigint');
      expect(binding.bundleId).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
      if (layer > 0) {
        const snapshots = binding.forwardBundle.messages;
        if (!Array.isArray(snapshots))
          throw new Error('stored snapshots must be an array');
        expect(snapshots[0].childBundleId).toMatch(/^[1-9][0-9]*$/);
        expect(BigInt(snapshots[0].childBundleId)).toBeGreaterThan(
          BigInt(Number.MAX_SAFE_INTEGER),
        );
      }
      const page = await request(receiver.baseUrl)
        .post('/api/v1/query-messages')
        .set('Authorization', `Bearer ${receiverToken}`)
        .send({
          threadId: receiverThread,
          after: carrier.seq - 1,
          through: carrier.seq,
          take: 1,
        });
      expect(page.body.code).toBe(BusinessCode.OK);
      expect(JSON.parse(page.body.data.messages[0].content).bundleId).toBe(
        wireId,
      );
      const view = await request(receiver.baseUrl)
        .get(`/api/v1/forward-bundles/${wireId}`)
        .set('Authorization', `Bearer ${receiverToken}`);
      expect(view.body.code, JSON.stringify(view.body)).toBe(BusinessCode.OK);
      expect(view.body.data.id).toBe(wireId);
      expect(view.body.data.children).toHaveLength(layer);
      for (const bundle of [view.body.data, ...view.body.data.children]) {
        expect(bundle.id).toMatch(/^[a-f0-9]{64}$/);
        for (const snapshot of bundle.messages) {
          if (snapshot.childBundleId !== undefined) {
            expect(snapshot.childBundleId).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.parse(snapshot.content).bundleId).toBe(
              snapshot.childBundleId,
            );
          }
        }
      }
      sourceSeq = carrier.seq;
    }
    // DIRECT can retain a maximum-depth card and must reuse its existing binding.
    const source = await appB.database.query.message.findFirst({
      where: and(eq(message.threadId, threadB), eq(message.seq, sourceSeq)),
    });
    expect(JSON.parse(source!.content).depth).toBe(3);
    const sourceBinding = await appB.database.query.forwardMessage.findFirst({
      where: eq(forwardMessage.messageId, source!.id),
    });
    const before = await appB.database.query.forwardBundle.findMany({
      columns: { id: true },
    });
    const direct = await request(appB.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: threadB,
        sourceMessages: [{ threadId: threadB, seq: sourceSeq }],
        mode: 'DIRECT',
        clientMessageId: randomUUID(),
      });
    expect(direct.body.code, JSON.stringify(direct.body)).toBe(BusinessCode.OK);
    expect(direct.body.data.contentType).toBe('FORWARD');
    expect(direct.body.data.content).toBe(source!.content);
    const after = await appB.database.query.forwardBundle.findMany({
      columns: { id: true },
    });
    expect(after).toHaveLength(before.length);
    const directRow = await appB.database.query.message.findFirst({
      where: and(
        eq(message.threadId, threadB),
        eq(message.seq, direct.body.data.seq),
      ),
    });
    const directBinding = await appB.database.query.forwardMessage.findFirst({
      where: eq(forwardMessage.messageId, directRow!.id),
    });
    expect(directBinding?.bundleId).toBe(sourceBinding!.bundleId);
    await vi.waitFor(
      async () => {
        const row = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, threadA),
            eq(message.originSeq, direct.body.data.seq),
            eq(message.creatorAccount, 'bundlebob'),
            eq(message.contentType, 'FORWARD'),
          ),
        });
        expect(row?.localState).toBe('READY');
        expect(JSON.parse(row!.content)).toMatchObject({
          bundleId: JSON.parse(source!.content).bundleId,
          depth: 3,
        });
      },
      { timeout: 15_000, interval: 100 },
    );
    const directView = await request(appA.baseUrl)
      .get(`/api/v1/forward-bundles/${JSON.parse(source!.content).bundleId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(directView.body.code).toBe(BusinessCode.OK);
    expect(directView.body.data.children).toHaveLength(2);
  }, 90_000);

  it('rejects an explicit zero reference instead of creating a digestless reply', async () => {
    const text = `invalid-zero-${randomUUID()}`;
    const response = await request(appB.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: threadB,
        clientMessageId: randomUUID(),
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text, quote: { seq: 0 } }),
      });
    expect(response.body.code).toBe(BusinessCode.VALIDATION_FAILED);
    expect(response.body.message).toContain('positive thread sequence');
    const rows = await appB.database.query.message.findMany({
      where: eq(message.threadId, threadB),
    });
    expect(rows.some((row) => JSON.parse(row.content).text === text)).toBe(
      false,
    );
  });

  it('marks an unselected target absent and rebuilds a selected original/reply/reply-to-reply chain', async () => {
    const prefix = randomUUID();
    const original = await send(appB, tokenB, threadB, `${prefix}-original`);
    const reply = await send(
      appB,
      tokenB,
      threadB,
      `${prefix}-reply`,
      original.seq,
    );
    await send(appB, tokenB, threadB, `${prefix}-reply-to-reply`, reply.seq);
    const originalA = await mirroredText(`${prefix}-original`);
    const replyA = await mirroredText(`${prefix}-reply`);
    const nestedA = await mirroredText(`${prefix}-reply-to-reply`);
    expect(JSON.parse(replyA.content).quote.namespaceId).toBeGreaterThan(0);
    const single = await forwardAndCompare([replyA.seq]);
    expect(single[0].quoteTargetId).toBe(0);
    expect(JSON.parse(single[0].content)).toEqual({ text: `${prefix}-reply` });
    const chain = await forwardAndCompare(
      [originalA.seq, replyA.seq, nestedA.seq].sort((a, b) => a - b),
    );
    const originalEntry = chain.find(
      (entry) => JSON.parse(entry.content).text === `${prefix}-original`,
    )!;
    const replyEntry = chain.find(
      (entry) => JSON.parse(entry.content).text === `${prefix}-reply`,
    )!;
    const nestedEntry = chain.find(
      (entry) => JSON.parse(entry.content).text === `${prefix}-reply-to-reply`,
    )!;
    expect(originalEntry.quoteTargetId).toBeUndefined();
    expect(replyEntry.quoteTargetId).toBe(originalEntry.id);
    expect(nestedEntry.quoteTargetId).toBe(replyEntry.id);
    for (const entry of chain)
      expect(Object.keys(JSON.parse(entry.content))).toEqual(['text']);
  });

  it('forwards a reply whose positive target coordinate has no stored message', async () => {
    const text = `missing-body-${randomUUID()}`;
    const target = await send(appB, tokenB, threadB, `${text}-target`);
    await send(appB, tokenB, threadB, text, target.seq);
    const reply = await mirroredText(text);
    const retainedQuote = JSON.parse(reply.content).quote;
    expect(retainedQuote.digest).toMatch(/^[a-f0-9]{64}$/);
    // Model retained federated history whose target body has never arrived.
    await appA.database
      .update(message)
      .set({
        content: JSON.stringify({
          text,
          quote: {
            ...retainedQuote,
            seq: 900_000,
            namespaceId: reply.publisherNamespaceId,
          },
        }),
      })
      .where(eq(message.id, reply.id));
    const bundle = await forwardAndCompare([reply.seq]);
    expect(bundle[0].quoteTargetId).toBe(0);
    expect(JSON.parse(bundle[0].content)).toEqual({ text });
  });
});
