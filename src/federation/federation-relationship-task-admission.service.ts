import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import {
  DurableTaskQueueService,
  type DurableTaskScope,
} from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { lockBusinessAccountsInTx } from '../relationship/business-scope-lock.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

export function remoteIntentKey(
  namespaceId: number,
  account: string,
  peerAccount: string,
): string {
  return JSON.stringify(['REMOTE_INTENT', namespaceId, account, peerAccount]);
}

@Injectable()
export class FederationRelationshipTaskAdmission {
  constructor(private readonly tasks: DurableTaskQueueService) {}

  /** Revoke is command work. Subsequent state replaces pending work or follows a running command. */
  async deferInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    item: PeerStateFeedPage['items'][number],
  ): Promise<boolean> {
    const account = item.account.trim().toLowerCase();
    const peerAccount = item.peerAccount!.trim().toLowerCase();
    const remote = { account, domain: peerDomain };
    const local = { account: peerAccount, domain: 'local' };
    const scope: DurableTaskScope =
      account.startsWith('!') || peerAccount.startsWith('!')
        ? { type: 'GROUP', address: account.startsWith('!') ? remote : local }
        : { type: 'USER_PAIR', endpoints: [local, remote] };
    await lockBusinessAccountsInTx(
      tx,
      scope.type === 'GROUP' ? [scope.address] : scope.endpoints,
    );
    const key = remoteIntentKey(namespaceId, account, peerAccount);
    if ((item.body as { status: string }).status !== 'REVOKED') {
      const existing = await tx.query.durableTask.findFirst({
        where: and(
          eq(durableTask.coalescingKey, key),
          eq(
            durableTask.taskType,
            DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT,
          ),
          inArray(durableTask.status, [
            'PENDING',
            'PROCESSING',
            'ASYNC_PROCESSING',
          ]),
        ),
        columns: { id: true },
      });
      if (!existing) return false;
    }
    await this.tasks.enqueueTaskInTx(tx, {
      scope,
      taskType: DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT,
      payload: {
        peerDomain,
        namespaceId,
        initiator: { ...remote, namespaceId },
        item: { ...item, account, peerAccount },
      },
    });
    return true;
  }
}
