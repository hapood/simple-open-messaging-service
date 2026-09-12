import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { requireThreadContentLockInTx } from '../business/shared/locks/thread-content-lock.js';
import {
  parseThreadFanoutTarget,
  threadFanoutScope,
  yieldThreadFanoutInTx,
  type ThreadFanoutTarget,
} from '../message/thread-fanout-task.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

export function readFederationFanoutProgress(value: Record<string, unknown>): {
  phase: 'FEED' | 'DONE';
  afterNamespaceId: number;
} {
  if (Object.keys(value).length === 0)
    return { phase: 'FEED', afterNamespaceId: 0 };
  const { phase, afterNamespaceId } = value;
  if (
    (phase !== 'FEED' && phase !== 'DONE') ||
    typeof afterNamespaceId !== 'number' ||
    !Number.isSafeInteger(afterNamespaceId) ||
    afterNamespaceId < 0
  )
    throw new Error('Invalid federation fanout checkpoint');
  return { phase, afterNamespaceId };
}

/** Project one peer and checkpoint atomically; network wake-ups remain lossy. */
@Injectable()
export class FederationThreadFanoutTaskHandler
  implements OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT;
  private unregister?: () => void;
  private readonly logger = new Logger(FederationThreadFanoutTaskHandler.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly heads: FederationThreadContentHeadService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const target = parseThreadFanoutTarget(task.payload);
    if (
      task.kind !== 'PROJECTION' ||
      task.scopeType !== 'THREAD' ||
      task.taskType !== this.taskType ||
      task.scopeKey !== threadFanoutScope(this.taskType, target.threadId)
    )
      throw new Error('Federation fanout task scope mismatch');
    for (;;) {
      const result = await this.projectNext(task.id, target);
      if (result.done) return;
      try {
        // The existing per-peer scheduler coalesces attempts at one-second intervals.
        this.events.emit(FEDERATION_STATE_FEED_PUSH, {
          peerDomain: result.peerDomain,
        });
      } catch (error) {
        this.logger.warn(`Federation wake hint failed: ${String(error)}`);
      }
    }
  }

  private async projectNext(
    taskId: bigint,
    target: ThreadFanoutTarget,
  ): Promise<{ done: true } | { done: false; peerDomain: string }> {
    return this.database.db.transaction(async (tx) => {
      // Preserve business -> thread -> projection/task lock ordering.
      const lock = await requireThreadContentLockInTx(tx, target.threadId);
      const task = await tx.query.durableTask.findFirst({
        where: eq(durableTask.id, taskId),
      });
      if (!task || task.status !== 'PROCESSING')
        throw new Error('Federation fanout task is not processing');
      const checkpoint = readFederationFanoutProgress(task.checkpoint);
      if (checkpoint.phase === 'DONE') return { done: true };
      const done = { phase: 'DONE', afterNamespaceId: 0 };
      if (
        await yieldThreadFanoutInTx(
          tx,
          lock,
          taskId,
          target,
          this.taskType,
          done,
        )
      )
        return { done: true };

      // Use current direct routes, including the origin of a mirrored group.
      // refreshInTx remains the authority for each peer's visible content window.
      const routes = await tx.execute<{
        peerDomain: string;
        namespaceId: number;
      }>(sql`
        SELECT namespace.domain AS "peerDomain", namespace.id AS "namespaceId"
        FROM "IdentityNamespace" namespace
        JOIN "FederatedPeer" peer ON peer.domain = namespace.domain
          AND peer."activeNamespaceId" = namespace.id
        JOIN "MessageThread" thread ON thread.id = ${target.threadId}
        WHERE namespace."retiredAt" IS NULL
          AND namespace.id > ${checkpoint.afterNamespaceId}
          AND (
            EXISTS (
              SELECT 1 FROM "ThreadAudience" audience
              WHERE audience."threadId" = thread.id
                AND audience."localUserId" IS NULL
                AND audience."targetNamespaceId" = namespace.id
                AND audience."targetDomain" = namespace.domain
                AND (thread.type = 'P2P' OR thread."groupDomain" = 'local')
            )
            OR (thread.type = 'GROUP'
              AND thread."groupDomain" = namespace.domain
              AND thread."authorityNamespaceId" = namespace.id
              AND EXISTS (
                SELECT 1 FROM "AccountThreadState" state
                WHERE state."threadId" = thread.id
              ))
          )
        ORDER BY namespace.id LIMIT 1
      `);
      const next = routes.rows[0];
      if (!next) {
        await saveTaskCheckpointInTx(tx, taskId, done);
        return { done: true };
      }
      await this.heads.refreshInTx(
        tx,
        next.peerDomain,
        next.namespaceId,
        target.threadId,
      );
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'FEED',
        afterNamespaceId: next.namespaceId,
      });
      return { done: false, peerDomain: next.peerDomain };
    });
  }
}
