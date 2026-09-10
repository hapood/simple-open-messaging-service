import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import { systemAccountIdInTx } from '../user/system-account.js';
import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import type { NamespacedAddress } from '../common/client-identity.js';
import { relationshipTaskAuthorUserId } from '../relationship/relationship-task-author.js';
import { FederationRelationshipMutationService } from './federation-relationship-mutation.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

/** Remote facts are applied immediately; the reverse local intent is durable command work. */
@Injectable()
export class FederationReverseRevokeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: DurableTaskQueueService,
    private readonly mutations: FederationRelationshipMutationService,
    private readonly clientFeed: ClientStateFeedService,
    private readonly events: EventEmitter2,
  ) {}

  /** The consumer already holds both endpoint business locks and the pair lock. */
  async enqueueP2PInTx(
    tx: DatabaseTransaction,
    local: { id: number; account: string; domain: string },
    remote: NamespacedAddress,
  ): Promise<void> {
    await this.tasks.enqueueTaskInTx(tx, {
      scope: { type: 'USER_PAIR', endpoints: [local, remote] },
      taskType: DurableTaskType.REVOKE_USER_RELATIONSHIP,
      actorUserId: await systemAccountIdInTx(tx),
      payload: {
        operation: 'RESPOND_TO_REVOKE',
        intentAuthorUserId: local.id,
        targetUserId: remote,
      },
    });
  }

  /** Reuses the group business lock already held by remote intent application. */
  async enqueueGroupInTx(
    tx: DatabaseTransaction,
    input: {
      threadId: number;
      group: { account: string; domain: string };
      memberUserId: AccountTarget;
      author: 'MEMBER' | 'GROUP';
    },
  ): Promise<void> {
    await this.tasks.enqueueTaskInTx(tx, {
      scope: { type: 'GROUP', address: input.group },
      taskType:
        input.author === 'GROUP'
          ? DurableTaskType.REVOKE_GROUP_RELATIONSHIP
          : DurableTaskType.REVOKE_USER_RELATIONSHIP,
      actorUserId: await systemAccountIdInTx(tx),
      payload: {
        operation: 'RESPOND_TO_REVOKE',
        threadId: input.threadId,
        memberUserId: input.memberUserId,
        ...(input.author === 'MEMBER'
          ? { intentAuthorUserId: input.memberUserId }
          : {}),
      },
    });
  }

  async execute(task: DurableTask): Promise<void> {
    if (task.checkpoint.reverseRevokeDone === true) return;
    if (
      task.kind !== 'MUTATION' ||
      task.payload.operation !== 'RESPOND_TO_REVOKE'
    )
      throw new Error('Invalid reverse revoke task');
    const updates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.database.db.transaction(async (tx) => {
      let allocated: Map<string, bigint>;
      // Each writer enters through its existing business/pair/thread/feed lock order.
      if (
        task.scopeType === 'USER_PAIR' &&
        task.taskType === DurableTaskType.REVOKE_USER_RELATIONSHIP
      ) {
        allocated = await this.mutations.writeP2PIntentInTx(
          tx,
          relationshipTaskAuthorUserId(task),
          readAccountTarget(task.payload.targetUserId),
          false,
          '',
          updates,
        );
      } else if (task.scopeType === 'GROUP') {
        const threadId = task.payload.threadId;
        if (
          typeof threadId !== 'number' ||
          !Number.isSafeInteger(threadId) ||
          threadId <= 0
        )
          throw new Error('Invalid reverse revoke thread');
        if (task.taskType === DurableTaskType.REVOKE_GROUP_RELATIONSHIP)
          allocated = await this.mutations.writeGroupRelationshipIntentInTx(
            tx,
            threadId,
            readAccountTarget(task.payload.memberUserId),
            '',
            'REVOKED',
            updates,
          );
        else if (task.taskType === DurableTaskType.REVOKE_USER_RELATIONSHIP)
          allocated = await this.mutations.writeMemberRelationshipIntentInTx(
            tx,
            threadId,
            relationshipTaskAuthorUserId(task),
            'REVOKED',
            updates,
          );
        else throw new Error('Invalid reverse revoke author');
      } else throw new Error('Invalid reverse revoke scope');
      await saveTaskCheckpointInTx(tx, task.id, { reverseRevokeDone: true });
      return allocated;
    });
    this.clientFeed.notifyFeedUpdates(updates);
    for (const peerDomain of peers.keys())
      this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }
}
