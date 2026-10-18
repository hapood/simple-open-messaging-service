import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  messageThread,
  relationshipIntent,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app.js';
import {
  applyGroupIntentToProjection,
  type FriendRequestProjection,
  type GroupInviteProjectionInput,
} from '../web/src/app/services/friend-request-state.js';

describe('sent group application snapshots', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => app.close());

  it('retains snapshots through retries and decisions and rebuilds from full feed', async () => {
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
    const rebuild = async () => {
      const head = await database.db.query.account.findFirst({
        where: eq(account.id, member.id),
      });
      if (!head) throw new Error('missing applicant');
      const response = await request(app.getHttpServer())
        .get('/api/v1/user/state-feed')
        .set('Authorization', `Bearer ${member.token}`)
        .query({
          mode: 'full',
          after: 0,
          through: head.clientStateFeedEndId,
          take: 100,
        });
      expect(response.body.code, JSON.stringify(response.body)).toBe(
        BusinessCode.OK,
      );
      expect(response.body.data.hasMore).toBe(false);
      const items: Array<{
        eventType: string;
        feedId: number;
        namespaceId: number;
        body: Omit<GroupInviteProjectionInput, 'feedId' | 'namespaceId'>;
      }> = response.body.data.items;
      const groupItems = items.filter(
        (item) =>
          item.eventType === 'RELATIONSHIP_INTENT' &&
          item.body.group?.account === groupAccount,
      );
      expect(
        groupItems.some(
          (item) =>
            item.body.status === 'REQUESTED' &&
            item.body.direction === 'OUTGOING',
        ),
        JSON.stringify(groupItems),
      ).toBe(true);
      let projection: FriendRequestProjection | undefined;
      for (const item of items) {
        if (
          item.eventType !== 'RELATIONSHIP_INTENT' ||
          item.body.group?.account !== groupAccount
        )
          continue;
        const direction = item.body.direction ?? 'INCOMING';
        if (item.body.status === 'REQUESTED' && direction !== 'OUTGOING')
          continue;
        projection =
          applyGroupIntentToProjection(
            projection,
            {
              ...item.body,
              feedId: item.feedId,
              namespaceId: item.namespaceId,
            },
            Date.now(),
          ).record ?? undefined;
      }
      return projection;
    };

    await apply(snapshot);
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      snapshot,
      note,
    });
    expect(await rebuild()).toMatchObject({
      status: 'REQUESTED',
      snapshot,
      note,
      bucket: 'SENT',
    });
    await apply(nextSnapshot);
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      snapshot,
      note,
    });
    expect(await rebuild()).toMatchObject({
      status: 'REQUESTED',
      snapshot,
      note,
    });

    const reject = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/reject')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, account: member.account, namespaceId: 0 });
    expect(reject.body.code, JSON.stringify(reject.body)).toBe(BusinessCode.OK);
    expect(await intent()).toMatchObject({ snapshot, note });
    expect(await rebuild()).toMatchObject({
      status: 'REJECTED',
      snapshot,
      note,
    });

    await apply(nextSnapshot);
    expect(await intent()).toMatchObject({
      status: 'REQUESTED',
      snapshot: nextSnapshot,
      note,
    });
    const accept = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/accept')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, account: member.account, namespaceId: 0 });
    expect(accept.body.code, JSON.stringify(accept.body)).toBe(BusinessCode.OK);
    expect(await intent()).toMatchObject({ snapshot: nextSnapshot, note });
    expect(await rebuild()).toMatchObject({
      status: 'ACCEPTED',
      snapshot: nextSnapshot,
      note,
    });
  });
});
