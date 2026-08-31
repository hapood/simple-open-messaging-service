import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { domainCommand } from '../src/database/schema.js';
import { DomainCommandQueueService } from '../src/domain-command/domain-command-queue.service.js';
import { DomainCommandStoreService } from '../src/domain-command/domain-command-store.service.js';

describe('domain command enqueue', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let queue: DomainCommandQueueService;
  let store: DomainCommandStoreService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [DomainCommandQueueService, DomainCommandStoreService],
    }).compile();
    database = mod.get(DatabaseService);
    queue = mod.get(DomainCommandQueueService);
    store = mod.get(DomainCommandStoreService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "DomainCommand" RESTART IDENTITY',
    );
  });

  it('persists concurrent equivalent requests as distinct ordered commands', async () => {
    const aggregate = {
      type: 'USER_PAIR' as const,
      endpoints: [
        { domain: 'chat.example', account: 'alice' },
        { domain: 'remote.example', account: 'bob' },
      ] as const,
    };

    const results = await Promise.all([
      queue.enqueue({
        aggregate,
        commandType: 'SEND_FRIEND_REQUEST',
        actorUserId: 11,
        payload: { source: 'first' },
      }),
      queue.enqueue({
        aggregate,
        commandType: 'SEND_FRIEND_REQUEST',
        actorUserId: 11,
        payload: { source: 'second' },
      }),
    ]);

    expect(new Set(results.map(({ commandId }) => commandId)).size).toBe(2);
    const rows = await database.db
      .select({
        id: domainCommand.id,
        aggregateKey: domainCommand.aggregateKey,
        status: domainCommand.status,
        payload: domainCommand.payload,
      })
      .from(domainCommand)
      .where(eq(domainCommand.aggregateType, 'USER_PAIR'))
      .orderBy(asc(domainCommand.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].aggregateKey).toBe(rows[1].aggregateKey);
    expect(rows.map(({ status }) => status)).toEqual(['PENDING', 'PENDING']);
    expect(rows.map(({ payload }) => payload.source).sort()).toEqual([
      'first',
      'second',
    ]);
  });

  it('allows only one concurrent conditional claim', async () => {
    const { commandId } = await queue.enqueue({
      aggregate: {
        type: 'GROUP',
        address: { domain: 'chat.example', account: 'group-1' },
      },
      commandType: 'DISBAND_GROUP',
      actorUserId: 11,
      payload: {},
    });

    const claims = await Promise.all([
      store.claim(commandId),
      store.claim(commandId),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.find((claim) => claim !== undefined)?.status).toBe(
      'PROCESSING',
    );
  });

  it('blocks successors behind pending, processing, and failed commands but not rejected ones', async () => {
    const groupAggregate = {
      type: 'GROUP' as const,
      address: { domain: 'chat.example', account: 'group-1' },
    };
    const otherAggregate = {
      type: 'GROUP' as const,
      address: { domain: 'chat.example', account: 'group-2' },
    };
    const first = await queue.enqueue({
      aggregate: groupAggregate,
      commandType: 'GROUP_MUTATION',
      payload: { ordinal: 1 },
    });
    const second = await queue.enqueue({
      aggregate: groupAggregate,
      commandType: 'GROUP_MUTATION',
      payload: { ordinal: 2 },
    });
    const unrelated = await queue.enqueue({
      aggregate: otherAggregate,
      commandType: 'GROUP_MUTATION',
      payload: { ordinal: 3 },
    });

    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      first.commandId,
      unrelated.commandId,
    ]);
    expect(await store.claim(first.commandId)).toBeDefined();
    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      unrelated.commandId,
    ]);

    await store.markRejected(first.commandId, 40001);
    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      second.commandId,
      unrelated.commandId,
    ]);

    expect(await store.claim(second.commandId)).toBeDefined();
    await store.markFailed(
      second.commandId,
      'Unexpected command error (Error)',
    );
    const third = await queue.enqueue({
      aggregate: groupAggregate,
      commandType: 'GROUP_MUTATION',
      payload: { ordinal: 4 },
    });
    const eligibleAfterFailure = await eligibleIds('GROUP_MUTATION');
    expect(eligibleAfterFailure).toContain(unrelated.commandId);
    expect(eligibleAfterFailure).not.toContain(third.commandId);
  });

  async function eligibleIds(commandType: string): Promise<bigint[]> {
    return (await store.findEligible([commandType], 20)).map(({ id }) => id);
  }
});
