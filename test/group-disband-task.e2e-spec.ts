import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, asc, count, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  durableTask,
  group,
  groupMetaMemberFeed,
  messageThread,
  relationshipPair,
  accountThreadState,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import {
  waitForAcceptedDurableTasks,
  waitForDurableTask,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';

describe('group disband task fan-out', () => {
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

  afterAll(async () => app?.close());

  it('marks a hosted group terminal, checkpoints children, and revokes every active member', async () => {
    const owner = await seedUserWithSession(app, 'disband-owner');
    const member = await seedUserWithSession(app, 'disband-member');
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ account: member.account, domain: 'local' });
    await waitForLocalRelationshipRequest(
      database.db,
      sent.body.data.taskId,
      owner.id,
      member.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ account: owner.account, domain: 'local' });
    await waitForDurableTask(database.db, accepted.body.data.taskId);

    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Disband fan-out' });
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userIds: [member.id] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(database.db, invited.body);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(joined.body.code).toBe(BusinessCode.OK);
    await waitForDurableTask(database.db, joined.body.data.taskId);
    const [threadBeforeDissolve] = await database.db
      .select({ groupId: messageThread.groupId })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(threadBeforeDissolve?.groupId).toBeTypeOf('number');
    const [metaBeforeDissolve] = await database.db
      .select({ value: count() })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.groupId, threadBeforeDissolve!.groupId!));

    const beforeUnauthorized = await database.db
      .select({ id: durableTask.id })
      .from(durableTask);
    const unauthorized = await request(app.getHttpServer())
      .post('/api/v1/group/dissolve')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(unauthorized.body.code).toBe(BusinessCode.GROUP_FORBIDDEN);
    expect(
      await database.db.select({ id: durableTask.id }).from(durableTask),
    ).toHaveLength(beforeUnauthorized.length);

    const dissolved = await request(app.getHttpServer())
      .post('/api/v1/group/dissolve')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(dissolved.body).toMatchObject({
      code: BusinessCode.OK,
      data: { status: 'PENDING' },
    });
    const parentId = dissolved.body.data.taskId as string;
    await waitForDurableTask(database.db, parentId);

    const parent = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, BigInt(parentId)),
    });
    expect(parent).toMatchObject({
      taskType: 'DISBAND_GROUP',
      status: 'SUCCEEDED',
      checkpoint: { afterPairId: expect.stringMatching(/^[1-9]\d*$/) },
    });
    const children = await database.db
      .select()
      .from(durableTask)
      .where(eq(durableTask.parentTaskId, BigInt(parentId)))
      .orderBy(asc(durableTask.id));
    expect(children).toHaveLength(2);
    expect(children.map(({ taskType }) => taskType)).toEqual([
      'REVOKE_DISSOLVED_GROUP_MEMBER',
      'REVOKE_DISSOLVED_GROUP_MEMBER',
    ]);
    expect(children.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        { threadId, memberUserId: owner.id },
        { threadId, memberUserId: member.id },
      ]),
    );
    for (const child of children) {
      await waitForDurableTask(database.db, child.id.toString());
    }

    const hostedGroup = await database.db
      .select({
        dissolvedAt: group.dissolvedAt,
        clearedSeq: messageThread.clearedSeq,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(hostedGroup[0]?.dissolvedAt).toBeInstanceOf(Date);
    expect(hostedGroup[0]?.clearedSeq).toBeNull();
    const [metaAfterDissolve] = await database.db
      .select({ value: count() })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.groupId, threadBeforeDissolve!.groupId!));
    expect(metaAfterDissolve.value).toBe(metaBeforeDissolve.value);
    const relationships = await database.db.query.relationshipPair.findMany({
      where: and(
        eq(relationshipPair.threadId, threadId),
        eq(relationshipPair.kind, 'GROUP_MEMBER'),
      ),
    });
    expect(relationships).toHaveLength(2);
    expect(relationships.every(({ active }) => !active)).toBe(true);
  });
});
