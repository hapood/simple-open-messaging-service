import { Injectable } from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupInviteTaskExecutionService } from './group-invite-task-execution.service.js';
import {
  readAcceptGroupInvitationTask,
  readGroupRequestTask,
  readTargetGroupTask,
} from './group-membership-task.js';
import { GroupService } from './group.service.js';
import { RegisteredGroupTaskHandler } from './registered-group-task.handler.js';
import { FederationService } from '../federation/federation.service.js';

@Injectable()
export class InviteGroupMemberTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.INVITE_GROUP_MEMBER;

  constructor(
    dispatcher: DurableTaskDispatcherService,
    groups: GroupService,
    private readonly execution: GroupInviteTaskExecutionService,
  ) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, targetUserId } = readTargetGroupTask(task);
    await this.execution.inviteMember(actorUserId, threadId, targetUserId);
  }
}

abstract class GroupRequestDecisionHandler extends RegisteredGroupTaskHandler {
  protected abstract readonly decision: 'ACCEPTED' | 'REVOKED';

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, requestId } = readGroupRequestTask(task);
    await this.groups.handleJoinRequest({
      threadId,
      requestId,
      managerUserId: actorUserId,
      decision: this.decision,
    });
  }
}

@Injectable()
export class AcceptGroupJoinRequestTaskHandler extends GroupRequestDecisionHandler {
  readonly taskType = DurableTaskType.ACCEPT_GROUP_JOIN_REQUEST;
  protected readonly decision = 'ACCEPTED' as const;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }
}

@Injectable()
export class RejectGroupJoinRequestTaskHandler extends GroupRequestDecisionHandler {
  readonly taskType = DurableTaskType.REJECT_GROUP_JOIN_REQUEST;
  protected readonly decision = 'REVOKED' as const;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }
}

@Injectable()
export class RevokeGroupInvitationTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.REVOKE_GROUP_INVITATION;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, requestId } = readGroupRequestTask(task);
    await this.groups.revokeInvitation({
      threadId,
      requestId,
      managerUserId: actorUserId,
    });
  }
}

@Injectable()
export class AcceptGroupInvitationTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.ACCEPT_GROUP_INVITATION;

  constructor(
    dispatcher: DurableTaskDispatcherService,
    groups: GroupService,
    private readonly federation: FederationService,
  ) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId } = readAcceptGroupInvitationTask(task);
    await this.federation.acceptGroupRequest(threadId, actorUserId);
  }
}
