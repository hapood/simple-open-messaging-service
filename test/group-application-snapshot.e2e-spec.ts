import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import type {
  PersonalRequestPage,
  RequestRecord,
} from '../shared/relationship-request.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  messageThread,
  relationshipIntent,
  relationshipRequest,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app.js';

describe('server-owned sent group application snapshots', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => app?.close());

  it('retains same-round evidence, concludes exact IDs and keeps earlier history', async () => {
    const owner = await seedUserWithSession(app, 'snapshot-group-owner');
    const member = await seedUserWithSession(app, 'snapshot-group-applicant');
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Application snapshot group' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const threadId: number = created.body.data.threadId;
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    if (!thread?.groupAccount) throw new Error('missing group identity');
    const groupAccount = thread.groupAccount;
    const target = { account: groupAccount, namespaceId: 0 };
    const snapshot = {
      displayName: 'Group on first application',
      avatar: null,
    };
    const nextSnapshot = {
      displayName: 'Group on next application',
      avatar: '/uploads/group-snapshot.webp',
    };
    const note = 'Application reason, not group description';

    const apply = async (value: typeof snapshot | typeof nextSnapshot) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ ...target, note, snapshot: value });
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
    };
    const intent = () =>
      database.db.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorAccount, member.account),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(relationshipIntent.receiverAccount, groupAccount),
          eq(relationshipIntent.receiverNamespaceId, 0),
        ),
      });
    const history = async (): Promise<RequestRecord[]> => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/relationship/requests')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ bucket: 'SENT', take: 50 });
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
      const page: PersonalRequestPage = response.body.data;
      // This fixture creates only two rounds, so its complete visible history
      // must fit in the first page; do not silently accept truncated evidence.
      expect(page.hasMore).toBe(false);
      return page.items.filter(
        (row) =>
          row.kind === 'GROUP_APPLICATION' &&
          row.author.account === member.account &&
          row.author.namespaceId === 0 &&
          row.receiver.account === groupAccount &&
          row.receiver.namespaceId === 0,
      );
    };
    const stored = (id: string) =>
      database.db.query.relationshipRequest.findFirst({
        where: eq(relationshipRequest.id, BigInt(id)),
      });

    await apply(snapshot);
    const firstHistory = await history();
    expect(firstHistory).toHaveLength(1);
    const first = firstHistory[0];
    expect(first).toMatchObject({
      status: 'REQUESTED',
      direction: 'OUTGOING',
      snapshot,
      note,
    });
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      requestId: BigInt(first.id),
    });
    const firstStored = await stored(first.id);
    expect(firstStored).toMatchObject({ status: 'REQUESTED', snapshot, note });

    await apply(nextSnapshot);
    expect(await history()).toEqual(firstHistory);
    expect(await stored(first.id)).toEqual(firstStored);
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      requestId: BigInt(first.id),
    });

    const reject = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/reject')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId: first.id });
    expect(reject.body.code, JSON.stringify(reject.body)).toBe(BusinessCode.OK);
    expect(reject.body.data.status).toBe('OK');
    expect(await history()).toEqual([
      { ...first, status: 'REJECTED', updatedAt: expect.any(String) },
    ]);
    const rejectedStored = await stored(first.id);
    expect(rejectedStored).toMatchObject({
      status: 'REJECTED',
      snapshot,
      note,
    });

    await apply(nextSnapshot);
    const nextHistory = await history();
    expect(nextHistory).toHaveLength(2);
    const next = nextHistory[0];
    expect(BigInt(next.id)).toBeGreaterThan(BigInt(first.id));
    expect(next).toMatchObject({
      status: 'REQUESTED',
      direction: 'OUTGOING',
      snapshot: nextSnapshot,
      note,
    });
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      requestId: BigInt(next.id),
    });
    expect(await stored(first.id)).toEqual(rejectedStored);

    // A stale first-round action cannot resolve by address to the new round.
    const stale = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/accept')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId: first.id });
    expect(stale.body.code).toBe(BusinessCode.OK);
    expect(stale.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await history()).toEqual(nextHistory);

    const accept = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/accept')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId: next.id });
    expect(accept.body.code, JSON.stringify(accept.body)).toBe(BusinessCode.OK);
    expect(accept.body.data.status).toBe('OK');
    expect(await stored(next.id)).toMatchObject({
      status: 'ACCEPTED',
      snapshot: nextSnapshot,
      note,
    });
    expect(await stored(first.id)).toEqual(rejectedStored);
    expect(await history()).toEqual([
      { ...next, status: 'ACCEPTED', updatedAt: expect.any(String) },
      nextHistory[1],
    ]);
  });
});
