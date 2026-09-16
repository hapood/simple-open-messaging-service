import { accountAddressInTx } from '../src/user/account-address.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, desc, eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupMetaMemberFeed,
  message,
  accountThreadState,
} from '../src/database/schema.js';
import { readCurrentGroupMemberInTx } from '../src/group/meta/current-group-roster.js';
import { seedUserWithSession } from './seed.js';
import { waitForLocalRelationshipRequest } from './durable-task-helpers.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('group membership re-entry and ownership transfer', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => app.close());

  afterEach(async () => {
    // Source transactions now admit background fanout. Do not truncate their
    // threads while the scheduler is still executing committed work.
    await vi.waitFor(
      async () => {
        const outstanding = await database.pool.query(`
        SELECT id, status FROM "DurableTask"
        WHERE "taskType" IN ('FAN_OUT_THREAD_CONTENT', 'FAN_OUT_ACCOUNT_THREAD_CONTENT')
          AND status NOT IN ('SUCCEEDED', 'SUPERSEDED', 'REJECTED')
      `);
        expect(outstanding.rows).toEqual([]);
      },
      { timeout: 15000, interval: 50 },
    );
  });

  async function befriend(
    first: { id: number; token: string; account: string },
    second: { id: number; token: string; account: string },
  ): Promise<void> {
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ account: second.account, domain: 'local' });
    expect(sent.body.code).toBe(BusinessCode.OK);
    await waitForLocalRelationshipRequest(
      database.db,
      sent.body,
      first.id,
      second.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ account: first.account, domain: 'local' });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data).toMatchObject({ status: 'OK' });
  }

  async function inviteAndJoin(
    groupId: number,
    manager: { token: string },
    member: { id: number; token: string; account: string },
  ): Promise<void> {
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ groupId, users: [{ account: member.account, domain: 'local' }] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    expect(
      invited.body.data.invited,
      JSON.stringify(invited.body),
    ).toContainEqual({ account: member.account, domain: 'local' });
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId });
    expect(joined.body.code).toBe(BusinessCode.OK);
  }

  async function currentMember(threadId: number, userId: number) {
    return database.db.transaction((tx) =>
      readCurrentGroupMemberInTx(tx, threadId, userId),
    );
  }

  async function latestMemberFact(threadId: number, userId: number) {
    const member = await accountAddressInTx(database.db, userId);
    return database.db.query.groupMetaMemberFeed.findFirst({
      where: and(
        eq(groupMetaMemberFeed.threadId, threadId),
        eq(groupMetaMemberFeed.memberAccount, member.account),
        eq(groupMetaMemberFeed.memberDomain, member.domain),
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

    const oldMessage = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        threadId: groupId,
        content: JSON.stringify({ text: 'before-exit' }),
      });
    expect(oldMessage.body.code).toBe(BusinessCode.OK);
    const oldSeq = oldMessage.body.data.seq as number;

    const kicked = await request(app.getHttpServer())
      .post('/api/v1/group/kick')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId, account: member.account, domain: 'local' });
    expect(kicked.body.code).toBe(BusinessCode.OK);
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
    expect(participant!.lastReadSeq).toBeGreaterThanOrEqual(oldSeq);
    expect(participant!.previewSeqs).toEqual([]);
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

  it('transfers ownership, keeps the old owner as admin, and lets the new owner kick them', async () => {
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
    expect(await currentMember(groupId, oldOwner.id)).toMatchObject({
      role: 'ADMIN',
    });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, groupId),
          eq(accountThreadState.accountId, oldOwner.id),
        ),
      }),
    ).toMatchObject({ role: 'ADMIN' });
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
