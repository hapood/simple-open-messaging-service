import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, or } from 'drizzle-orm';
import type {
  IncomingRequestHead,
  PersonalRequestPage,
  RequestRecord,
} from '../shared/relationship-request.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { findP2PRelationship, seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app.js';

type Actor = Awaited<ReturnType<typeof seedUserWithSession>>;

/** HTTP request decisions and established-relationship termination are separate
 * contracts. ClientStateFeed transports heads only, not request projections. */
describe('P2P request and established-relationship HTTP contract', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let sequence = 0;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => app?.close());

  const post = (actor: Actor, route: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/relationship/${route}`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body);
  async function actor() {
    return seedUserWithSession(app, `http-flow-${++sequence}`, {
      name: `Person ${sequence}`,
    });
  }
  const head = (user: Actor) =>
    database.db.query.account.findFirst({
      where: eq(tables.account.id, user.id),
      columns: {
        requestEndId: true,
        requestReadId: true,
        clientStateFeedEndId: true,
      },
    });
  async function page(
    user: Actor,
    bucket: 'SENT' | 'RECEIVED',
  ): Promise<PersonalRequestPage> {
    const response = await post(user, 'requests', { bucket, take: 50 });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    const result: PersonalRequestPage = response.body.data;
    expect(result.hasMore).toBe(false);
    return result;
  }
  async function open(
    author: Actor,
    receiver: Actor,
    displayName = 'Receiver at request time',
  ) {
    const response = await post(author, 'request', {
      account: receiver.account,
      namespaceId: 0,
      note: 'Request evidence',
      snapshot: { displayName, avatar: null },
    });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    expect(response.body.data.status).toBe('OK');
    return response;
  }
  async function current(
    author: Actor,
    receiver: Actor,
  ): Promise<RequestRecord> {
    const rows = (await page(author, 'SENT')).items.filter(
      (row) =>
        row.kind === 'FRIEND' &&
        row.receiver.account === receiver.account &&
        row.receiver.namespaceId === 0 &&
        row.status === 'REQUESTED',
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }
  const stored = (id: string) =>
    database.db.query.relationshipRequest.findFirst({
      where: eq(tables.relationshipRequest.id, BigInt(id)),
    });
  const pairFor = (author: Actor, receiver: Actor) =>
    findP2PRelationship(database.db, author.id, {
      account: receiver.account,
      namespaceId: 0,
    });
  function intentScope(author: Actor, receiver: Actor) {
    return and(
      eq(tables.relationshipIntent.authorAccount, author.account),
      eq(tables.relationshipIntent.authorNamespaceId, 0),
      eq(tables.relationshipIntent.receiverAccount, receiver.account),
      eq(tables.relationshipIntent.receiverNamespaceId, 0),
    );
  }
  async function acceptedPair(author: Actor, receiver: Actor) {
    await open(author, receiver);
    const row = await current(author, receiver);
    const accepted = await post(receiver, 'accept', { requestId: row.id });
    expect(accepted.body.code, JSON.stringify(accepted.body)).toBe(
      BusinessCode.OK,
    );
    expect(accepted.body.data.status).toBe('OK');
    const threadId: number = accepted.body.data.threadId;
    expect(Number.isSafeInteger(threadId)).toBe(true);
    expect(threadId).toBeGreaterThan(0);
    return { row, threadId };
  }
  async function expire(row: RequestRecord) {
    const requestedAt = new Date(Date.now() - 8_000);
    const expiresAt = new Date(Date.now() - 1_000);
    await database.db.transaction(async (tx) => {
      // Age both the protocol intent and its explicit request record. Keep
      // createdAt in the online window so expiry is not confused with hiding.
      await tx
        .update(tables.relationshipIntent)
        .set({ requestedAt, expiresAt })
        .where(eq(tables.relationshipIntent.requestId, BigInt(row.id)));
      await tx
        .update(tables.relationshipRequest)
        .set({ requestedAt, expiresAt })
        .where(eq(tables.relationshipRequest.id, BigInt(row.id)));
    });
  }

  it('commits the recipient head synchronously and serves request evidence online', async () => {
    const author = await actor();
    const receiver = await actor();
    const before = await head(receiver);
    if (!before) throw new Error('missing receiver');
    const authorBefore = await head(author);
    await open(author, receiver);
    const row = await current(author, receiver);
    const received = await page(receiver, 'RECEIVED');
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({
      id: row.id,
      kind: 'FRIEND',
      direction: 'INCOMING',
      status: 'REQUESTED',
      author: { account: author.account, namespaceId: 0 },
      receiver: { account: receiver.account, namespaceId: 0 },
      note: 'Request evidence',
      authorProfile: {
        account: author.account,
        namespaceId: 0,
        profileNamespaceId: 0,
        profileRev: expect.any(Number),
      },
    });
    expect(received.incomingHead).toEqual({
      requestEndId: row.id,
      requestReadId: before.requestReadId.toString(),
    });
    expect(await head(receiver)).toEqual({
      ...before,
      requestEndId: BigInt(row.id),
      clientStateFeedEndId: before.clientStateFeedEndId + 1,
    });
    expect(await head(author)).toEqual(authorBefore);
    const delta = await request(app.getHttpServer())
      .get('/api/v1/user/state-feed')
      .set('Authorization', `Bearer ${receiver.token}`)
      .query({
        mode: 'delta',
        after: before.clientStateFeedEndId,
        through: before.clientStateFeedEndId + 1,
      });
    expect(delta.body.code).toBe(BusinessCode.OK);
    const items: Array<{ feedId: number; body: IncomingRequestHead }> =
      delta.body.data.items;
    expect(items).toEqual([
      { feedId: before.clientStateFeedEndId + 1, body: received.incomingHead },
    ]);
  });

  it('rejects author-side acceptance of an exact ID without changing the round', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const row = await current(author, receiver);
    const before = await stored(row.id);
    const invalid = await post(author, 'accept', { requestId: row.id });
    expect(invalid.body.code).toBe(BusinessCode.OK);
    expect(invalid.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await stored(row.id)).toEqual(before);
    expect((await pairFor(author, receiver)).pair?.active).toBe(false);
  });

  it('accepts the exact incoming round, activates the thread and preserves the incoming head', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const row = await current(author, receiver);
    const before = await head(receiver);
    const accepted = await post(receiver, 'accept', { requestId: row.id });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data.status).toBe('OK');
    const threadId: number = accepted.body.data.threadId;
    expect(Number.isSafeInteger(threadId)).toBe(true);
    expect(threadId).toBeGreaterThan(0);
    expect((await pairFor(author, receiver)).pair).toMatchObject({
      active: true,
      threadId,
    });
    expect(await stored(row.id)).toMatchObject({ status: 'ACCEPTED' });
    expect((await page(receiver, 'RECEIVED')).items).toEqual([
      expect.objectContaining({
        id: row.id,
        direction: 'INCOMING',
        status: 'ACCEPTED',
      }),
    ]);
    // A terminal update is not a new request notification or a read action.
    expect(await head(receiver)).toEqual(before);
    const acceptedHistory = await stored(row.id);
    const replay = await post(receiver, 'accept', { requestId: row.id });
    expect(replay.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await stored(row.id)).toEqual(acceptedHistory);
  });

  it('does not authorize a stranger to revoke another pair by thread ID', async () => {
    const author = await actor();
    const receiver = await actor();
    const stranger = await actor();
    const { row, threadId } = await acceptedPair(author, receiver);
    const before = await stored(row.id);
    const revoked = await post(stranger, 'revoke', { threadId });
    expect(revoked.body.code).toBe(BusinessCode.THREAD_NOT_FOUND);
    expect((await pairFor(author, receiver)).pair).toMatchObject({
      active: true,
      threadId,
    });
    expect(await stored(row.id)).toEqual(before);
  });

  it('withdraws a pending round without departure and allocates a new ID on re-request', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const first = await current(author, receiver);
    const withdrawn = await post(author, 'requests/withdraw', {
      requestId: first.id,
    });
    expect(withdrawn.body.code).toBe(BusinessCode.OK);
    expect(withdrawn.body.data.status).toBe('OK');
    const history = await stored(first.id);
    expect(history).toMatchObject({ status: 'WITHDRAWN' });
    const { pair } = await pairFor(author, receiver);
    expect(pair?.active).toBe(false);
    if (!pair?.threadId) throw new Error('missing pending pair thread');
    expect(
      await database.db.query.message.findMany({
        where: eq(tables.message.threadId, pair.threadId),
      }),
    ).toEqual([]);
    await open(author, receiver, 'Receiver on a new round');
    const next = await current(author, receiver);
    expect(BigInt(next.id)).toBeGreaterThan(BigInt(first.id));
    expect(await stored(first.id)).toEqual(history);
    const intent = await database.db.query.relationshipIntent.findFirst({
      where: intentScope(author, receiver),
    });
    expect(intent).toMatchObject({
      status: 'REQUESTED',
      requestId: BigInt(next.id),
    });
    if (!intent?.requestedAt || !intent.expiresAt)
      throw new Error('missing request validity');
    expect(intent.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(intent.expiresAt.getTime() - intent.requestedAt.getTime()).toBe(
      7 * 86_400_000,
    );
    const beforeStale = await stored(next.id);
    const stale = await post(author, 'requests/withdraw', {
      requestId: first.id,
    });
    expect(stale.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await stored(next.id)).toEqual(beforeStale);
  });

  it('concludes the requester on rejection instead of leaving the rejected round pending', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const first = await current(author, receiver);
    const rejected = await post(receiver, 'requests/reject', {
      requestId: first.id,
    });
    expect(rejected.body.code).toBe(BusinessCode.OK);
    expect(rejected.body.data.status).toBe('OK');
    const history = await stored(first.id);
    expect(history).toMatchObject({ status: 'REJECTED' });
    const intents = await database.db.query.relationshipIntent.findMany({
      where: or(intentScope(author, receiver), intentScope(receiver, author)),
    });
    expect(intents).toContainEqual(
      expect.objectContaining({
        authorAccount: author.account,
        status: 'REVOKED',
      }),
    );
    expect(intents.every((row) => row.status === 'REVOKED')).toBe(true);
    expect((await pairFor(author, receiver)).pair?.active).toBe(false);
    await open(author, receiver);
    const next = await current(author, receiver);
    expect(BigInt(next.id)).toBeGreaterThan(BigInt(first.id));
    expect(await stored(first.id)).toEqual(history);
    expect(
      await database.db.query.relationshipIntent.findFirst({
        where: intentScope(author, receiver),
      }),
    ).toMatchObject({ status: 'REQUESTED', requestId: BigInt(next.id) });
  });

  it('starts a new round after expiry and collapses a live reverse request into activation', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const first = await current(author, receiver);
    await expire(first);
    const oldEvidence = await stored(first.id);
    await open(author, receiver, 'Receiver on renewed request');
    const renewed = await current(author, receiver);
    expect(BigInt(renewed.id)).toBeGreaterThan(BigInt(first.id));
    expect((await page(author, 'SENT')).items).toContainEqual(
      expect.objectContaining({ id: first.id, status: 'EXPIRED' }),
    );
    expect((await pairFor(author, receiver)).pair?.active).toBe(false);
    const crossed = await open(receiver, author, 'Author at crossed request');
    expect(Number.isSafeInteger(crossed.body.data.threadId)).toBe(true);
    expect(crossed.body.data.threadId).toBeGreaterThan(0);
    expect((await pairFor(author, receiver)).pair).toMatchObject({
      active: true,
      threadId: crossed.body.data.threadId,
    });
    expect(await stored(renewed.id)).toMatchObject({ status: 'ACCEPTED' });
    if (!oldEvidence) throw new Error('missing expired evidence');
    const {
      status: _status,
      updatedAt: _updatedAt,
      ...immutableEvidence
    } = oldEvidence;
    expect(await stored(first.id)).toMatchObject(immutableEvidence);
  });

  it.each(['ACCEPT', 'REJECT', 'WITHDRAW'] as const)(
    'does not apply a stale %s decision to a replacement round after locating the pair',
    async (decision) => {
      const author = await actor();
      const receiver = await actor();
      await open(author, receiver);
      const first = await current(author, receiver);
      const intents = app.get(UserIntentService);
      const execute = intents.execute.bind(intents);
      const spy = vi
        .spyOn(intents, 'execute')
        .mockImplementationOnce(async (params, options) => {
          const withdrawn = await post(author, 'requests/withdraw', {
            requestId: first.id,
          });
          expect(withdrawn.body.code).toBe(BusinessCode.OK);
          await open(author, receiver, 'Replacement evidence');
          return execute(params, options);
        });
      try {
        const route =
          decision === 'ACCEPT'
            ? 'accept'
            : decision === 'REJECT'
              ? 'requests/reject'
              : 'requests/withdraw';
        const caller = decision === 'WITHDRAW' ? author : receiver;
        const response = await post(caller, route, { requestId: first.id });
        expect(response.body.code, JSON.stringify(response.body)).toBe(
          BusinessCode.OK,
        );
        expect(response.body.data).toEqual({ status: 'STALE_REQUEST' });
        const replacement = await current(author, receiver);
        expect(BigInt(replacement.id)).toBeGreaterThan(BigInt(first.id));
        expect(await stored(first.id)).toMatchObject({ status: 'WITHDRAWN' });
        expect((await pairFor(author, receiver)).pair?.active).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('returns the closed EXPIRED result for an exact expired request decision', async () => {
    const author = await actor();
    const receiver = await actor();
    await open(author, receiver);
    const row = await current(author, receiver);
    await expire(row);
    const response = await post(author, 'requests/withdraw', {
      requestId: row.id,
    });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(BusinessCode.OK);
    expect(response.body.data).toEqual({ status: 'EXPIRED' });
    expect((await pairFor(author, receiver)).pair?.active).toBe(false);
    expect((await page(author, 'SENT')).items).toContainEqual(
      expect.objectContaining({ id: row.id, status: 'EXPIRED' }),
    );
  });

  it('ends an established relationship by thread without rewriting accepted request history', async () => {
    const author = await actor();
    const receiver = await actor();
    const { row, threadId } = await acceptedPair(author, receiver);
    const history = await stored(row.id);
    expect(history).toMatchObject({ status: 'ACCEPTED' });
    const revoked = await post(author, 'revoke', { threadId });
    expect(revoked.body.code).toBe(BusinessCode.OK);
    expect(revoked.body.data.status).toBe('OK');
    expect((await pairFor(author, receiver)).pair?.active).toBe(false);
    expect(await stored(row.id)).toEqual(history);
  });
});
