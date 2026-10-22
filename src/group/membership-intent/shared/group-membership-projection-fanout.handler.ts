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
import { readGroupMembershipProjectionFanoutTask } from './group-membership-projection-fanout.js';
import { GroupMembershipProjectionFanoutService } from './group-membership-projection-fanout.service.js';

@Injectable()
export class GroupMembershipProjectionFanoutTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FAN_OUT_GROUP_PROJECTION;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly execution: GroupMembershipProjectionFanoutService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    await this.execution.execute(
      task,
      readGroupMembershipProjectionFanoutTask(task),
    );
  }
}
