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
import { FederatedGroupTaskExecutionService } from './federated-group-task-execution.service.js';
import {
  readFederatedGroupTask,
  readRequestFederatedGroupJoinTask,
} from './federated-group-task.js';

abstract class FederatedGroupTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly taskType: string;
  private unregister?: () => void;

  constructor(
    protected readonly dispatcher: DurableTaskDispatcherService,
    protected readonly execution: FederatedGroupTaskExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(task: DurableTask): Promise<void>;
}

@Injectable()
export class RequestFederatedGroupJoinTaskHandler extends FederatedGroupTaskHandler {
  readonly taskType = DurableTaskType.REQUEST_FEDERATED_GROUP_JOIN;
  constructor(
    dispatcher: DurableTaskDispatcherService,
    execution: FederatedGroupTaskExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(task: DurableTask): Promise<void> {
    return this.execution.request(readRequestFederatedGroupJoinTask(task));
  }
}

@Injectable()
export class RevokeFederatedGroupJoinTaskHandler extends FederatedGroupTaskHandler {
  readonly taskType = DurableTaskType.REVOKE_FEDERATED_GROUP_JOIN;
  constructor(
    dispatcher: DurableTaskDispatcherService,
    execution: FederatedGroupTaskExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(task: DurableTask): Promise<void> {
    return this.execution.revoke(readFederatedGroupTask(task));
  }
}

@Injectable()
export class AcceptAddressedGroupInvitationTaskHandler extends FederatedGroupTaskHandler {
  readonly taskType = DurableTaskType.ACCEPT_ADDRESSED_GROUP_INVITATION;
  constructor(
    dispatcher: DurableTaskDispatcherService,
    execution: FederatedGroupTaskExecutionService,
  ) {
    super(dispatcher, execution);
  }
  execute(task: DurableTask): Promise<void> {
    return this.execution.accept(readFederatedGroupTask(task));
  }
}
