import { Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { MessageReportStatus } from '../database/enums.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import {
  message,
  messageReport,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import type {
  AdminListMessageReportsDto,
  CreateMessageReportsDto,
  ResolveMessageReportsDto,
} from './message-report.dto.js';
import { DeletedMessageService } from './deleted-message.service.js';
import { MessageService } from './message.service.js';
import { SystemMessageType } from './system-message.js';

@Injectable()
export class MessageReportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly deletedMessages: DeletedMessageService,
    private readonly messages: MessageService,
  ) {}

  async create(userId: number, dto: CreateMessageReportsDto) {
    const seqs = [...new Set(dto.seqs)];
    return this.database.db.transaction(async (tx) => {
      const participant = await tx.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, dto.threadId),
          eq(threadParticipant.accountId, userId),
        ),
        columns: { id: true },
      });
      if (
        !participant ||
        !(await isThreadMutuallyAuthorized(tx, userId, dto.threadId))
      ) {
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'thread unavailable',
        );
      }

      const targets = await tx
        .select({
          id: message.id,
          seq: message.seq,
          creatorAccount: message.creatorAccount,
          creatorDomain: message.creatorDomain,
          contentType: message.contentType,
          isDeleted: message.isDeleted,
        })
        .from(message)
        .where(
          and(eq(message.threadId, dto.threadId), inArray(message.seq, seqs)),
        );
      const reporter = await tx.query.user.findFirst({
        where: eq(user.id, userId),
        columns: { account: true, domain: true },
      });
      if (!reporter) throw new Error('reporter does not exist');
      if (
        targets.length !== seqs.length ||
        targets.some(
          (target) =>
            (target.creatorAccount === reporter.account &&
              target.creatorDomain === reporter.domain) ||
            target.isDeleted ||
            target.contentType === 'SYSTEM' ||
            target.contentType === 'CALL',
        )
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'one or more messages cannot be reported',
        );
      }

      await tx
        .insert(messageReport)
        .values(
          targets.map((target) => ({
            messageId: target.id,
            threadId: dto.threadId,
            messageSeq: target.seq,
            reporterId: userId,
            updatedAt: new Date(),
          })),
        )
        .onConflictDoNothing({
          target: [messageReport.reporterId, messageReport.messageId],
        });

      const rows = await tx
        .select({
          id: messageReport.id,
          threadId: messageReport.threadId,
          messageSeq: messageReport.messageSeq,
          status: messageReport.status,
        })
        .from(messageReport)
        .where(
          and(
            eq(messageReport.reporterId, userId),
            inArray(
              messageReport.messageId,
              targets.map((target) => target.id),
            ),
          ),
        );
      return {
        reports: rows.map((row) => ({ ...row, id: row.id.toString() })),
      };
    });
  }

  async list(dto: AdminListMessageReportsDto) {
    const reporter = alias(user, 'reporter');
    const creator = alias(user, 'creator');
    const filters: SQL[] = [];
    if (dto.status) filters.push(eq(messageReport.status, dto.status));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          id: messageReport.id,
          status: messageReport.status,
          createdAt: messageReport.createdAt,
          reviewedAt: messageReport.reviewedAt,
          threadId: messageReport.threadId,
          messageSeq: messageReport.messageSeq,
          reporter: {
            id: reporter.id,
            account: reporter.account,
            name: reporter.name,
          },
          creator: {
            account: message.creatorAccount,
            name: sql<string>`COALESCE(${creator.name}, ${message.creatorAccount})`,
            domain: message.creatorDomain,
          },
          message: {
            id: message.id,
            contentType: message.contentType,
            content: message.content,
            createdAt: message.createdAt,
            isDeleted: message.isDeleted,
            originSeq: message.originSeq,
          },
          threadType: messageThread.type,
        })
        .from(messageReport)
        .innerJoin(message, eq(message.id, messageReport.messageId))
        .innerJoin(messageThread, eq(messageThread.id, messageReport.threadId))
        .innerJoin(reporter, eq(reporter.id, messageReport.reporterId))
        .leftJoin(
          creator,
          and(
            eq(creator.account, message.creatorAccount),
            eq(creator.domain, message.creatorDomain),
          ),
        )
        .where(where)
        .orderBy(desc(messageReport.createdAt))
        .offset(dto.skip)
        .limit(dto.take),
      this.database.db
        .select({ value: count() })
        .from(messageReport)
        .where(where)
        .then((result) => result[0]?.value ?? 0),
    ]);
    return {
      list: rows.map((row) => ({
        ...row,
        id: row.id.toString(),
        message: { ...row.message, id: row.message.id.toString() },
      })),
      total,
    };
  }

  async resolve(
    adminId: number,
    dto: ResolveMessageReportsDto,
  ): Promise<{
    reports: { id: string; status: MessageReportStatus }[];
    deletions: {
      threadId: number;
      messageSeq: number;
      creator: { account: string; domain: string };
      originSeq: number;
      deletionSeq: number;
    }[];
    systemMessages: Array<
      Awaited<ReturnType<MessageService['writeSystemMessageInTx']>>['message']
    >;
  }> {
    const ids = [...new Set(dto.reportIds.map((id) => BigInt(id)))];
    return this.database.db.transaction(async (tx) => {
      const idList = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
      const locked = await tx.execute(sql`
        SELECT id, status, "messageId", "threadId", "messageSeq"
        FROM "MessageReport"
        WHERE id IN (${idList})
        FOR UPDATE
      `);
      if (locked.rows.length !== ids.length) {
        throw new BusinessException(BusinessCode.NOT_FOUND, 'report not found');
      }
      const reports = locked.rows as {
        id: string;
        status: MessageReportStatus;
        messageId: string;
        threadId: number;
        messageSeq: number;
      }[];
      if (
        reports.some((report) => report.status === MessageReportStatus.UPHELD)
      ) {
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'an upheld report is terminal',
        );
      }

      const now = new Date();
      await tx
        .update(messageReport)
        .set({
          status: dto.status,
          reviewedByAdminId: adminId,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(inArray(messageReport.id, ids));

      const deletions: {
        threadId: number;
        messageSeq: number;
        creator: { account: string; domain: string };
        originSeq: number;
        deletionSeq: number;
      }[] = [];
      const systemMessages: Array<
        Awaited<ReturnType<MessageService['writeSystemMessageInTx']>>['message']
      > = [];
      if (dto.status === MessageReportStatus.UPHELD) {
        const targets = await tx
          .select({
            threadId: message.threadId,
            messageSeq: message.seq,
            creatorAccount: message.creatorAccount,
            creatorDomain: message.creatorDomain,
            originSeq: message.originSeq,
          })
          .from(message)
          .where(
            inArray(
              message.id,
              reports.map((report) => BigInt(report.messageId)),
            ),
          );
        const uniqueTargets = new Map(
          targets.map((target) => [
            `${target.threadId}:${target.messageSeq}`,
            target,
          ]),
        );
        for (const target of uniqueTargets.values()) {
          if (target.creatorAccount === null || target.creatorDomain === null)
            throw new Error('SYSTEM messages cannot be moderated');
          const deletionSeq = await this.deletedMessages.deleteByReportInTx(
            tx,
            target.threadId,
            target.messageSeq,
          );
          deletions.push({
            ...target,
            creator: {
              account: target.creatorAccount,
              domain: target.creatorDomain,
            },
            originSeq: target.originSeq ?? target.messageSeq,
            deletionSeq,
          });
        }
        const byThread = new Map<number, { count: number }>();
        for (const target of uniqueTargets.values()) {
          const current = byThread.get(target.threadId);
          if (current) current.count++;
          else
            byThread.set(target.threadId, {
              count: 1,
            });
        }
        for (const [threadId, notice] of byThread) {
          const system = await this.messages.writeSystemMessageInTx(
            tx,
            threadId,
            SystemMessageType.MESSAGES_MODERATED,
            undefined,
            {
              count: notice.count,
            },
          );
          systemMessages.push(system.message);
        }
      }
      return {
        reports: reports.map((report) => ({
          id: String(report.id),
          status: dto.status,
        })),
        deletions,
        systemMessages,
      };
    });
  }
}
