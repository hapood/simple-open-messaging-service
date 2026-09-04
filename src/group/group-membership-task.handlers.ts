import { Injectable } from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupService } from './group.service.js';
import {
  readLeaveGroupTask,
  readSetGroupRoleTask,
  readTargetGroupTask,
} from './group-membership-task.js';
import { RegisteredGroupTaskHandler } from './registered-group-task.handler.js';

@Injectable()
export class LeaveGroupTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.LEAVE_GROUP;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId } = readLeaveGroupTask(task);
    await this.groups.leaveGroup({
      userId: actorUserId,
      threadId,
    });
  }
}

@Injectable()
export class KickGroupMemberTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.KICK_GROUP_MEMBER;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, targetUserId } = readTargetGroupTask(task);
    await this.groups.kickMember({
      threadId,
      operatorUserId: actorUserId,
      targetUserId,
    });
  }
}

@Injectable()
export class TransferGroupOwnershipTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.TRANSFER_GROUP_OWNERSHIP;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, targetUserId } = readTargetGroupTask(task);
    await this.groups.transferOwnership({
      threadId,
      fromUserId: actorUserId,
      toUserId: targetUserId,
    });
  }
}

@Injectable()
export class SetGroupMemberRoleTaskHandler extends RegisteredGroupTaskHandler {
  readonly taskType = DurableTaskType.SET_GROUP_MEMBER_ROLE;

  constructor(dispatcher: DurableTaskDispatcherService, groups: GroupService) {
    super(dispatcher, groups);
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, targetUserId, role } =
      readSetGroupRoleTask(task);
    await this.groups.setRole({
      threadId,
      operatorUserId: actorUserId,
      targetUserId,
      role,
    });
  }
}
