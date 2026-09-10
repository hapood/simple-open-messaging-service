import { Inject } from '@nestjs/common';
import { FederationReverseRevokeService } from '../federation/federation-reverse-revoke.service.js';
import { Injectable } from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupService } from '../group/group.service.js';
import { RegisteredGroupTaskHandler } from '../group/registered-group-task.handler.js';
import {
  readGroupRequestTask,
  readTargetGroupTask,
} from '../group/group-membership-task.js';

/** The group authors the intent; the actor authorizes the management operation. */
@Injectable()
export class RevokeGroupRelationshipTaskHandler extends RegisteredGroupTaskHandler {
  @Inject(FederationReverseRevokeService)
  private readonly reverseRevokes!: FederationReverseRevokeService;

  readonly taskType = DurableTaskType.REVOKE_GROUP_RELATIONSHIP;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    if (task.payload.operation === 'RESPOND_TO_REVOKE')
      return this.reverseRevokes.execute(task);
    if (task.kind !== 'MUTATION')
      throw new Error('Invalid group relationship revocation');
    if (task.payload.operation === 'KICK') {
      const { actorUserId, threadId, targetUserId } = readTargetGroupTask(task);
      await this.groups.kickMember({
        threadId,
        operatorUserId: actorUserId,
        targetUserId,
      });
      return;
    }
    const { actorUserId, threadId, requestId } = readGroupRequestTask(task);
    if (task.payload.operation === 'REJECT_REQUEST') {
      await this.groups.handleJoinRequest({
        threadId,
        requestId,
        managerUserId: actorUserId,
        decision: 'REVOKED',
      });
    } else if (task.payload.operation === 'REVOKE_INVITATION') {
      await this.groups.revokeInvitation({
        threadId,
        requestId,
        managerUserId: actorUserId,
      });
    } else throw new Error('Invalid group relationship revocation operation');
  }
}
