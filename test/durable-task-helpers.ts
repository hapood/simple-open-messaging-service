import { expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/database/database.service.js';
import { durableTask, relationshipIntent } from '../src/database/schema.js';
import { findP2PRelationship } from './seed.js';

export async function waitForDurableTask(
  database: Database,
  taskId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const id = BigInt(taskId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await database.query.durableTask.findFirst({
      where: eq(durableTask.id, id),
      columns: { status: true, resultCode: true, lastError: true },
    });
    if (row?.status === 'SUCCEEDED') return;
    if (row?.status === 'REJECTED') {
      throw new Error(`durable task rejected with code ${row.resultCode}`);
    }
    if (row?.status === 'FAILED') {
      throw new Error(`durable task failed: ${row.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`durable task ${taskId} did not complete`);
}

export async function waitForAcceptedDurableTask(
  database: Database,
  responseBody: unknown,
): Promise<void> {
  const data = readResponseData(responseBody);
  if (data.status === 'APPLIED' || data.status === 'NO_OP' || data.status === 'OK') return;
  const taskId = readTaskId(responseBody);
  await waitForDurableTask(database, taskId);
}

export async function waitForAcceptedDurableTasks(
  database: Database,
  responseBody: unknown,
): Promise<void> {
  const data = readResponseData(responseBody);
  // Group invitations commit synchronously and report invited/skipped targets.
  // Their federation delivery is observed by the caller through peer state.
  if (Array.isArray(data.invited) && Array.isArray(data.skipped)) return;
  if (!Array.isArray(data.tasks)) {
    throw new Error('accepted response does not contain tasks');
  }
  await Promise.all(
    data.tasks.map((task) =>
      waitForDurableTask(database, readTaskId({ data: task })),
    ),
  );
}

function readTaskId(responseBody: unknown): string {
  const data = readResponseData(responseBody);
  if (typeof data.taskId !== 'string') {
    throw new Error('accepted response does not contain a taskId');
  }
  return data.taskId;
}

function readResponseData(responseBody: unknown): Record<string, unknown> {
  if (
    !responseBody ||
    typeof responseBody !== 'object' ||
    !('data' in responseBody) ||
    !responseBody.data ||
    typeof responseBody.data !== 'object'
  ) {
    throw new Error('invalid accepted response body');
  }
  return responseBody.data as Record<string, unknown>;
}

/** The local request answers synchronously through the user-intent family: the
 * response carries no taskId, so verify the committed intent state directly. */
export async function waitForLocalRelationshipRequest(
  database: Database,
  responseBody: unknown,
  fromUserId: number,
  toUserId: number,
): Promise<void> {
  const data = readResponseData(responseBody);
  if (typeof data.taskId === 'string') {
    await waitForDurableTask(database, data.taskId);
  } else {
    expect(data).toMatchObject({ status: 'OK' });
  }
  const relationship = await findP2PRelationship(
    database,
    fromUserId,
    toUserId,
  );
  if (!relationship.pair) {
    throw new Error('friend task succeeded without a relationship pair');
  }
  const intent = await database.query.relationshipIntent.findFirst({
    where: and(
      eq(relationshipIntent.pairId, relationship.pair.id),
      eq(relationshipIntent.authorSide, relationship.firstSide),
    ),
    columns: { id: true },
  });
  if (!intent) {
    throw new Error('friend task succeeded without an authored intent');
  }
}
