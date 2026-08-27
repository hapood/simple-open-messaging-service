import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessException } from '../src/common/business.exception.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  MessageDeleteType,
  MessageReportStatus,
} from '../src/database/enums.js';
import {
  account as accountTable,
  admin,
  deletedMessage,
  message,
  messageReport,
  messageThread,
  user,
} from '../src/database/schema.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { MessageReportService } from '../src/message/message-report.service.js';
import { MessageService } from '../src/message/message.service.js';
import { seedAcceptedRelationship } from './seed.js';

describe('message report workflow', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let reports: MessageReportService;
  let reporterId: number;
  let creatorId: number;
  let adminId: number;
  let threadId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        DeletedMessageService,
        MessageReportService,
        {
          provide: MessageService,
          useValue: {
            writeSystemMessageInTx: () => ({ message: {} }),
          },
        },
      ],
    }).compile();
    database = mod.get(DatabaseService);
    reports = mod.get(MessageReportService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await database.db.execute(
      sql.raw('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE'),
    );
    const now = new Date();
    const users = await database.db
      .insert(user)
      .values([
        {
          account: 'reporter',
          name: 'Reporter',
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'creator',
          name: 'Creator',
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'moderator',
          name: 'Moderator',
          domain: 'local',
          updatedAt: now,
        },
      ])
      .returning({ id: user.id, account: user.account });
    reporterId = users.find((entry) => entry.account === 'reporter')!.id;
    creatorId = users.find((entry) => entry.account === 'creator')!.id;
    const moderatorId = users.find(
      (entry) => entry.account === 'moderator',
    )!.id;
    await database.db
      .insert(accountTable)
      .values(users.map((entry) => ({ id: entry.id })))
      .onConflictDoNothing({ target: accountTable.id });
    const [adminRow] = await database.db
      .insert(admin)
      .values({ userId: moderatorId, updatedAt: now })
      .returning({ id: admin.id });
    adminId = adminRow.id;
    const [threadRow] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        updatedAt: now,
        curSeq: 2,
        lastMessageSeq: 2,
        lastMessagePreview: 'second',
        lastMessageAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = threadRow.id;
    await seedAcceptedRelationship(
      database.db,
      reporterId,
      creatorId,
      threadId,
    );
    await database.db.insert(message).values([
      {
        seq: 1,
        threadId,
        creatorAccount: 'creator',
        creatorDomain: 'local',
        originSeq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'first' }),
        updatedAt: now,
      },
      {
        seq: 2,
        threadId,
        creatorAccount: 'creator',
        creatorDomain: 'local',
        originSeq: 2,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'second' }),
        updatedAt: now,
      },
    ]);
  });

  it('creates an atomic batch and makes a retry idempotent', async () => {
    const first = await reports.create(reporterId, {
      threadId,
      seqs: [1, 2, 2],
    });
    const retry = await reports.create(reporterId, {
      threadId,
      seqs: [1, 2],
    });

    expect(first.reports).toHaveLength(2);
    expect(retry.reports).toHaveLength(2);
    expect(await database.db.select().from(messageReport)).toHaveLength(2);
  });

  it('rejects the entire batch when any target is invalid', async () => {
    await expect(
      reports.create(reporterId, { threadId, seqs: [0, 99] }),
    ).rejects.toBeInstanceOf(BusinessException);
    expect(await database.db.select().from(messageReport)).toHaveLength(0);
  });

  it('commits UPHELD and the deletion fact in the same transaction', async () => {
    const created = await reports.create(reporterId, {
      threadId,
      seqs: [1],
    });
    const reportId = created.reports[0]!.id;
    const result = await reports.resolve(adminId, {
      reportIds: [reportId],
      status: MessageReportStatus.UPHELD,
    });

    expect(result.deletions).toHaveLength(1);
    const storedReport = await database.db.query.messageReport.findFirst({
      where: eq(messageReport.id, BigInt(reportId)),
    });
    const storedMessage = await database.db.query.message.findFirst({
      where: and(eq(message.threadId, threadId), eq(message.seq, 1)),
    });
    const deletion = await database.db.query.deletedMessage.findFirst({
      where: and(
        eq(deletedMessage.threadId, threadId),
        eq(deletedMessage.seq, 1),
      ),
    });
    const storedThread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    expect(storedReport).toMatchObject({
      status: MessageReportStatus.UPHELD,
      reviewedByAdminId: adminId,
    });
    expect(storedMessage?.isDeleted).toBe(true);
    expect(deletion?.type).toBe(MessageDeleteType.MODERATION_REMOVAL);
    expect(storedThread).toMatchObject({
      lastMessageSeq: 2,
      lastMessagePreview: 'second',
    });
  });

  it('allows REJECTED to be reconsidered but keeps UPHELD terminal', async () => {
    const created = await reports.create(reporterId, {
      threadId,
      seqs: [1],
    });
    const reportId = created.reports[0]!.id;
    await reports.resolve(adminId, {
      reportIds: [reportId],
      status: MessageReportStatus.REJECTED,
    });
    await expect(
      reports.resolve(adminId, {
        reportIds: [reportId],
        status: MessageReportStatus.UPHELD,
      }),
    ).resolves.toMatchObject({ deletions: [{ seq: 1 }] });
    await expect(
      reports.resolve(adminId, {
        reportIds: [reportId],
        status: MessageReportStatus.REJECTED,
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
