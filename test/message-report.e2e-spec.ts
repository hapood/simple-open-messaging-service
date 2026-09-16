import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { BusinessException } from '../src/common/business.exception.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  admin,
  deletedMessage,
  message,
  messageReport,
  durableTask,
  messageThread,
  account as user,
} from '../src/database/schema.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { ThreadPreviewModule } from '../src/message/thread-preview.module.js';
import { MessageReportService } from '../src/message/message-report.service.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { MessageService } from '../src/message/message.service.js';
import { seedAcceptedRelationship } from './seed.js';
import { truncateTablesForTest } from './support/truncate';

describe('message report workflow', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let reports: MessageReportService;
  let reporterId: number;
  let creatorId: number;
  let threadId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, ThreadPreviewModule],
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
    await mod.init();
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
    );
    const now = new Date();
    const users = await database.db
      .insert(user)
      .values([
        {
          account: 'reporter',
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'creator',
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'moderator',
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
    const [adminRow] = await database.db
      .insert(admin)
      .values({ userId: moderatorId, updatedAt: now })
      .returning({ id: admin.id });
    expect(adminRow.id).toBeGreaterThan(0);
    const [threadRow] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        updatedAt: now,
        curSeq: 2,
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

  it('deduplicates concurrent reports without updating an active row or retaining a reporter', async () => {
    expect(await reports.create(reporterId, { threadId, seq: 1 })).toEqual({});
    const [first] = await database.db.select().from(messageReport);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        reports.create(reporterId, { threadId, seq: 1 }),
      ),
    );
    const rows = await database.db.select().from(messageReport);
    expect(rows).toEqual([first]);
    expect(Object.keys(first).sort()).toEqual([
      'createdAt',
      'isDeleted',
      'seq',
      'threadId',
      'updatedAt',
    ]);
  });

  it('deduplicates reports from different authorized participants', async () => {
    await database.db
      .update(message)
      .set({ creatorAccount: 'moderator' })
      .where(eq(message.threadId, threadId));
    await Promise.all(
      [reporterId, creatorId].map((id) =>
        reports.create(id, { threadId, seq: 1 }),
      ),
    );
    expect(await database.db.select().from(messageReport)).toHaveLength(1);
  });

  it('rejects missing, own, system, call, and unauthorized message reports', async () => {
    await expect(
      reports.create(reporterId, { threadId, seq: 99 }),
    ).rejects.toBeInstanceOf(BusinessException);
    await expect(
      reports.create(creatorId, { threadId, seq: 1 }),
    ).rejects.toBeInstanceOf(BusinessException);
    for (const contentType of ['SYSTEM'] as const) {
      await database.db
        .update(message)
        .set({
          contentType,
          creatorAccount: contentType === 'SYSTEM' ? '$system' : 'creator',
          creatorDomain: 'local',
        })
        .where(eq(message.threadId, threadId));
      await expect(
        reports.create(reporterId, { threadId, seq: 1 }),
      ).rejects.toBeInstanceOf(BusinessException);
    }
    await expect(
      reports.create(99999, { threadId, seq: 1 }),
    ).rejects.toBeInstanceOf(BusinessException);
    expect(await database.db.select().from(messageReport)).toEqual([]);
  });

  it('reactivates a dismissed report but never inserts a second row', async () => {
    await reports.create(reporterId, { threadId, seq: 1 });
    const [original] = await database.db.select().from(messageReport);
    await reports.dismiss({ threadId, seq: 1 });
    expect(
      (await reports.list({ skip: 0, take: 20, isDeleted: false })).total,
    ).toBe(0);
    expect(
      (await reports.list({ skip: 0, take: 20, isDeleted: true })).total,
    ).toBe(1);
    await reports.create(reporterId, { threadId, seq: 1 });
    const [reactivated] = await database.db.select().from(messageReport);
    expect(reactivated).toMatchObject({
      threadId,
      seq: 1,
      isDeleted: false,
      createdAt: original.createdAt,
    });
    expect(
      (await reports.list({ skip: 0, take: 20, isDeleted: false })).list[0],
    ).not.toHaveProperty('reporter');
  });

  it('commits concurrent deletions once and only enqueues content fanouts', async () => {
    await reports.create(reporterId, { threadId, seq: 1 });
    const deletion = mod.get(DeletedMessageService);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => deletion.deleteByModeration(threadId, 1)),
    );
    expect(new Set(results.map((result) => result.deletionSeq)).size).toBe(1);
    await deletion.deleteByModeration(threadId, 1);
    const facts = await database.db.select().from(deletedMessage);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      threadId,
      messageSeq: 1,
      deletionSeq: 1,
      type: MessageDeleteType.MODERATION_REMOVAL,
    });
    const [stored] = await database.db
      .select()
      .from(message)
      .where(and(eq(message.threadId, threadId), eq(message.seq, 1)));
    expect(stored.isDeleted).toBe(true);
    expect((await database.db.select().from(messageReport))[0].isDeleted).toBe(
      true,
    );
    const fanout = await database.db
      .select()
      .from(durableTask)
      .where(eq(durableTask.taskType, DurableTaskType.FAN_OUT_THREAD_CONTENT));
    expect(fanout).toHaveLength(1);
    expect(fanout[0].payload).toMatchObject({ threadId, tombstoneEndSeq: 1 });
    const tasks = await database.db.select().from(durableTask);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.taskType).sort()).toEqual(
      [
        DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
        DurableTaskType.FAN_OUT_THREAD_CONTENT,
      ].sort(),
    );
    // Retrying a previously accepted report succeeds without reactivating deleted content.
    expect(await reports.create(reporterId, { threadId, seq: 1 })).toEqual({});
    expect((await database.db.select().from(messageReport))[0].isDeleted).toBe(
      true,
    );
  });

  it('rejects invalid deletion and archives reports on withdrawal', async () => {
    await expect(
      mod.get(DeletedMessageService).deleteByModeration(threadId, 99),
    ).rejects.toBeInstanceOf(BusinessException);
    await reports.create(reporterId, { threadId, seq: 2 });
    await mod.get(DeletedMessageService).withdraw(creatorId, threadId, 2);
    expect((await database.db.select().from(messageReport))[0].isDeleted).toBe(
      true,
    );
    await mod.get(DeletedMessageService).withdraw(creatorId, threadId, 1);
    await expect(
      reports.create(reporterId, { threadId, seq: 1 }),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
