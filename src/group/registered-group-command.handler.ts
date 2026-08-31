import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type {
  DomainCommand,
  DomainCommandHandler,
} from '../domain-command/domain-command.types.js';
import { GroupService } from './group.service.js';

export abstract class RegisteredGroupCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly commandType: string;
  private unregister?: () => void;

  constructor(
    protected readonly dispatcher: DomainCommandDispatcherService,
    protected readonly groups: GroupService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(command: DomainCommand): Promise<void>;
}
