import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type {
  DomainCommand,
  DomainCommandHandler,
} from '../domain-command/domain-command.types.js';
import { FriendInviteCommandExecutionService } from './friend-invite-command-execution.service.js';
import { readFriendInviteCommand } from './friend-invite-command.js';

@Injectable()
export class RevokeFriendInviteCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  readonly commandType = DomainCommandType.REVOKE_FRIEND_INVITE;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DomainCommandDispatcherService,
    private readonly execution: FriendInviteCommandExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, inviteId } = readFriendInviteCommand(command);
    await this.execution.revoke(inviteId, actorUserId);
  }
}
