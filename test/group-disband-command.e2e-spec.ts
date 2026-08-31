import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  domainCommand,
  group,
  messageThread,
  relationshipPair,
  threadMember,
  threadParticipant,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import {
  waitForAcceptedDomainCommands,
  waitForDomainCommand,
  waitForLocalFriendInvite,
} from './domain-command-helpers.js';

describe('group disband command fan-out', () => {
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
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ account: member.account });
    const inviteId = await waitForLocalFriendInvite(
      database.db,
      sent.body.data.commandId,
      owner.id,
      member.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ inviteId });
    await waitForDomainCommand(database.db, accepted.body.data.commandId);

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
    await waitForAcceptedDomainCommands(database.db, invited.body);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(joined.body.code).toBe(BusinessCode.OK);
    await waitForDomainCommand(database.db, joined.body.data.commandId);

    const beforeUnauthorized = await database.db
      .select({ id: domainCommand.id })
      .from(domainCommand);
    const unauthorized = await request(app.getHttpServer())
      .post('/api/v1/group/dissolve')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(unauthorized.body.code).toBe(BusinessCode.GROUP_FORBIDDEN);
    expect(
      await database.db.select({ id: domainCommand.id }).from(domainCommand),
    ).toHaveLength(beforeUnauthorized.length);

    const dissolved = await request(app.getHttpServer())
      .post('/api/v1/group/dissolve')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, deleteData: true });
    expect(dissolved.body).toMatchObject({
      code: BusinessCode.OK,
      data: { status: 'PENDING' },
    });
    const parentId = dissolved.body.data.commandId as string;
    await waitForDomainCommand(database.db, parentId);

    const parent = await database.db.query.domainCommand.findFirst({
      where: eq(domainCommand.id, BigInt(parentId)),
    });
    expect(parent).toMatchObject({
      commandType: 'DISBAND_GROUP',
      status: 'SUCCEEDED',
      progressCursor: Math.max(owner.id, member.id),
    });
    const children = await database.db
      .select()
      .from(domainCommand)
      .where(eq(domainCommand.parentCommandId, BigInt(parentId)))
      .orderBy(asc(domainCommand.id));
    expect(children).toHaveLength(2);
    expect(children.map(({ commandType }) => commandType)).toEqual([
      'REVOKE_DISSOLVED_GROUP_MEMBER',
      'REVOKE_DISSOLVED_GROUP_MEMBER',
    ]);
    expect(children.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        { threadId, memberUserId: owner.id, deleteData: true },
        { threadId, memberUserId: member.id, deleteData: false },
      ]),
    );
    for (const child of children) {
      await waitForDomainCommand(database.db, child.id.toString());
    }

    const hostedGroup = await database.db
      .select({ dissolvedAt: group.dissolvedAt })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(hostedGroup[0]?.dissolvedAt).toBeInstanceOf(Date);
    const roster = await database.db.query.threadMember.findMany({
      where: eq(threadMember.threadId, threadId),
    });
    expect(roster).toHaveLength(2);
    expect(roster.every(({ left }) => left)).toBe(true);
    const relationships = await database.db.query.relationshipPair.findMany({
      where: and(
        eq(relationshipPair.threadId, threadId),
        eq(relationshipPair.kind, 'GROUP_MEMBER'),
      ),
    });
    expect(relationships).toHaveLength(2);
    expect(relationships.every(({ active }) => !active)).toBe(true);
    const ownerParticipant =
      await database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, threadId),
          eq(threadParticipant.accountId, owner.id),
        ),
      });
    expect(ownerParticipant?.clearedSeq).toBeTypeOf('number');
  });
});
