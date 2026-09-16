import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import type { DurableTask } from './durable-task.types.js';

@Injectable()
export class DurableTaskStoreService {
  constructor(private readonly database: DatabaseService) {}

  async findEligible(
    taskTypes: readonly string[],
    limit: number,
  ): Promise<DurableTask[]> {
    if (taskTypes.length === 0 || limit <= 0) {
      return [];
    }

    const earlier = alias(durableTask, 'earlier_durable_task');
    const processing = alias(durableTask, 'processing_durable_task');
    return this.database.db
      .select()
      .from(durableTask)
      .where(
        and(
          eq(durableTask.status, 'PENDING'),
          inArray(durableTask.taskType, [...taskTypes]),
          notExists(
            this.database.db
              .select({ id: earlier.id })
              .from(earlier)
              .where(
                and(
                  eq(earlier.scopeKey, durableTask.scopeKey),
                  eq(earlier.kind, durableTask.kind),
                  lt(earlier.id, durableTask.id),
                  inArray(earlier.status, ['PENDING', 'PROCESSING']),
                ),
              ),
          ),
          notExists(
            this.database.db
              .select({ id: processing.id })
              .from(processing)
              .where(
                and(
                  eq(processing.scopeKey, durableTask.scopeKey),
                  eq(processing.kind, durableTask.kind),
                  inArray(processing.status, ['PROCESSING']),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(durableTask.id))
      .limit(limit);
  }

  async findCheckpointedProcessing(
    taskTypes: readonly string[],
    limit?: number,
  ): Promise<DurableTask[]> {
    if (taskTypes.length === 0 || (limit !== undefined && limit <= 0))
      return [];
    const query = this.database.db
      .select()
      .from(durableTask)
      .where(
        and(
          eq(durableTask.status, 'PROCESSING'),
          inArray(durableTask.taskType, [...taskTypes]),
        ),
      )
      .orderBy(asc(durableTask.id));
    return limit === undefined ? query : query.limit(limit);
  }

  async claim(taskId: bigint): Promise<DurableTask | undefined> {
    const [claimed] = await this.database.db
      .update(durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(and(eq(durableTask.id, taskId), eq(durableTask.status, 'PENDING')))
      .returning();
    return claimed;
  }

  async markSucceeded(taskId: bigint): Promise<void> {
    // Atomic handlers may have committed their domain effect and terminal task state together.
    const current = await this.database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, taskId),
      columns: { status: true },
    });
    if (current?.status === 'SUCCEEDED') return;
    await this.markTerminal(taskId, {
      status: 'SUCCEEDED',
      completedAt: new Date(),
      resultCode: null,
      lastError: null,
    });
  }

  async markRejected(taskId: bigint, resultCode: number): Promise<void> {
    await this.markTerminal(taskId, {
      status: 'REJECTED',
      completedAt: new Date(),
      resultCode,
      lastError: null,
    });
  }

  async markFailed(taskId: bigint, lastError: string): Promise<void> {
    await this.markTerminal(taskId, {
      status: 'FAILED',
      completedAt: new Date(),
      resultCode: null,
      lastError: lastError.slice(0, 1000),
    });
  }

  private async markTerminal(
    taskId: bigint,
    values: Pick<
      typeof durableTask.$inferInsert,
      'status' | 'completedAt' | 'resultCode' | 'lastError'
    >,
  ): Promise<void> {
    const [updated] = await this.database.db
      .update(durableTask)
      .set(values)
      .where(and(eq(durableTask.id, taskId), eq(durableTask.status, 'PROCESSING')))
      .returning({ id: durableTask.id });
    if (!updated) {
      throw new Error(
        `processing durable task ${taskId.toString()} could not be finalized`,
      );
    }
  }
}
