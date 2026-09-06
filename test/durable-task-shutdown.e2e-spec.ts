import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { DatabaseService } from '../src/database/database.service.js';
import { durableTask } from '../src/database/schema.js';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { GroupMetaHeadFanoutTaskHandler } from '../src/federation/group-projection-task.handlers.js';
import { GroupProjectionTaskExecutionService } from '../src/federation/group-projection-task-execution.service.js';

describe('application durable-task shutdown ordering', () => {
  it('finishes an in-flight claim before unregistering its handler and leaves unclaimed work pending', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GroupProjectionTaskExecutionService)
      .useValue({ execute })
      .compile();
    const adapter = new FastifyAdapter();
    const app = fixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    const database = app.get(DatabaseService);
    const store = app.get(DurableTaskStoreService);
    const scheduler = app.get(DurableTaskSchedulerService);
    const handler = app.get(GroupMetaHeadFanoutTaskHandler);
    const destroyed = vi.spyOn(handler, 'onModuleDestroy');
    const failed = vi.spyOn(store, 'markFailed');
    const succeeded = vi.spyOn(store, 'markSucceeded');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = store.claim.bind(store);
    let claimed = false;
    vi.spyOn(store, 'claim').mockImplementation(async (id) => {
      const result = await claim(id);
      if (result) {
        claimed = true;
        await gate;
      }
      return result;
    });
    let close: Promise<void> | undefined;
    try {
      const [first] = await database.db
        .insert(durableTask)
        .values({
          kind: 'PROJECTION',
          scopeType: 'GROUP',
          scopeKey: 'shutdown-first',
          taskType: 'FAN_OUT_GROUP_META_HEAD',
          payload: { threadId: 7 },
        })
        .returning();
      void scheduler.wake();
      await vi.waitFor(() => expect(claimed).toBe(true));
      const [pending] = await database.db
        .insert(durableTask)
        .values({
          kind: 'PROJECTION',
          scopeType: 'GROUP',
          scopeKey: 'shutdown-pending',
          taskType: 'FAN_OUT_GROUP_META_HEAD',
          payload: { threadId: 8 },
        })
        .returning();
      close = app.close();
      // Observe the scheduler stop barrier, not a timing-dependent sleep.
      await vi.waitFor(() =>
        expect((scheduler as unknown as { stopping: boolean }).stopping).toBe(
          true,
        ),
      );
      expect(destroyed).not.toHaveBeenCalled();
      release();
      await close;
      expect(execute).toHaveBeenCalledOnce();
      expect(succeeded).toHaveBeenCalledWith(first.id);
      expect(failed).not.toHaveBeenCalled();
      expect(destroyed).toHaveBeenCalledOnce();
      const audit = new Client({ connectionString: process.env.DATABASE_URL });
      await audit.connect();
      try {
        const { rows } = await audit.query(
          'SELECT id::text, status FROM "DurableTask" WHERE id = ANY($1::bigint[]) ORDER BY id',
          [[first.id.toString(), pending.id.toString()]],
        );
        expect(rows).toEqual([
          { id: first.id.toString(), status: 'SUCCEEDED' },
          { id: pending.id.toString(), status: 'PENDING' },
        ]);
      } finally {
        await audit.end();
      }
    } finally {
      release();
      await (close ?? app.close());
      vi.restoreAllMocks();
    }
  }, 60_000);
});
