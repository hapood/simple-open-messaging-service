import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/database/database.service.js';
import { domainCommand, relationshipIntent } from '../src/database/schema.js';
import { findP2PRelationship } from './seed.js';

export async function waitForDomainCommand(
  database: Database,
  commandId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const id = BigInt(commandId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await database.query.domainCommand.findFirst({
      where: eq(domainCommand.id, id),
      columns: { status: true, resultCode: true, lastError: true },
    });
    if (row?.status === 'SUCCEEDED') return;
    if (row?.status === 'REJECTED') {
      throw new Error(`domain command rejected with code ${row.resultCode}`);
    }
    if (row?.status === 'FAILED') {
      throw new Error(`domain command failed: ${row.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`domain command ${commandId} did not complete`);
}

export async function waitForAcceptedDomainCommand(
  database: Database,
  responseBody: unknown,
): Promise<void> {
  const commandId = readCommandId(responseBody);
  await waitForDomainCommand(database, commandId);
}

export async function waitForAcceptedDomainCommands(
  database: Database,
  responseBody: unknown,
): Promise<void> {
  const data = readResponseData(responseBody);
  if (!Array.isArray(data.commands)) {
    throw new Error('accepted response does not contain commands');
  }
  await Promise.all(
    data.commands.map((command) =>
      waitForDomainCommand(database, readCommandId({ data: command })),
    ),
  );
}

function readCommandId(responseBody: unknown): string {
  const data = readResponseData(responseBody);
  if (typeof data.commandId !== 'string') {
    throw new Error('accepted response does not contain a commandId');
  }
  return data.commandId;
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

export async function waitForLocalFriendInvite(
  database: Database,
  commandId: string,
  fromUserId: number,
  toUserId: number,
): Promise<string> {
  await waitForDomainCommand(database, commandId);
  const relationship = await findP2PRelationship(
    database,
    fromUserId,
    toUserId,
  );
  if (!relationship.pair) {
    throw new Error('friend command succeeded without a relationship pair');
  }
  const intent = await database.query.relationshipIntent.findFirst({
    where: and(
      eq(relationshipIntent.pairId, relationship.pair.id),
      eq(relationshipIntent.authorSide, relationship.firstSide),
    ),
    columns: { id: true },
  });
  if (!intent) {
    throw new Error('friend command succeeded without an authored intent');
  }
  return intent.id.toString();
}
