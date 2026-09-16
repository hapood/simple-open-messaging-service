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
import { GroupService } from '../business/group/group.service.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { readDisbandGroupTask } from './group-disband-task.js';

@Injectable()
export class DisbandGroupTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.DISBAND_GROUP;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly groups: GroupService,
    private readonly fanout: GroupRevokeFanoutService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId } = readDisbandGroupTask(task);
    await this.groups.markGroupDissolved({
      threadId,
      operatorUserId: actorUserId,
    });
    while (await this.fanout.insertNextMember(task, threadId)) {
      // Each iteration atomically admits one child and advances the durable pair cursor.
    }
  }
}
