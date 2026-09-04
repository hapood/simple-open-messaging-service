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
import { RelationshipRequestTaskExecutionService } from './relationship-request-task-execution.service.js';
import { readRelationshipRequestTask } from './relationship-request-task.js';

@Injectable()
export class AcceptRelationshipRequestTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.ACCEPT_RELATIONSHIP_REQUEST;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly execution: RelationshipRequestTaskExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, peerUserId } = readRelationshipRequestTask(task);
    await this.execution.accept(peerUserId, actorUserId);
  }
}
