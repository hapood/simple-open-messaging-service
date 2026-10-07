import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  CallHistoryService,
  type CallHistorySnapshot,
} from '../src/calls/call-history.service.js';
import {
  callHistory,
  durableTask,
  message,
  messageThread,
} from '../src/database/schema.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';

describe('local terminal call history transactions', () => {
  let database: DatabaseService;
  let history: CallHistoryService;
  beforeAll(() => {
    database = new DatabaseService();
    history = new CallHistoryService(database);
  });
  afterAll(async () => {
    await database.pool.end();
  });
  async function snapshot(): Promise<CallHistorySnapshot> {
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    return {
      key: `test:${thread.id}`,
      threadId: thread.id,
      revision: 1,
      content: {
        type: 'CALL_ENDED',
        callId: `call-${thread.id}`,
        caller: {
          account: 'alice',
          domain: 'a.test',
          profileNamespaceId: 1,
          profileRev: 0,
        },
        callee: {
          account: 'bob',
          domain: 'b.test',
          profileNamespaceId: 2,
          profileRev: 0,
        },
        mediaType: 'AUDIO',
        outcome: 'missed',
        initiatedAt: 100,
        endedAt: 500,
      },
    };
  }
  it('creates no live message and commits one terminal message with device-only fanout', async () => {
    const call = await snapshot();
    await history.observe(call);
    expect(
      await database.db
        .select()
        .from(message)
        .where(eq(message.threadId, call.threadId)),
    ).toHaveLength(0);
    await Promise.all([history.finish(call), history.finish(call)]);
    const rows = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, call.threadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contentType: 'SYSTEM',
      creatorAccount: '$system',
      originSeq: null,
    });
    expect(JSON.parse(rows[0].content)).toEqual(call.content);
    await expect(history.observe(call)).rejects.toThrow(
      'call identifier already used',
    );
    const tasks = await database.db
      .select()
      .from(durableTask)
      .where(eq(durableTask.taskType, DurableTaskType.FAN_OUT_THREAD_CONTENT));
    expect(
      tasks.filter((t) => t.payload.threadId === call.threadId),
    ).toHaveLength(1);
    const remote = await database.db
      .select()
      .from(durableTask)
      .where(
        eq(
          durableTask.taskType,
          DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
        ),
      );
    expect(
      remote.filter((t) => t.payload.threadId === call.threadId),
    ).toHaveLength(0);
  });
  it.each(['observe', 'finish'] as const)(
    '%s waits for the thread before locking the call-history row',
    async (operation) => {
      const call = await snapshot();
      await history.observe(call);
      const blocker = await database.pool.connect();
      let work: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const {
          rows: [{ pid }],
        } = await blocker.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        );
        await blocker.query(
          'SELECT id FROM "MessageThread" WHERE id = $1 FOR UPDATE',
          [call.threadId],
        );
        work = history[operation]({ ...call, revision: 2 }).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.waitFor(
          async () => {
            const { rows } = await database.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [pid],
            );
            expect(rows.length).toBeGreaterThan(0);
          },
          { timeout: 3000, interval: 25 },
        );
        // A child-first writer would hold this row while waiting for our parent.
        await blocker.query(
          'SELECT key FROM "CallHistory" WHERE key = $1 FOR UPDATE NOWAIT',
          [call.key],
        );
        await blocker.query('COMMIT');
        expect(await work).toBeNull();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (work) await work;
      }
    },
  );

  it('recovers the exact terminal decision after its message transaction fails', async () => {
    const call = await snapshot();
    await history.observe(call);
    const runTransaction = database.db.transaction.bind(database.db);
    const failure = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce(runTransaction)
      .mockRejectedValueOnce(new Error('interrupted write'));
    await expect(history.finish(call)).rejects.toThrow('interrupted write');
    failure.mockRestore();
    expect(
      await database.db
        .select()
        .from(message)
        .where(eq(message.threadId, call.threadId)),
    ).toHaveLength(0);
    const recovered = new CallHistoryService(database);
    await recovered.onModuleInit();
    const [row] = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, call.threadId));
    expect(JSON.parse(row.content)).toEqual(call.content);
    await history.finish({
      ...call,
      content: { ...call.content, outcome: 'cancelled' },
    });
    const [journal] = await database.db
      .select()
      .from(callHistory)
      .where(eq(callHistory.key, call.key));
    expect(journal.snapshot.outcome).toBe('missed');
  });
  it('continues startup recovery after a failed write', async () => {
    const calls = [await snapshot(), await snapshot()];
    for (const call of calls) await history.observe(call);
    const recovered = new CallHistoryService(database);
    const runTransaction = database.db.transaction.bind(database.db);
    const transaction = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce(runTransaction)
      .mockRejectedValueOnce(new Error('temporary recovery write failure'));
    try {
      await recovered.onModuleInit();
      transaction.mockRestore();
      const journals = await database.db.select().from(callHistory);
      const affected = journals.filter((row) =>
        calls.some((call) => call.key === row.key),
      );
      expect(affected.filter((row) => row.messageSeq !== null)).toHaveLength(1);
      expect(affected.every((row) => row.terminal)).toBe(true);
    } finally {
      transaction.mockRestore();
    }
  });

  it('recovers an interrupted live call as failed without inventing connection time', async () => {
    const call = await snapshot();
    await history.observe(call);
    const recovered = new CallHistoryService(database);
    await recovered.onModuleInit();
    const [row] = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, call.threadId));
    expect(JSON.parse(row.content)).toMatchObject({
      outcome: 'failed',
      initiatedAt: 100,
    });
    expect(JSON.parse(row.content).connectedAt).toBeUndefined();
  });
});
