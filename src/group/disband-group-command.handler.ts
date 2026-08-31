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
import { GroupDisbandFanoutService } from './group-disband-fanout.service.js';
import { readDisbandGroupCommand } from './group-disband-command.js';

@Injectable()
export class DisbandGroupCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  readonly commandType = DomainCommandType.DISBAND_GROUP;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DomainCommandDispatcherService,
    private readonly groups: GroupService,
    private readonly fanout: GroupDisbandFanoutService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, deleteForUserId } =
      readDisbandGroupCommand(command);
    await this.groups.markGroupDissolved({
      threadId,
      operatorUserId: actorUserId,
    });
    while (
      await this.fanout.insertNextPage(command, threadId, deleteForUserId)
    ) {
      // Each iteration commits one bounded page and its durable cursor.
    }
  }
}
