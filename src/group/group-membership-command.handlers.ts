import { Injectable } from '@nestjs/common';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { GroupService } from './group.service.js';
import {
  readLeaveGroupCommand,
  readSetGroupRoleCommand,
  readTargetGroupCommand,
} from './group-membership-command.js';
import { RegisteredGroupCommandHandler } from './registered-group-command.handler.js';

@Injectable()
export class LeaveGroupCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.LEAVE_GROUP;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, deleteData } =
      readLeaveGroupCommand(command);
    await this.groups.leaveGroup({
      userId: actorUserId,
      threadId,
      role: null,
      deleteData,
    });
  }
}

@Injectable()
export class KickGroupMemberCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.KICK_GROUP_MEMBER;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, targetUserId } =
      readTargetGroupCommand(command);
    await this.groups.kickMember({
      threadId,
      operatorUserId: actorUserId,
      targetUserId,
    });
  }
}

@Injectable()
export class TransferGroupOwnershipCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.TRANSFER_GROUP_OWNERSHIP;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, targetUserId } =
      readTargetGroupCommand(command);
    await this.groups.transferOwnership({
      threadId,
      fromUserId: actorUserId,
      toUserId: targetUserId,
    });
  }
}

@Injectable()
export class SetGroupMemberRoleCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.SET_GROUP_MEMBER_ROLE;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, targetUserId, role } =
      readSetGroupRoleCommand(command);
    await this.groups.setRole({
      threadId,
      operatorUserId: actorUserId,
      targetUserId,
      role,
    });
  }
}
