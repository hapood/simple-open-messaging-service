import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import * as tables from '../database/schema.js';

export interface GroupRosterProjectionChange {
  account: string;
  domain: string;
  beforeRole: GroupRole | null;
  afterRole: GroupRole | null;
}

/** Commits a validated remote roster revision without coupling roster triples to User rows. */
@Injectable()
export class FederationGroupRosterProjectionService {
  async applyInTx(
    tx: DatabaseTransaction,
    params: {
      peerDomain: string;
      groupAccount: string;
      revision: bigint;
      active: boolean;
      dissolved: boolean;
      owner: { account: string; domain: string } | null;
      changes: ReadonlyArray<GroupRosterProjectionChange>;
    },
  ): Promise<{
    threadId: number;
    users: Array<{ userId: number; active: boolean }>;
    statePushDomains: string[];
    systemMessages: [];
  }> {
    if ((params.owner === null) !== params.dissolved)
      throw new Error('invalid federated group owner');
    const [mirror] = await tx
      .select({
        groupUserId: tables.group.groupUserId,
        threadId: tables.messageThread.id,
        remoteGroupMetaFeedId: tables.group.remoteGroupMetaFeedId,
      })
      .from(tables.group)
      .innerJoin(tables.user, eq(tables.user.id, tables.group.groupUserId))
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.groupUserId, tables.group.groupUserId),
      )
      .where(
        and(
          eq(tables.user.account, params.groupAccount),
          eq(tables.user.domain, params.peerDomain),
        ),
      )
      .limit(1);
    if (
      !mirror ||
      (mirror.remoteGroupMetaFeedId !== null &&
        mirror.remoteGroupMetaFeedId >= params.revision)
    )
      return {
        threadId: mirror?.threadId ?? 0,
        users: [],
        statePushDomains: [],
        systemMessages: [],
      };
    await tx.execute(sql`
      SELECT id FROM "MessageThread"
      WHERE id = ${mirror.threadId}
      FOR UPDATE
    `);
    await tx
      .update(tables.group)
      .set({
        remoteGroupMetaFeedId: params.revision,
        dissolvedAt: params.dissolved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(tables.group.groupUserId, mirror.groupUserId));

    return {
      threadId: mirror.threadId,
      users: [],
      statePushDomains: [],
      systemMessages: [],
    };
  }
}
