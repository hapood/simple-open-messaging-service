import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { FederatedRelationshipRequestTaskExecutionService } from './federated-relationship-request-task-execution.service.js';
import {
  readFederatedRelationshipRequestTask,
  readSendFederatedRelationshipRequestTask,
} from './federated-relationship-request-task.js';

abstract class RegisteredFederatedRelationshipRequestTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly taskType: string;
  private unregister?: () => void;

  constructor(protected readonly dispatcher: DurableTaskDispatcherService) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(task: DurableTask): Promise<void>;
}

@Injectable()
export class SendFederatedRelationshipRequestTaskHandler extends RegisteredFederatedRelationshipRequestTaskHandler {
  readonly taskType = DurableTaskType.SEND_FEDERATED_RELATIONSHIP_REQUEST;

  constructor(
    dispatcher: DurableTaskDispatcherService,
    private readonly execution: FederatedRelationshipRequestTaskExecutionService,
  ) {
    super(dispatcher);
  }

  execute(task: DurableTask): Promise<void> {
    return this.execution.send(readSendFederatedRelationshipRequestTask(task));
  }
}

@Injectable()
export class AcceptAddressedRelationshipRequestTaskHandler extends RegisteredFederatedRelationshipRequestTaskHandler {
  readonly taskType = DurableTaskType.ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST;

  constructor(
    dispatcher: DurableTaskDispatcherService,
    private readonly execution: FederatedRelationshipRequestTaskExecutionService,
  ) {
    super(dispatcher);
  }

  execute(task: DurableTask): Promise<void> {
    return this.execution.accept(readFederatedRelationshipRequestTask(task));
  }
}

@Injectable()
export class RevokeAddressedRelationshipRequestTaskHandler extends RegisteredFederatedRelationshipRequestTaskHandler {
  readonly taskType = DurableTaskType.REVOKE_ADDRESSED_RELATIONSHIP_REQUEST;

  constructor(
    dispatcher: DurableTaskDispatcherService,
    private readonly execution: FederatedRelationshipRequestTaskExecutionService,
  ) {
    super(dispatcher);
  }

  execute(task: DurableTask): Promise<void> {
    return this.execution.revoke(readFederatedRelationshipRequestTask(task));
  }
}
