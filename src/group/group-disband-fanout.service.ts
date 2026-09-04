import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

@Injectable()
export class GroupDisbandFanoutService {
  constructor(private readonly database: DatabaseService) {}

  /** Admit exactly one member-revocation child and advance the pair cursor atomically. */
  async insertNextMember(
    parent: DurableTask,
    threadId: number,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const locked = await tx.execute<{
        id: string;
        status: string;
        taskType: string;
        afterPairId: string;
      }>(sql`
        SELECT id, status, "taskType",
          COALESCE(checkpoint ->> 'afterPairId', '0') AS "afterPairId"
        FROM "DurableTask"
        WHERE id = ${parent.id}
        FOR UPDATE
      `);
      const current = locked.rows[0];
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.taskType !== DurableTaskType.DISBAND_GROUP
      ) {
        throw new Error('disband parent is not checkpointable');
      }
      const afterPairId = readCursor(current.afterPairId);
      const next = await tx.execute<{
        pairId: string;
        memberUserId: number;
      }>(sql`
        SELECT pair.id AS "pairId", member.id AS "memberUserId"
        FROM "RelationshipPair" pair
        JOIN "User" member ON (
          pair."endpointAType" = 'USER'
          AND member.account = pair."endpointAAccount"
          AND member.domain = pair."endpointADomain"
          AND (member."namespaceId" = 0
            OR member."namespaceId" = pair."endpointANamespaceId")
        ) OR (
          pair."endpointBType" = 'USER'
          AND member.account = pair."endpointBAccount"
          AND member.domain = pair."endpointBDomain"
          AND (member."namespaceId" = 0
            OR member."namespaceId" = pair."endpointBNamespaceId")
        )
        WHERE pair."threadId" = ${threadId}
          AND pair.kind = 'GROUP_MEMBER'
          AND pair.active = true
          AND pair.id > ${afterPairId}
        ORDER BY pair.id
        LIMIT 1
      `);
      const member = next.rows[0];
      if (!member) return false;
      const pairId = BigInt(member.pairId);

      await tx.insert(durableTask).values({
        parentTaskId: parent.id,
        kind: 'MUTATION',
        scopeType: 'GROUP',
        scopeKey: parent.scopeKey,
        taskType: DurableTaskType.REVOKE_DISSOLVED_GROUP_MEMBER,
        actorUserId: parent.actorUserId,
        payload: {
          threadId,
          memberUserId: member.memberUserId,
        },
        status: 'PENDING',
      });
      await tx
        .update(durableTask)
        .set({ checkpoint: { afterPairId: pairId.toString() } })
        .where(eq(durableTask.id, parent.id));
      return true;
    });
  }
}

function readCursor(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new Error('invalid disband relationship-pair checkpoint');
  return BigInt(value);
}
