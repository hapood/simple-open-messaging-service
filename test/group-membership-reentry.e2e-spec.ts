import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupMetaMemberFeed,
  message,
  messageThread,
  accountThreadState,
} from '../src/database/schema.js';
import { readCurrentGroupMemberInTx } from '../src/group-meta/current-group-roster.js';
import { seedUserWithSession } from './seed.js';
import {
  waitForAcceptedDurableTask,
  waitForAcceptedDurableTasks,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';

describe('group membership re-entry and ownership transfer', () => {
  let app: INestApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = fixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => app.close());

  async function befriend(
    first: { id: number; token: string },
    second: { id: number; token: string },
  ): Promise<void> {
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ account: second.account, domain: 'local' });
    expect(sent.body.code).toBe(BusinessCode.OK);
    await waitForLocalRelationshipRequest(
      database.db,
      sent.body.data.taskId,
      first.id,
      second.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ account: first.account, domain: 'local' });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(database.db, accepted.body);
  }

  async function inviteAndJoin(
    groupId: number,
    manager: { token: string },
    member: { id: number; token: string },
  ): Promise<void> {
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ groupId, userIds: [member.id] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    expect(invited.body.data.invited, JSON.stringify(invited.body)).toContain(
      member.id,
    );
    await waitForAcceptedDurableTasks(database.db, invited.body);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId });
    expect(joined.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(database.db, joined.body);
  }

  async function currentMember(threadId: number, userId: number) {
    return database.db.transaction(async (tx) => {
      const thread = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupId: true },
      });
      return readCurrentGroupMemberInTx(tx, thread!.groupId!, userId);
    });
  }

  async function latestMemberFact(threadId: number, userId: number) {
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { groupId: true },
    });
    return database.db.query.groupMetaMemberFeed.findFirst({
      where: and(
        eq(groupMetaMemberFeed.groupId, thread!.groupId!),
        eq(groupMetaMemberFeed.memberUserId, userId),
      ),
      orderBy: desc(groupMetaMemberFeed.feedId),
    });
  }

  it('joins, is kicked, rejoins the same thread, and sends a message', async () => {
    const owner = await seedUserWithSession(app, 'reentry-owner');
    const member = await seedUserWithSession(app, 'reentry-member');
    await befriend(owner, member);
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Re-entry' });
    const groupId = created.body.data.threadId as number;
    await inviteAndJoin(groupId, owner, member);

    const kicked = await request(app.getHttpServer())
      .post('/api/v1/group/kick')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId, account: member.account, domain: 'local' });
    expect(kicked.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(database.db, kicked.body);
    expect(await currentMember(groupId, member.id)).toBeUndefined();
    const departed = await latestMemberFact(groupId, member.id);
    expect(departed).toMatchObject({ operation: 'DEPART', body: {} });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, groupId),
          eq(accountThreadState.accountId, member.id),
        ),
      }),
    ).toMatchObject({ messageVisibleThroughSeq: expect.any(Number) });
    await inviteAndJoin(groupId, owner, member);
    const rejoined = await latestMemberFact(groupId, member.id);
    const participant = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(accountThreadState.threadId, groupId),
        eq(accountThreadState.accountId, member.id),
      ),
    });
    expect(participant?.messageVisibleThroughSeq).toBeNull();
    expect(rejoined).toMatchObject({ operation: 'UPSERT' });
    expect(rejoined!.feedId).toBeGreaterThan(departed!.feedId);

    const sent = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${member.token}`)
      .send({
        threadId: groupId,
        content: JSON.stringify({ text: 'after-rejoin' }),
        contentType: 'PURE_TEXT',
      });
    expect(sent.body.code).toBe(BusinessCode.OK);
    expect(
      await database.db.query.message.findFirst({
        where: and(
          eq(message.threadId, groupId),
          eq(message.creatorAccount, 'reentry-member'),
          eq(message.creatorDomain, 'local'),
        ),
      }),
    ).toBeDefined();
  });

  it('transfers ownership, demotes the old owner, and lets the new owner kick them', async () => {
    const oldOwner = await seedUserWithSession(app, 'transfer-old-owner');
    const newOwner = await seedUserWithSession(app, 'transfer-new-owner');
    await befriend(oldOwner, newOwner);
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${oldOwner.token}`)
      .send({ name: 'Transfer' });
    const groupId = created.body.data.threadId as number;
    await inviteAndJoin(groupId, oldOwner, newOwner);

    const transferred = await request(app.getHttpServer())
      .post('/api/v1/group/transfer')
      .set('Authorization', `Bearer ${oldOwner.token}`)
      .send({ groupId, account: newOwner.account, domain: 'local' });
    expect(transferred.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(database.db, transferred.body);
    expect(await currentMember(groupId, oldOwner.id)).toMatchObject({
      role: 'MEMBER',
    });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, groupId),
          eq(accountThreadState.accountId, oldOwner.id),
        ),
      }),
    ).toMatchObject({ role: 'MEMBER' });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, groupId),
          eq(accountThreadState.accountId, newOwner.id),
        ),
      }),
    ).toMatchObject({ role: 'OWNER' });

    const kicked = await request(app.getHttpServer())
      .post('/api/v1/group/kick')
      .set('Authorization', `Bearer ${newOwner.token}`)
      .send({ groupId, account: oldOwner.account, domain: 'local' });
    expect(kicked.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(database.db, kicked.body);
    expect(await currentMember(groupId, oldOwner.id)).toBeUndefined();
    expect(await latestMemberFact(groupId, oldOwner.id)).toMatchObject({
      operation: 'DEPART',
      body: {},
    });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, groupId),
          eq(accountThreadState.accountId, oldOwner.id),
        ),
      }),
    ).toMatchObject({
      messageVisibleThroughSeq: expect.any(Number),
    });
  });
});
