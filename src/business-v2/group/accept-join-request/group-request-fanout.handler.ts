import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DurableTaskDispatcherService } from '../../../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../../../durable-task/durable-task.constants.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../../../durable-task/durable-task.types.js';
import { readGroupRequestFanoutTask } from './group-request-fanout.js';
import { GroupRequestExecutionService } from './group-request-execution.service.js';

@Injectable()
export class GroupRequestFanoutTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FAN_OUT_GROUP_PROJECTION;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly execution: GroupRequestExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    await this.execution.execute(task, readGroupRequestFanoutTask(task));
  }
}
