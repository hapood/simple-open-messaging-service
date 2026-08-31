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
import { FederatedFriendCommandExecutionService } from './federated-friend-command-execution.service.js';
import {
  readFederatedFriendCommand,
  readSendFederatedFriendCommand,
} from './federated-friend-command.js';

abstract class RegisteredFederatedFriendCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly commandType: string;
  private unregister?: () => void;

  constructor(protected readonly dispatcher: DomainCommandDispatcherService) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(command: DomainCommand): Promise<void>;
}

@Injectable()
export class SendFederatedFriendInviteCommandHandler extends RegisteredFederatedFriendCommandHandler {
  readonly commandType = DomainCommandType.SEND_FEDERATED_FRIEND_INVITE;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    private readonly execution: FederatedFriendCommandExecutionService,
  ) {
    super(dispatcher);
  }

  execute(command: DomainCommand): Promise<void> {
    return this.execution.send(readSendFederatedFriendCommand(command));
  }
}

@Injectable()
export class AcceptAddressedFriendRequestCommandHandler extends RegisteredFederatedFriendCommandHandler {
  readonly commandType = DomainCommandType.ACCEPT_ADDRESSED_FRIEND_REQUEST;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    private readonly execution: FederatedFriendCommandExecutionService,
  ) {
    super(dispatcher);
  }

  execute(command: DomainCommand): Promise<void> {
    return this.execution.accept(readFederatedFriendCommand(command));
  }
}

@Injectable()
export class RevokeAddressedFriendRequestCommandHandler extends RegisteredFederatedFriendCommandHandler {
  readonly commandType = DomainCommandType.REVOKE_ADDRESSED_FRIEND_REQUEST;

  constructor(
    dispatcher: DomainCommandDispatcherService,
    private readonly execution: FederatedFriendCommandExecutionService,
  ) {
    super(dispatcher);
  }

  execute(command: DomainCommand): Promise<void> {
    return this.execution.revoke(readFederatedFriendCommand(command));
  }
}
