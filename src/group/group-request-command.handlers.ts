import { Injectable } from '@nestjs/common';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { GroupInviteCommandExecutionService } from './group-invite-command-execution.service.js';
import {
  readAcceptGroupInvitationCommand,
  readGroupRequestCommand,
  readTargetGroupCommand,
} from './group-membership-command.js';
import { GroupService } from './group.service.js';
import { RegisteredGroupCommandHandler } from './registered-group-command.handler.js';
import { FederationService } from '../federation/federation.service.js';

@Injectable()
export class InviteGroupMemberCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.INVITE_GROUP_MEMBER;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
    private readonly execution: GroupInviteCommandExecutionService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, targetUserId } =
      readTargetGroupCommand(command);
    await this.execution.inviteMember(actorUserId, threadId, targetUserId);
  }
}

abstract class GroupRequestDecisionHandler extends RegisteredGroupCommandHandler {
  protected abstract readonly decision: 'ACCEPTED' | 'REVOKED';

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, requestId } =
      readGroupRequestCommand(command);
    await this.groups.handleJoinRequest({
      threadId,
      requestId,
      managerUserId: actorUserId,
      decision: this.decision,
    });
  }
}

@Injectable()
export class AcceptGroupJoinRequestCommandHandler extends GroupRequestDecisionHandler {
  readonly commandType = DomainCommandType.ACCEPT_GROUP_JOIN_REQUEST;
  protected readonly decision = 'ACCEPTED' as const;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }
}

@Injectable()
export class RejectGroupJoinRequestCommandHandler extends GroupRequestDecisionHandler {
  readonly commandType = DomainCommandType.REJECT_GROUP_JOIN_REQUEST;
  protected readonly decision = 'REVOKED' as const;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }
}

@Injectable()
export class RevokeGroupInvitationCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.REVOKE_GROUP_INVITATION;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, requestId } =
      readGroupRequestCommand(command);
    await this.groups.revokeInvitation({
      threadId,
      requestId,
      managerUserId: actorUserId,
    });
  }
}

@Injectable()
export class AcceptGroupInvitationCommandHandler extends RegisteredGroupCommandHandler {
  readonly commandType = DomainCommandType.ACCEPT_GROUP_INVITATION;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    groups: GroupService,
    private readonly federation: FederationService,
  ) {
    super(dispatcher, groups);
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId } =
      readAcceptGroupInvitationCommand(command);
    await this.federation.acceptGroupRequest(threadId, actorUserId);
  }
}
