import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { domainCommand, threadMember } from '../database/schema.js';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';

const FANOUT_PAGE_SIZE = 100;

@Injectable()
export class GroupDisbandFanoutService {
  constructor(private readonly database: DatabaseService) {}

  /** Insert one roster page and checkpoint its last user ID in the same short transaction. */
  async insertNextPage(
    parent: DomainCommand,
    threadId: number,
    deleteForUserId: number | null,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const locked = await tx.execute<{
        id: bigint;
        status: string;
        commandType: string;
        progressCursor: number | null;
      }>(sql`
        SELECT id, status, "commandType", "progressCursor"
        FROM "DomainCommand"
        WHERE id = ${parent.id}
        FOR UPDATE
      `);
      const current = locked.rows[0];
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.commandType !== DomainCommandType.DISBAND_GROUP
      ) {
        throw new Error('disband parent is not checkpointable');
      }
      const cursor = current.progressCursor ?? 0;
      const page = await tx
        .select({ userId: threadMember.userId })
        .from(threadMember)
        .where(
          and(
            eq(threadMember.threadId, threadId),
            eq(threadMember.left, false),
            gt(threadMember.userId, cursor),
          ),
        )
        .orderBy(asc(threadMember.userId))
        .limit(FANOUT_PAGE_SIZE);
      if (page.length === 0) return false;

      await tx.insert(domainCommand).values(
        page.map(({ userId }) => ({
          parentCommandId: parent.id,
          aggregateType: 'GROUP' as const,
          aggregateKey: parent.aggregateKey,
          commandType: DomainCommandType.REVOKE_DISSOLVED_GROUP_MEMBER,
          actorUserId: parent.actorUserId,
          payload: {
            threadId,
            memberUserId: userId,
            deleteData: userId === deleteForUserId,
          },
          status: 'PENDING' as const,
        })),
      );
      await tx
        .update(domainCommand)
        .set({ progressCursor: page.at(-1)!.userId })
        .where(eq(domainCommand.id, parent.id));
      return true;
    });
  }
}
