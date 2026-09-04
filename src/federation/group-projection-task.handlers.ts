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
import { GroupProjectionTaskExecutionService } from './group-projection-task-execution.service.js';
import { readGroupMetaHeadFanoutTask } from './group-projection-task.js';

@Injectable()
export class GroupMetaHeadFanoutTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FAN_OUT_GROUP_META_HEAD;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly execution: GroupProjectionTaskExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    await this.execution.execute(task, readGroupMetaHeadFanoutTask(task));
  }
}
