import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  message,
  relationshipIntent,
  threadParticipant,
} from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';

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
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ toUserId: second.id });
    expect(sent.body.code).toBe(BusinessCode.OK);
    const intent = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, first.id),
        eq(relationshipIntent.subjectUserId, second.id),
      ),
    });
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ inviteId: intent!.id.toString() });
    expect(accepted.body.code).toBe(BusinessCode.OK);
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
    expect(invited.body.data.invited).toContain(member.id);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId });
    expect(joined.body.code).toBe(BusinessCode.OK);
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
      .send({ groupId, userId: member.id });
    expect(kicked.body.code).toBe(BusinessCode.OK);
    expect(
      await database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, groupId),
          eq(threadParticipant.userId, member.id),
        ),
      }),
    ).toMatchObject({ messageVisibleBeforeSeq: expect.any(Number) });

    await inviteAndJoin(groupId, owner, member);
    const participant = await database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.threadId, groupId),
        eq(threadParticipant.userId, member.id),
      ),
    });
    expect(participant?.messageVisibleBeforeSeq).toBeNull();

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
          eq(message.creator, member.id),
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
      .send({ groupId, toUserId: newOwner.id });
    expect(transferred.body.code).toBe(BusinessCode.OK);
    expect(
      await database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, groupId),
          eq(threadParticipant.userId, oldOwner.id),
        ),
      }),
    ).toMatchObject({ role: 'MEMBER' });

    const kicked = await request(app.getHttpServer())
      .post('/api/v1/group/kick')
      .set('Authorization', `Bearer ${newOwner.token}`)
      .send({ groupId, userId: oldOwner.id });
    expect(kicked.body.code).toBe(BusinessCode.OK);
    expect(
      await database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, groupId),
          eq(threadParticipant.userId, oldOwner.id),
        ),
      }),
    ).toMatchObject({
      role: 'MEMBER',
      messageVisibleBeforeSeq: expect.any(Number),
    });
  });
});
