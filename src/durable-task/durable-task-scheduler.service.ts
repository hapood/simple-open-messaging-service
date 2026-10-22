import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { optionalIntEnv } from '../common/env.js';
import { BusinessException } from '../common/business.exception.js';
import { DurableTaskType } from './durable-task.constants.js';
import { DurableTaskDispatcherService } from './durable-task-dispatcher.service.js';
import {
  safeUnexpectedTaskError,
  unexpectedTaskDiagnostics,
} from './durable-task-error.js';
import { DurableTaskStoreService } from './durable-task-store.service.js';
import type { DurableTask } from './durable-task.types.js';

const DISCOVERY_RETRY_MS = 1000;

@Injectable()
export class DurableTaskSchedulerService implements OnApplicationShutdown {
  private readonly logger = new Logger(DurableTaskSchedulerService.name);
  private readonly maxConcurrency = optionalIntEnv(
    'DURABLE_TASK_MAX_CONCURRENCY',
    8,
  );
  private readonly activeTaskIds = new Set<bigint>();
  private readonly activeScopeLanes = new Set<string>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private pumpTask: Promise<void> | null = null;
  private pumpRequested = false;
  private stopping = false;
  private stopTask: Promise<void> | null = null;
  private startupRecovery: DurableTask[] | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: DurableTaskStoreService,
    private readonly dispatcher: DurableTaskDispatcherService,
  ) {}

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  /** Stop new claims, but finish a claim already in flight and its terminal write. */
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.pumpRequested = false;
    this.clearRetryTimer();
    this.stopTask = (async () => {
      if (this.pumpTask) await this.pumpTask;
      await Promise.allSettled([...this.activeExecutions]);
    })();
    return this.stopTask;
  }

  wake(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    this.clearRetryTimer();
    this.pumpRequested = true;
    if (!this.pumpTask) {
      const task = this.pump().finally(() => {
        if (this.pumpTask === task) this.pumpTask = null;
        if (this.pumpRequested && !this.stopping) void this.wake();
      });
      this.pumpTask = task;
    }
    return this.pumpTask;
  }

  private async pump(): Promise<void> {
    let retryDiscovery = false;
    try {
      // Capture interrupted tasks before this process starts any execution. Never
      // rescan PROCESSING during normal scheduling: an in-flight query can return
      // a stale snapshot after a local execution has already finalized.
      if (this.startupRecovery === null) {
        this.startupRecovery = await this.store.findCheckpointedProcessing([
          ...new Set([
            DurableTaskType.DISBAND_GROUP,
            DurableTaskType.REVOKE_FORBIDDEN_GROUP,
            DurableTaskType.FORCE_REVOKE_GROUP_MEMBER,
            DurableTaskType.FAN_OUT_THREAD_CONTENT,
            DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT,
            DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
          ]),
        ]);
      }
      do {
        this.pumpRequested = false;
        await this.fillAvailableSlots();
      } while (this.pumpRequested && !this.stopping);
    } catch (error) {
      retryDiscovery = true;
      this.pumpRequested = false;
      this.logger.error({
        msg: 'durable task scheduler pump failed',
        err: error instanceof Error ? error : undefined,
        failure: unexpectedTaskDiagnostics(error),
      });
    } finally {
      // A failed query is not evidence of an empty queue. Retry discovery, while
      // terminal task failures never cause task execution to be retried.
      if (retryDiscovery && !this.stopping) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.wake();
        }, DISCOVERY_RETRY_MS);
        this.retryTimer.unref();
      }
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async fillAvailableSlots(): Promise<void> {
    while (!this.stopping) {
      let available = this.maxConcurrency - this.activeTaskIds.size;
      if (available <= 0) {
        return;
      }

      const recovery = this.startupRecovery ?? [];
      for (const task of [...recovery]) {
        const scopeLane = taskScopeLane(task);
        if (
          this.activeTaskIds.has(task.id) ||
          this.activeScopeLanes.has(scopeLane)
        ) {
          continue;
        }
        recovery.splice(recovery.indexOf(task), 1);
        this.start(task);
        available -= 1;
        if (available <= 0) return;
      }

      const candidates = await this.store.findEligible(
        this.dispatcher.supportedTaskTypes,
        available,
      );
      if (candidates.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const candidate of candidates) {
        if (this.stopping || this.activeTaskIds.size >= this.maxConcurrency) {
          return;
        }
        if (this.activeScopeLanes.has(taskScopeLane(candidate))) {
          continue;
        }

        const claimed = await this.store.claim(candidate.id);
        if (!claimed) {
          continue;
        }
        claimedAny = true;
        this.start(claimed);
      }

      // A competing claim or completion emits a committed database notification.
      // Yield to that wake instead of spinning on another executor's work.
      if (!claimedAny) {
        return;
      }
    }
  }

  private start(task: DurableTask): void {
    const scopeLane = taskScopeLane(task);
    this.activeTaskIds.add(task.id);
    this.activeScopeLanes.add(scopeLane);
    const execution = this.execute(task).finally(() => {
      this.activeTaskIds.delete(task.id);
      this.activeScopeLanes.delete(scopeLane);
      this.activeExecutions.delete(execution);
      void this.wake();
    });
    this.activeExecutions.add(execution);
  }

  private async execute(task: DurableTask): Promise<void> {
    let outcome:
      | { status: 'SUCCEEDED' }
      | { status: 'REJECTED'; resultCode: number }
      | { status: 'FAILED'; lastError: string };
    try {
      const result = await this.dispatcher.execute(task);
      outcome =
        result?.status === 'REJECTED' ? result : { status: 'SUCCEEDED' };
    } catch (error) {
      if (error instanceof BusinessException) {
        outcome = { status: 'REJECTED', resultCode: error.bizCode };
      } else {
        outcome = {
          status: 'FAILED',
          lastError: safeUnexpectedTaskError(error),
        };
        this.logger.error({
          msg: `durable task ${task.id.toString()} execution failed`,
          err: error instanceof Error ? error : undefined,
          task: taskLogIdentity(task, 'execution'),
          failure: unexpectedTaskDiagnostics(error),
        });
      }
    }

    try {
      if (outcome.status === 'SUCCEEDED') {
        await this.store.markSucceeded(task.id);
      } else if (outcome.status === 'REJECTED') {
        await this.store.markRejected(task.id, outcome.resultCode);
      } else {
        await this.store.markFailed(task.id, outcome.lastError);
      }
    } catch (error) {
      // A lost terminal write deliberately leaves PROCESSING in place. Automatically re-executing
      // would cross the accepted crash window after the business transaction has committed.
      this.logger.error({
        msg: `durable task ${task.id.toString()} finalization failed`,
        err: error instanceof Error ? error : undefined,
        task: taskLogIdentity(task, 'finalization'),
        failure: unexpectedTaskDiagnostics(error),
      });
    }
  }
}

function taskLogIdentity(task: DurableTask, phase: string) {
  return {
    id: task.id.toString(),
    kind: task.kind,
    type: task.taskType,
    scopeType: task.scopeType,
    scopeKey: task.scopeKey,
    phase,
  };
}

function taskScopeLane(task: Pick<DurableTask, 'kind' | 'scopeKey'>): string {
  return JSON.stringify([task.kind, task.scopeKey]);
}
