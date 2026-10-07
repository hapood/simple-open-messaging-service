import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, asc, count, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  durableTask,
  groupAccount as group,
  groupMetaMemberFeed,
  messageThread,
  relationshipPair,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import { waitForDurableTask } from './durable-task-helpers.js';
import { truncateTablesForTest } from './support/truncate';

describe('group disband task fan-out', () => {
  let app: NestFastifyApplication;
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
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => app?.close());

  it('marks a hosted group terminal, checkpoints children, and revokes every active member', async () => {
    const owner = await seedUserWithSession(app, 'disband-owner');
    const member = await seedUserWithSession(app, 'disband-member');
    // The user-intent flow commits synchronously; only the group steps below
    // travel through durable tasks.
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        account: member.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      });
    expect(sent.body.code).toBe(BusinessCode.OK);
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({
        account: owner.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
      });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Disband fan-out' });
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        users: [{ account: member.account, domain: localIdentityDomain() }],
      });
    expect(invited.body.code).toBe(BusinessCode.OK);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(joined.body.code).toBe(BusinessCode.OK);
    const [threadBeforeDissolve] = await database.db
      .select({ groupId: messageThread.groupAccountId })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(threadBeforeDissolve?.groupId).toBeTypeOf('number');
    const [metaBeforeDissolve] = await database.db
      .select({ value: count() })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));

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
      .where(
        and(
          eq(durableTask.scopeKey, parent!.scopeKey),
          eq(durableTask.taskType, 'FORCE_REVOKE_GROUP_MEMBER'),
        ),
      )
      .orderBy(asc(durableTask.id));
    expect(children).toHaveLength(2);
    expect(children.map(({ taskType }) => taskType)).toEqual([
      'FORCE_REVOKE_GROUP_MEMBER',
      'FORCE_REVOKE_GROUP_MEMBER',
    ]);
    expect(children.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        {
          threadId,
          memberUserId: owner.id,
        },
        {
          threadId,
          memberUserId: member.id,
        },
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
      .innerJoin(group, eq(group.id, messageThread.groupAccountId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(hostedGroup[0]?.dissolvedAt).toBeInstanceOf(Date);
    expect(hostedGroup[0]?.clearedSeq).toBeNull();
    const [metaAfterDissolve] = await database.db
      .select({ value: count() })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));
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
