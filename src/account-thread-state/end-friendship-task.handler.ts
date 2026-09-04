import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { FEDERATION_STATE_FEED_PUSH } from '../federation/federation-state-feed.events.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { AccountThreadStateService } from './account-thread-state.service.js';

@Injectable()
export class EndFriendshipTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.END_FRIENDSHIP;
  private readonly logger = new Logger(EndFriendshipTaskHandler.name);
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly participants: AccountThreadStateService,
    private readonly events: EventEmitter2,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<
      MessageFanoutService,
      'dispatchToUsers'
    >,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId } = readTask(task);
    const ended = await this.participants.endP2P(threadId, actorUserId);

    for (const domain of ended.statePeers) {
      this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain: domain });
    }
    if (ended.systemMessage && this.messageFanout) {
      void this.messageFanout
        .dispatchToUsers(ended.systemMessage, ended.localRecipientIds)
        .catch((error: unknown) =>
          this.logger.warn('friendship-end message wake failed', error),
        );
    }
  }
}

function readTask(task: DurableTask): {
  actorUserId: number;
  threadId: number;
} {
  if (task.scopeType !== 'USER_PAIR') {
    throw new Error('end-friendship task has the wrong scope type');
  }
  if (task.actorUserId === null) {
    throw new Error('end-friendship task has no actor');
  }
  const { threadId } = task.payload;
  if (!Number.isSafeInteger(threadId) || (threadId as number) < 1) {
    throw new Error('end-friendship task has an invalid thread ID');
  }
  return {
    actorUserId: task.actorUserId,
    threadId: threadId as number,
  };
}
