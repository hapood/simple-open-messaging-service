import { Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  MessageReportStatus,
  ThreadParticipantState,
} from '../database/enums.js';
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

@Injectable()
export class MessageReportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly deletedMessages: DeletedMessageService,
  ) {}

  async create(userId: number, dto: CreateMessageReportsDto) {
    const seqs = [...new Set(dto.seqs)];
    return this.database.db.transaction(async (tx) => {
      const participant = await tx.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, dto.threadId),
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
        ),
        columns: { id: true },
      });
      if (!participant) {
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'thread unavailable',
        );
      }

      const targets = await tx
        .select({
          id: message.id,
          seq: message.seq,
          creator: message.creator,
          contentType: message.contentType,
          isDeleted: message.isDeleted,
        })
        .from(message)
        .where(
          and(eq(message.threadId, dto.threadId), inArray(message.seq, seqs)),
        );
      if (
        targets.length !== seqs.length ||
        targets.some(
          (target) =>
            target.creator === userId ||
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
            id: creator.id,
            account: creator.account,
            name: creator.name,
            domain: creator.domain,
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
        .innerJoin(creator, eq(creator.id, message.creator))
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
      seq: number;
      creator: number;
      originSeq: number;
      deletedId: string;
    }[];
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
        seq: number;
        creator: number;
        originSeq: number;
        deletedId: string;
      }[] = [];
      if (dto.status === MessageReportStatus.UPHELD) {
        const targets = await tx
          .select({
            threadId: message.threadId,
            seq: message.seq,
            creator: message.creator,
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
          targets.map((target) => [`${target.threadId}:${target.seq}`, target]),
        );
        for (const target of uniqueTargets.values()) {
          const deletedId = await this.deletedMessages.deleteByReportInTx(
            tx,
            target.threadId,
            target.seq,
          );
          deletions.push({
            ...target,
            originSeq: target.originSeq ?? target.seq,
            deletedId,
          });
        }
      }
      return {
        reports: reports.map((report) => ({
          id: String(report.id),
          status: dto.status,
        })),
        deletions,
      };
    });
  }
}
