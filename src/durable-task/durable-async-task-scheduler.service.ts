import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { optionalIntEnv } from '../common/env.js';
import { DurableAsyncTaskDispatcherService } from './durable-async-task-dispatcher.service.js';
import {
  safeUnexpectedTaskError,
  unexpectedTaskDiagnostics,
} from './durable-task-error.js';
import { DurableTaskStoreService } from './durable-task-store.service.js';
import type { DurableTask } from './durable-task.types.js';

/** Runs recoverable asynchronous task state machines independently of the
 * ordinary durable-task executor. Network concurrency remains the responsibility
 * of the network scheduler used by each handler. */
@Injectable()
export class DurableAsyncTaskSchedulerService implements OnApplicationShutdown {
  private readonly logger = new Logger(DurableAsyncTaskSchedulerService.name);
  private readonly maxConcurrency = optionalIntEnv(
    'DURABLE_ASYNC_TASK_MAX_CONCURRENCY',
    8,
  );
  private readonly pendingTasks: DurableTask[] = [];
  private readonly activeExecutions = new Set<Promise<void>>();
  private activeCount = 0;
  private stopping = false;

  constructor(
    private readonly dispatcher: DurableAsyncTaskDispatcherService,
    private readonly store: DurableTaskStoreService,
  ) {}

  get supportedTaskTypes(): readonly string[] {
    return this.dispatcher.supportedTaskTypes;
  }

  enqueue(task: DurableTask): void {
    if (task.status !== 'ASYNC_PROCESSING') {
      throw new Error('only ASYNC_PROCESSING tasks may be scheduled async');
    }
    if (this.stopping) return;
    this.pendingTasks.push(task);
    this.fillAvailableSlots();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.pendingTasks.length = 0;
    await Promise.allSettled([...this.activeExecutions]);
  }

  private fillAvailableSlots(): void {
    while (
      !this.stopping &&
      this.activeCount < this.maxConcurrency &&
      this.pendingTasks.length > 0
    ) {
      const task = this.pendingTasks.shift();
      if (!task) return;
      this.activeCount += 1;
      const execution = this.execute(task).finally(() => {
        this.activeCount -= 1;
        this.activeExecutions.delete(execution);
        this.fillAvailableSlots();
      });
      this.activeExecutions.add(execution);
    }
  }

  private async execute(task: DurableTask): Promise<void> {
    try {
      await this.dispatcher.execute(task);
    } catch (error) {
      const lastError = safeUnexpectedTaskError(error);
      this.logger.error({
        msg: `async durable task ${task.id.toString()} execution failed`,
        err: error instanceof Error ? error : undefined,
        task: {
          id: task.id.toString(),
          kind: task.kind,
          type: task.taskType,
          scopeType: task.scopeType,
          scopeKey: task.scopeKey,
          phase: 'async-execution',
        },
        failure: unexpectedTaskDiagnostics(error),
      });
      try {
        await this.store.markAsyncFailed(task.id, lastError);
      } catch (finalizationError) {
        this.logger.error({
          msg: `async durable task ${task.id.toString()} failure finalization failed`,
          err:
            finalizationError instanceof Error ? finalizationError : undefined,
          task: {
            id: task.id.toString(),
            kind: task.kind,
            type: task.taskType,
            scopeType: task.scopeType,
            scopeKey: task.scopeKey,
            phase: 'async-finalization',
          },
          failure: unexpectedTaskDiagnostics(finalizationError),
        });
      }
    }
  }
}
