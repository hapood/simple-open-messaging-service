import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { messageThread } from '../../database/schema.js';
import { RelationshipIntentService } from './relationship-intent.service.js';

function harness(existing: boolean) {
  const events: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let found = existing;
  const tx = {
    query: {
      account: {
        findFirst: vi.fn(async () => ({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
        })),
      },
      relationshipIntent: { findFirst: vi.fn(async () => undefined) },
    },
    execute: vi.fn(async (statement) => {
      const query = new PgDialect().sqlToQuery(statement);
      queries.push(query);
      if (query.sql.includes('pg_advisory_xact_lock')) {
        events.push('scope');
        return { rows: [] };
      }
      events.push('pair');
      return { rows: found ? [{ id: '1', active: false, threadId: 7 }] : [] };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: async () => {
          events.push('create');
          found = true;
        },
      })),
    })),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === messageThread)
            return {
              for: () => ({
                limit: async () => {
                  events.push('thread');
                  return [{ id: 7 }];
                },
              }),
            };
          return {
            orderBy: () => ({
              for: async () => {
                events.push('intents');
                return [];
              },
            }),
          };
        },
      }),
    })),
  };
  return {
    tx: tx as unknown as DatabaseTransaction,
    events,
    queries,
    insert: tx.insert,
  };
}

const remote = { account: 'BOB', domain: ' PEER.TEST ', namespaceId: 9 };

describe('P2P lookup and mutation key preparation', () => {
  it('does not create a missing pair during lookup', async () => {
    const h = harness(false);
    const result =
      await new RelationshipIntentService().readP2PRelationshipByAddressInTx(
        h.tx,
        1,
        remote,
      );
    expect(result).toBeUndefined();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.events).toEqual(['scope', 'scope', 'pair']);
  });

  it('shares canonical keys while preserving the distinct lock sequences', async () => {
    const service = new RelationshipIntentService();
    const lookup = harness(true);
    const mutation = harness(false);
    const read = await service.readP2PRelationshipByAddressInTx(
      lookup.tx,
      1,
      remote,
    );
    const written = await service.lockPairInTx(mutation.tx, remote, 1);
    expect(written.endpointA).toEqual(read!.pair.endpointA);
    expect(written.endpointB).toEqual(read!.pair.endpointB);
    expect(written.endpointB).toMatchObject({
      account: 'bob',
      domain: 'peer.test',
      namespaceId: 9,
    });
    expect(lookup.queries.slice(0, 2)).toEqual(mutation.queries.slice(0, 2));
    expect(lookup.events).toEqual(['scope', 'scope', 'pair', 'intents']);
    expect(mutation.events).toEqual([
      'scope',
      'scope',
      'create',
      'pair',
      'thread',
      'intents',
    ]);
    expect(lookup.insert).not.toHaveBeenCalled();
    expect(mutation.insert).toHaveBeenCalledOnce();
  });

  it('rejects identical normalized endpoints before taking any locks', async () => {
    const h = harness(false);
    await expect(
      new RelationshipIntentService().lockPairInTx(h.tx, 1, {
        account: 'ALICE',
        domain: ' LOCAL ',
        namespaceId: 0,
      }),
    ).rejects.toThrow('relationship endpoints must be distinct');
    expect(h.events).toEqual([]);
    expect(h.insert).not.toHaveBeenCalled();
  });
});
