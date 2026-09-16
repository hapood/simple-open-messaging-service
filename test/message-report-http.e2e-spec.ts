import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import { AdminAuthService } from '../src/admin/admin-auth.service.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AdminRole, MessageDeleteType } from '../src/database/enums.js';
import {
  admin,
  adminActionLog,
  deletedMessage,
  message,
  messageReport,
  messageThread,
} from '../src/database/schema.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('message report HTTP workflow', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let adminAuth: AdminAuthService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    await app.get(DurableTaskSchedulerService).stop();
    adminAuth = app.get(AdminAuthService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(database.pool, 'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => app.close());

  async function seedAdmin(account: string, role: AdminRole) {
    const adminUser = await seedUser(app, account);
    const [created] = await database.db
      .insert(admin)
      .values({
        userId: adminUser.id,
        role,
        enabled: true,
        updatedAt: new Date(),
      })
      .returning({ id: admin.id });
    const token = await adminAuth.createAdminSession(created.id, {});
    return {
      id: created.id,
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
    };
  }

  async function seedConversation() {
    const reporter = await seedUser(app, 'reporter');
    const creator = await seedUser(app, 'creator');
    const reporterToken = await seedSession(app, reporter.id);
    const now = new Date();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 2,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    await seedAcceptedRelationship(
      database.db,
      reporter.id,
      creator.id,
      thread.id,
    );
    await database.db.insert(message).values([
      {
        seq: 1,
        threadId: thread.id,
        creatorAccount: creator.account,
        creatorDomain: 'local',
        originSeq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'first' }),
        updatedAt: now,
      },
      {
        seq: 2,
        threadId: thread.id,
        creatorAccount: creator.account,
        creatorDomain: 'local',
        originSeq: 2,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'second' }),
        updatedAt: now,
      },
    ]);
    return { reporter, creator, reporterToken, threadId: thread.id };
  }

  const consumerPost = (token: string, path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const adminPost = (cookie: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/${path}`)
      .set('Cookie', cookie)
      .send(body);

  it('enforces consumer/admin authentication and mutation roles', async () => {
    const c = await seedConversation();
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/message-reports')
          .send({ threadId: c.threadId, seq: 1 })
      ).status,
    ).toBe(401);
    const created = await consumerPost(c.reporterToken, 'message-reports', {
      threadId: c.threadId,
      seq: 1,
    });
    expect(created.body.code).toBe(BusinessCode.OK);
    expect(created.body.data).toEqual({});
    const viewer = await seedAdmin('viewer', AdminRole.VIEWER);
    const list = await adminPost(viewer.cookie, 'message-reports');
    expect(list.body.code).toBe(BusinessCode.OK);
    expect(list.body.data.list).toHaveLength(1);
    expect(list.body.data.list[0]).not.toHaveProperty('reporter');
    expect(list.body.data.list[0]).not.toHaveProperty('status');
    for (const path of ['messages/delete', 'message-reports/delete']) {
      const forbidden = await adminPost(viewer.cookie, path, {
        threadId: c.threadId,
        seq: 1,
      });
      expect(forbidden.body.code).toBe(BusinessCode.FORBIDDEN);
    }
    expect(await database.db.select().from(deletedMessage)).toHaveLength(0);
  });

  it('accepts only one target and returns no report or processing result to the consumer', async () => {
    const c = await seedConversation();
    for (const body of [
      { threadId: c.threadId, seqs: [1, 2] },
      { threadId: c.threadId, seq: -1 },
      { threadId: c.threadId, seq: 1.5 },
    ]) {
      const res = await consumerPost(c.reporterToken, 'message-reports', body);
      expect(res.body.code).not.toBe(BusinessCode.OK);
    }
    for (let i = 0; i < 2; i++) {
      const res = await consumerPost(c.reporterToken, 'message-reports', {
        threadId: c.threadId,
        seq: 1,
      });
      expect(res.body.code).toBe(BusinessCode.OK);
      expect(res.body.data).toEqual({});
    }
    expect(await database.db.select().from(messageReport)).toHaveLength(1);
  });

  it('removes and reactivates a report, then commits individual message deletions', async () => {
    const c = await seedConversation();
    const moderator = await seedAdmin('moderator', AdminRole.ADMIN);
    for (const seq of [1, 2]) {
      expect(
        (
          await consumerPost(c.reporterToken, 'message-reports', {
            threadId: c.threadId,
            seq,
          })
        ).body.code,
      ).toBe(BusinessCode.OK);
    }
    expect(
      (
        await adminPost(moderator.cookie, 'message-reports/delete', {
          threadId: c.threadId,
          seq: 1,
        })
      ).body.code,
    ).toBe(BusinessCode.OK);
    let list = await adminPost(moderator.cookie, 'message-reports');
    expect(list.body.data.list).toHaveLength(1);
    await consumerPost(c.reporterToken, 'message-reports', {
      threadId: c.threadId,
      seq: 1,
    });
    list = await adminPost(moderator.cookie, 'message-reports');
    expect(list.body.data.list).toHaveLength(2);
    expect(list.body.data.list[0].message.content).toBe(
      JSON.stringify({ text: 'first' }),
    );
    for (const seq of [1, 2]) {
      const res = await adminPost(moderator.cookie, 'messages/delete', {
        threadId: c.threadId,
        seq,
      });
      expect(res.body.code).toBe(BusinessCode.OK);
      expect(res.body.data).toMatchObject({
        threadId: c.threadId,
        messageSeq: seq,
        deletionSeq: expect.any(Number),
      });
      expect(res.body.data).not.toHaveProperty('taskId');
      const repeated = await adminPost(moderator.cookie, 'messages/delete', {
        threadId: c.threadId,
        seq,
      });
      expect(repeated.body.data).toEqual(res.body.data);
    }
    const durable = await consumerPost(
      c.reporterToken,
      'deleted-messages/query',
      { threadId: c.threadId, after: 0, take: 20 },
    );
    expect(durable.body.code).toBe(BusinessCode.OK);
    expect(durable.body.data.tombstones).toHaveLength(2);
    expect(durable.body.data.tombstones[0].type).toBe(
      MessageDeleteType.MODERATION_REMOVAL,
    );
    expect(await database.db.select().from(deletedMessage)).toHaveLength(2);
    const removed = await adminPost(moderator.cookie, 'message-reports', {
      isDeleted: true,
    });
    expect(removed.body.data.list).toHaveLength(2);
    expect(
      removed.body.data.list.every(
        (row: { message: { isDeleted: boolean } }) => row.message.isDeleted,
      ),
    ).toBe(true);
    const audit = await database.db.query.adminActionLog.findFirst({
      where: and(
        eq(adminActionLog.adminId, moderator.id),
        eq(adminActionLog.action, 'message.delete'),
      ),
    });
    expect(audit?.status).toBe('SUCCEEDED');
  });
});
