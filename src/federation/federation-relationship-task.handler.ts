import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { durableTask, federatedPeer } from '../database/schema.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

@Injectable()
export class FederationRelationshipTaskHandler
  implements OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly database: DatabaseService,
    private readonly consumer: FederationStateFeedConsumerService,
    private readonly pull: FederationStatePullService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    if (task.checkpoint.relationshipApplied === true) return;
    const { peerDomain, namespaceId, item } = task.payload;
    if (
      task.kind !== 'MUTATION' ||
      typeof peerDomain !== 'string' ||
      typeof namespaceId !== 'number' ||
      !Number.isSafeInteger(namespaceId) ||
      namespaceId <= 0 ||
      !item ||
      typeof item !== 'object' ||
      (item as { eventType?: unknown }).eventType !== 'RELATIONSHIP_INTENT'
    )
      throw new Error('Invalid federated relationship task');
    const effect = await this.database.db.transaction(async (tx) => {
      const current = await tx.query.durableTask.findFirst({
        where: eq(durableTask.id, task.id),
      });
      if (current?.checkpoint.relationshipApplied === true) return;
      // Peer lifecycle fencing precedes business locks, as in namespace retirement.
      const [peer] = await tx
        .select({ namespaceId: federatedPeer.activeNamespaceId })
        .from(federatedPeer)
        .where(eq(federatedPeer.domain, peerDomain))
        .for('no key update');
      const applied =
        peer?.namespaceId === namespaceId
          ? await this.consumer.applyPageInTx(
              tx,
              peerDomain,
              namespaceId,
              {
                items: [item as PeerStateFeedPage['items'][number]],
                scannedThrough: '0',
                stateFeedEndId: '0',
                hasMore: false,
              },
              'TASK',
            )
          : undefined;
      await saveTaskCheckpointInTx(tx, task.id, { relationshipApplied: true });
      return applied;
    });
    if (effect) await this.pull.publishEffect(effect);
  }
}
