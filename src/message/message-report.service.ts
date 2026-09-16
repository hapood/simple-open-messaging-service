import { accountProfileFields } from '../user/account-profile.js';
import { Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { isThreadMutuallyAuthorized } from '../relationship/business/shared/relationship-authorization.js';
import {
  message,
  messageReport,
  messageThread,
  accountThreadState,
  account as user,
} from '../database/schema.js';
import type {
  AdminListMessageReportsDto,
  CreateMessageReportDto,
  MessageTargetDto,
} from './message-report.dto.js';
import { DeletedMessageService } from './deleted-message.service.js';

@Injectable()
export class MessageReportService {
  constructor(private readonly database: DatabaseService) {}

  async create(userId: number, dto: CreateMessageReportDto) {
    return this.database.db.transaction(async (tx) => {
      const lock = await DeletedMessageService.lockThreadInTx(tx, dto.threadId);
      const participant = await tx.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, dto.threadId),
          eq(accountThreadState.accountId, userId),
        ),
        columns: { id: true },
      });
      if (
        !lock ||
        !participant ||
        !(await isThreadMutuallyAuthorized(tx, userId, dto.threadId))
      ) {
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'thread unavailable',
        );
      }
      const target = await tx.query.message.findFirst({
        where: and(
          eq(message.threadId, dto.threadId),
          eq(message.seq, dto.seq),
        ),
        columns: {
          creatorAccount: true,
          creatorDomain: true,
          contentType: true,
          isDeleted: true,
        },
      });
      const reporter = await tx.query.account.findFirst({
        where: eq(user.id, userId),
        columns: { account: true, domain: true },
      });
      if (!reporter) throw new Error('reporter does not exist');
      if (
        !target ||
        (target.creatorAccount === reporter.account &&
          target.creatorDomain === reporter.domain) ||
        target.contentType === 'SYSTEM'
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'message cannot be reported',
        );
      }
      const existing = await tx.query.messageReport.findFirst({
        where: and(
          eq(messageReport.threadId, dto.threadId),
          eq(messageReport.seq, dto.seq),
        ),
      });
      // Retries after moderation also succeed, but cannot reactivate a removed message.
      if (existing && (!existing.isDeleted || target.isDeleted)) return {};
      if (target.isDeleted)
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'message cannot be reported',
        );
      await tx
        .insert(messageReport)
        .values({ threadId: dto.threadId, seq: dto.seq })
        .onConflictDoUpdate({
          target: [messageReport.threadId, messageReport.seq],
          set: { isDeleted: false, updatedAt: new Date() },
          setWhere: eq(messageReport.isDeleted, true),
        });
      return {};
    });
  }

  async dismiss(dto: MessageTargetDto) {
    return this.database.db.transaction(async (tx) => {
      if (!(await DeletedMessageService.lockThreadInTx(tx, dto.threadId)))
        throw new BusinessException(BusinessCode.NOT_FOUND, 'report not found');
      await tx
        .update(messageReport)
        .set({ isDeleted: true, updatedAt: new Date() })
        .where(
          and(
            eq(messageReport.threadId, dto.threadId),
            eq(messageReport.seq, dto.seq),
            eq(messageReport.isDeleted, false),
          ),
        );
      return {};
    });
  }

  async list(dto: AdminListMessageReportsDto) {
    const creator = alias(user, 'creator');
    const where = eq(messageReport.isDeleted, dto.isDeleted);
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          isDeleted: messageReport.isDeleted,
          createdAt: messageReport.createdAt,
          updatedAt: messageReport.updatedAt,
          threadId: messageReport.threadId,
          seq: messageReport.seq,
          creator: {
            account: message.creatorAccount,
            name: sql<string>`COALESCE(${accountProfileFields(creator).name}, ${message.creatorAccount})`,
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
        .innerJoin(
          message,
          and(
            eq(message.threadId, messageReport.threadId),
            eq(message.seq, messageReport.seq),
          ),
        )
        .innerJoin(messageThread, eq(messageThread.id, messageReport.threadId))
        .leftJoin(
          creator,
          and(
            eq(creator.account, message.creatorAccount),
            eq(creator.domain, message.creatorDomain),
            eq(
              creator.namespaceId,
              sql<number>`CASE
                WHEN ${message.creatorDomain} = 'local' THEN 0
                ELSE ${message.sourceNamespaceId}
              END`,
            ),
          ),
        )
        .where(where)
        .orderBy(
          desc(messageReport.updatedAt),
          desc(messageReport.threadId),
          desc(messageReport.seq),
        )
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
        message: { ...row.message, id: row.message.id.toString() },
      })),
      total,
    };
  }
}
