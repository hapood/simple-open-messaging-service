import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/group-state.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../business/shared/locks/thread-content-lock.js';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import * as tables from '../database/schema.js';

export interface GroupRosterProjectionChange {
  account: string;
  domain: string;
  beforeRole: GroupRole | null;
  afterRole: GroupRole | null;
}

/** Applies local group-shell effects after a mirrored Group Meta round commits. */
@Injectable()
export class FederationGroupRosterProjectionService {
  async applyInTx(
    tx: DatabaseTransaction,
    params: {
      peerDomain: string;
      namespaceId: number;
      groupAccount: string;
      active: boolean;
      dissolved: boolean;
      owner: { account: string; domain: string } | null;
      changes: ReadonlyArray<GroupRosterProjectionChange>;
      threadLock?: ThreadContentLock;
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
        groupId: groupStateTable.id,
        threadId: tables.messageThread.id,
      })
      .from(groupStateTable)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, groupStateTable.id),
      )
      .where(
        and(
          eq(groupStateFields.account, params.groupAccount),
          eq(groupStateFields.domain, params.peerDomain),
          eq(groupStateFields.namespaceId, params.namespaceId),
        ),
      )
      .limit(1);
    if (!mirror)
      return {
        threadId: 0,
        users: [],
        statePushDomains: [],
        systemMessages: [],
      };
    await requireThreadContentLockInTx(tx, mirror.threadId, params.threadLock);
    await tx
      .update(tables.messageThread)
      .set({
        groupDissolvedAt: params.dissolved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(tables.messageThread.id, mirror.threadId));

    return {
      threadId: mirror.threadId,
      users: [],
      statePushDomains: [],
      systemMessages: [],
    };
  }
}
