import { relationshipTaskAuthorUserId } from '../relationship/relationship-task-author.js';
import {
  Injectable,
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
import { AccountThreadStateService } from './account-thread-state.service.js';

@Injectable()
export class EndFriendshipTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.END_FRIENDSHIP;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly participants: AccountThreadStateService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const { actorUserId, threadId, expectedAuthorizationEpoch } =
      readTask(task);
    const ended = await this.participants.endP2P(
      threadId,
      actorUserId,
      expectedAuthorizationEpoch,
    );

    for (const domain of ended.statePeers) {
      this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain: domain });
    }
  }
}

function readTask(task: DurableTask): {
  actorUserId: number;
  threadId: number;
  expectedAuthorizationEpoch?: number;
} {
  if (task.scopeType !== 'USER_PAIR') {
    throw new Error('end-friendship task has the wrong scope type');
  }
  if (task.actorUserId === null) {
    throw new Error('end-friendship task has no actor');
  }
  const { threadId } = task.payload;
  const expectedAuthorizationEpoch = task.payload.expectedAuthorizationEpoch;
  if (
    expectedAuthorizationEpoch !== undefined &&
    (!Number.isSafeInteger(expectedAuthorizationEpoch) ||
      (expectedAuthorizationEpoch as number) < 0)
  )
    throw new Error('end-friendship task has an invalid authorization epoch');
  if (!Number.isSafeInteger(threadId) || (threadId as number) < 1) {
    throw new Error('end-friendship task has an invalid thread ID');
  }
  return {
    actorUserId: relationshipTaskAuthorUserId(task),
    threadId: threadId as number,
    expectedAuthorizationEpoch: expectedAuthorizationEpoch as
      | number
      | undefined,
  };
}
