import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { GroupService } from './group.service.js';

export abstract class RegisteredGroupTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  abstract readonly taskType: string;
  private unregister?: () => void;

  constructor(
    protected readonly dispatcher: DurableTaskDispatcherService,
    protected readonly groups: GroupService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  abstract execute(task: DurableTask): Promise<void>;
}
