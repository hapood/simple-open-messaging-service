import type { durableTask } from '../database/schema.js';

export type DurableTask = typeof durableTask.$inferSelect;

export interface DurableTaskAsyncHandoff {
  status: 'ASYNC_PROCESSING';
}

export type DurableTaskExecutionResult = void | DurableTaskAsyncHandoff;

export interface DurableTaskHandler {
  readonly taskType: string;
  execute(task: DurableTask): Promise<DurableTaskExecutionResult>;
}

export interface DurableAsyncTaskHandler {
  readonly taskType: string;
  /** Runs the recoverable async state machine. A successful return means its final
   * domain transaction has already moved the task out of ASYNC_PROCESSING. */
  execute(task: DurableTask): Promise<void>;
}
