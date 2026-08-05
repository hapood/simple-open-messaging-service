import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { AdminAuthService } from '../src/admin/admin-auth.service.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  AdminRole,
  MessageDeleteType,
  MessageReportStatus,
} from '../src/database/enums.js';
import {
  admin,
  adminActionLog,
  deletedMessage,
  message,
  messageReport,
  messageThread,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { seedSession, seedUser } from './seed.js';

describe('message report HTTP workflow', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let adminAuth: AdminAuthService;

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = fixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    adminAuth = app.get(AdminAuthService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
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
        curSeq: 1,
        lastMessageSeq: 1,
        lastMessagePreview: 'second',
        lastMessageAt: now,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    await database.db.insert(threadParticipant).values([
      { userId: reporter.id, threadId: thread.id, updatedAt: now },
      { userId: creator.id, threadId: thread.id, updatedAt: now },
    ]);
    await database.db.insert(message).values([
      {
        seq: 0,
        threadId: thread.id,
        creator: creator.id,
        originSeq: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'first' }),
        updatedAt: now,
      },
      {
        seq: 1,
        threadId: thread.id,
        creator: creator.id,
        originSeq: 1,
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

  it('enforces consumer/admin auth and admin mutation RBAC', async () => {
    const conversation = await seedConversation();
    const anonymous = await request(app.getHttpServer())
      .post('/api/v1/message-reports')
      .send({ threadId: conversation.threadId, seqs: [0] });
    expect(anonymous.status).toBe(401);

    const created = await consumerPost(
      conversation.reporterToken,
      'message-reports',
      { threadId: conversation.threadId, seqs: [0] },
    );
    expect(created.body.code).toBe(BusinessCode.OK);
    const reportId = created.body.data.reports[0].id as string;

    const viewer = await seedAdmin('viewer', AdminRole.VIEWER);
    const list = await adminPost(viewer.cookie, 'message-reports', {
      status: MessageReportStatus.PENDING,
      take: 20,
    });
    expect(list.body.code).toBe(BusinessCode.OK);
    expect(list.body.data.list).toHaveLength(1);

    const forbidden = await adminPost(
      viewer.cookie,
      'message-reports/resolve',
      { reportIds: [reportId], status: MessageReportStatus.UPHELD },
    );
    expect(forbidden.body.code).toBe(BusinessCode.FORBIDDEN);
    const stored = await database.db.query.messageReport.findFirst({
      where: eq(messageReport.id, BigInt(reportId)),
    });
    expect(stored?.status).toBe(MessageReportStatus.PENDING);
  });

  it('supports batch reporting, rejection, reconsideration, and durable deletion reads', async () => {
    const conversation = await seedConversation();
    const moderator = await seedAdmin('moderator', AdminRole.ADMIN);
    const created = await consumerPost(
      conversation.reporterToken,
      'message-reports',
      { threadId: conversation.threadId, seqs: [0, 1] },
    );
    expect(created.body.code).toBe(BusinessCode.OK);
    expect(created.body.data.reports).toHaveLength(2);
    const [firstReport, secondReport] = created.body.data.reports as {
      id: string;
      messageSeq: number;
    }[];

    const rejected = await adminPost(
      moderator.cookie,
      'message-reports/resolve',
      {
        reportIds: [firstReport.id],
        status: MessageReportStatus.REJECTED,
      },
    );
    expect(rejected.body.code).toBe(BusinessCode.OK);

    const upheld = await adminPost(
      moderator.cookie,
      'message-reports/resolve',
      {
        reportIds: [firstReport.id, secondReport.id],
        status: MessageReportStatus.UPHELD,
      },
    );
    expect(upheld.body.code).toBe(BusinessCode.OK);
    expect(upheld.body.data.deletions).toHaveLength(2);

    const visible = await consumerPost(
      conversation.reporterToken,
      'query-messages',
      {
        threadId: conversation.threadId,
        skip: 0,
        take: 20,
        orderBy: 'desc',
      },
    );
    expect(visible.body.code).toBe(BusinessCode.OK);
    expect(visible.body.data).toEqual([]);

    const durable = await consumerPost(
      conversation.reporterToken,
      'deleted-messages/query',
      { threadId: conversation.threadId, afterId: '0', take: 20 },
    );
    expect(durable.body.code).toBe(BusinessCode.OK);
    expect(durable.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 0, type: MessageDeleteType.REPORT }),
        expect.objectContaining({ seq: 1, type: MessageDeleteType.REPORT }),
      ]),
    );

    const rows = await database.db
      .select({ status: messageReport.status })
      .from(messageReport);
    expect(rows.every((row) => row.status === MessageReportStatus.UPHELD)).toBe(
      true,
    );
    const tombstones = await database.db
      .select()
      .from(deletedMessage)
      .where(eq(deletedMessage.threadId, conversation.threadId));
    expect(tombstones).toHaveLength(2);
    const audit = await database.db.query.adminActionLog.findFirst({
      where: and(
        eq(adminActionLog.adminId, moderator.id),
        eq(adminActionLog.action, 'message_report.resolve'),
      ),
    });
    expect(audit?.success).toBe(true);
  });
});
