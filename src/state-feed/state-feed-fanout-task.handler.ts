import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { durableTask, identityNamespace } from '../database/schema.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FEDERATION_STATE_FEED_PUSH } from '../federation/federation-state-feed.events.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import {
  lockStateFeedOwnerInTx,
  readStateFeedFanout,
  stateFeedScope,
  yieldStateFeedFanoutInTx,
} from './state-feed-fanout-task.js';

@Injectable()
export class StateFeedFanoutTaskHandler
  implements OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FAN_OUT_STATE_FEED;
  private unregister?: () => void;
  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly database: DatabaseService,
    private readonly clients: ClientStateFeedService,
    private readonly events: EventEmitter2,
  ) {}
  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const input = readStateFeedFanout(task.payload);
    if (
      task.kind !== 'PROJECTION' ||
      task.scopeType !== 'STATE_FEED' ||
      stateFeedScope(input) !== task.scopeKey ||
      stateFeedScope(input) !== task.coalescingKey
    )
      throw new Error('invalid state feed fanout task');
    const effect = await this.database.db.transaction(async (tx) => {
      const ownerExists = await lockStateFeedOwnerInTx(tx, input);
      const [current] = await tx
        .select()
        .from(durableTask)
        .where(eq(durableTask.id, task.id))
        .for('no key update');
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.checkpoint.stateFeedDone === true
      )
        return;
      const namespace =
        input.target === 'PEER'
          ? await tx.query.identityNamespace.findFirst({
              where: eq(identityNamespace.id, input.namespaceId),
            })
          : undefined;
      const retired =
        input.target === 'PEER' && (!namespace || namespace.retiredAt !== null);
      const publish =
        ownerExists &&
        !retired &&
        !(await yieldStateFeedFanoutInTx(tx, task.id, input));
      await saveTaskCheckpointInTx(tx, task.id, { stateFeedDone: true });
      return publish;
    });
    if (!effect) return;
    if (input.target === 'CLIENT')
      this.clients.notifyFeedUpdated({
        userId: input.userId,
        feedId: Number(input.feedId),
      });
    else
      this.events.emit(FEDERATION_STATE_FEED_PUSH, {
        peerDomain: input.peerDomain,
      });
  }
}
