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
import { GroupService } from './group.service.js';
import { readDissolvedMemberRevokeCommand } from './group-disband-command.js';

@Injectable()
export class RevokeDissolvedGroupMemberCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  readonly commandType = DomainCommandType.REVOKE_DISSOLVED_GROUP_MEMBER;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DomainCommandDispatcherService,
    private readonly groups: GroupService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(command: DomainCommand): Promise<void> {
    await this.groups.revokeDissolvedGroupMember(
      readDissolvedMemberRevokeCommand(command),
    );
  }
}
