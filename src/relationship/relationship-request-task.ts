import type { DurableTask } from '../durable-task/durable-task.types.js';

export function readRelationshipRequestTask(task: DurableTask): {
  actorUserId: number;
  peerUserId: number;
} {
  if (task.scopeType !== 'USER_PAIR') {
    throw new Error('relationship request task has the wrong scope type');
  }
  if (task.actorUserId === null) {
    throw new Error('relationship request task has no actor');
  }
  const peerUserId = task.payload.peerUserId;
  if (!Number.isSafeInteger(peerUserId) || (peerUserId as number) <= 0) {
    throw new Error('relationship request task has an invalid peer user ID');
  }
  return { actorUserId: task.actorUserId, peerUserId: peerUserId as number };
}
