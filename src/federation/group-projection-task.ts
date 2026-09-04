import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

export interface GroupMetaHeadFanoutPayload {
  threadId: number;
}

export function readGroupMetaHeadFanoutTask(
  task: DurableTask,
): GroupMetaHeadFanoutPayload {
  if (
    task.kind !== 'PROJECTION' ||
    task.scopeType !== 'GROUP' ||
    task.taskType !== DurableTaskType.FAN_OUT_GROUP_META_HEAD ||
    Object.keys(task.payload).length !== 1 ||
    !Number.isSafeInteger(task.payload.threadId) ||
    Number(task.payload.threadId) <= 0
  )
    throw new Error('invalid Group Meta head fan-out task');
  return { threadId: Number(task.payload.threadId) };
}
