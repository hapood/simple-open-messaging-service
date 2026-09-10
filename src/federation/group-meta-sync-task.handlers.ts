import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { DurableAsyncTaskDispatcherService } from '../durable-task/durable-async-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableAsyncTaskHandler,
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { readGroupMetaSyncTask } from './group-meta-sync-task.js';
import { GroupMetaSyncTaskExecutionService } from './group-meta-sync-task-execution.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

@Injectable()
export class GroupMetaSyncHandoffTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.SYNC_GROUP_META;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly execution: GroupMetaSyncTaskExecutionService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(
    task: DurableTask,
  ): Promise<void | { status: 'ASYNC_PROCESSING' }> {
    if ((await this.execution.prepare(task)).ready) return;
    return { status: 'ASYNC_PROCESSING' };
  }
}

@Injectable()
export class GroupMetaSyncAsyncTaskHandler
  implements DurableAsyncTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.SYNC_GROUP_META;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableAsyncTaskDispatcherService,
    private readonly execution: GroupMetaSyncTaskExecutionService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    readGroupMetaSyncTask(task);
    const effect = await this.execution.execute(task);
    this.clientStateFeed.notifyFeedUpdates(effect.clientFeedUpdates);
    for (const peerDomain of new Set(effect.statePushDomains))
      this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }
}
