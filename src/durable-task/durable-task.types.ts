import type { durableTask } from '../database/schema.js';

export type DurableTask = typeof durableTask.$inferSelect;

interface DurableTaskRejected {
  status: 'REJECTED';
  resultCode: number;
}

export type DurableTaskExecutionResult = void | DurableTaskRejected;

export interface DurableTaskHandler {
  readonly taskType: string;
  execute(task: DurableTask): Promise<DurableTaskExecutionResult>;
}
