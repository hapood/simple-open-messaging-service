import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { readForbiddenGroupTask } from './group-disband-task.js';

@Injectable()
export class RevokeForbiddenGroupTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.REVOKE_FORBIDDEN_GROUP;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly fanout: GroupRevokeFanoutService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { threadId } = readForbiddenGroupTask(task);
    while (await this.fanout.insertNextMember(task, threadId)) {
      // Admission and progress commit together; children execute after this parent finishes.
    }
  }
}
