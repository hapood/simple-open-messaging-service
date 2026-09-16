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
import { MirrorGroupDisbandService } from './disband/mirror-group-disband.service.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { readDisbandMirrorGroupMembersTask } from './group-disband-task.js';

/** A mirror whose origin denied an authorized read records a recoverable
 * dissolution tombstone and then departs every still-active local member
 * through the shared pair-cursor sweep. A later positive intent may reopen the
 * mirror; this task only makes the denied generation converge. */
@Injectable()
export class DisbandMirrorGroupMembersTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.DISBAND_MIRROR_GROUP_MEMBERS;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly mirrorDisbands: MirrorGroupDisbandService,
    private readonly fanout: GroupRevokeFanoutService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { threadId, ...tombstone } = readDisbandMirrorGroupMembersTask(task);
    await this.mirrorDisbands.markDissolved({ threadId, ...tombstone });
    while (await this.fanout.insertNextMember(task, threadId)) {
      // Each iteration atomically admits one child and advances the durable pair cursor.
    }
  }
}
