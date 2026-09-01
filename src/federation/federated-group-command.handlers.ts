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
import { FederatedGroupCommandExecutionService } from './federated-group-command-execution.service.js';
import {
  readFederatedGroupCommand,
  readRequestFederatedGroupJoinCommand,
} from './federated-group-command.js';

abstract class FederatedGroupCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly commandType: string;
  private unregister?: () => void;

  constructor(
    protected readonly dispatcher: DomainCommandDispatcherService,
    protected readonly execution: FederatedGroupCommandExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(command: DomainCommand): Promise<void>;
}

@Injectable()
export class RequestFederatedGroupJoinCommandHandler extends FederatedGroupCommandHandler {
  readonly commandType = DomainCommandType.REQUEST_FEDERATED_GROUP_JOIN;
  constructor(
    dispatcher: DomainCommandDispatcherService,
    execution: FederatedGroupCommandExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(command: DomainCommand): Promise<void> {
    return this.execution.request(
      readRequestFederatedGroupJoinCommand(command),
    );
  }
}

@Injectable()
export class RevokeFederatedGroupJoinCommandHandler extends FederatedGroupCommandHandler {
  readonly commandType = DomainCommandType.REVOKE_FEDERATED_GROUP_JOIN;
  constructor(
    dispatcher: DomainCommandDispatcherService,
    execution: FederatedGroupCommandExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(command: DomainCommand): Promise<void> {
    return this.execution.revoke(readFederatedGroupCommand(command));
  }
}

@Injectable()
export class AcceptAddressedGroupInvitationCommandHandler extends FederatedGroupCommandHandler {
  readonly commandType = DomainCommandType.ACCEPT_ADDRESSED_GROUP_INVITATION;
  constructor(
    dispatcher: DomainCommandDispatcherService,
    execution: FederatedGroupCommandExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(command: DomainCommand): Promise<void> {
    return this.execution.accept(readFederatedGroupCommand(command));
  }
}
