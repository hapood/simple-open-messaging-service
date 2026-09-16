import { Logger, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { messageThread } from '../src/database/schema.js';
import {
  runMeasuredExecution,
  type ExecutionMeasurement,
} from '../src/diagnostics/execution-measurement.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../src/durable-task/durable-task-dispatcher.service.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { DisbandGroupTaskHandler } from '../src/group/disband-group-task.handler.js';
import { GroupService } from '../src/group/business/group.service.js';
import { seedUser } from './seed.js';

describe('execution measurement with PostgreSQL', () => {
  const previousSampleRate = process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE;
  const previousQueryLog = process.env.DATABASE_QUERY_LOG;
  process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE = '1';
  process.env.DATABASE_QUERY_LOG = '0';

  let module: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;
  let dispatcher: DurableTaskDispatcherService;
  let disbandHandler: DisbandGroupTaskHandler;
  let log: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = module.get(DatabaseService);
    groups = module.get(GroupService);
    dispatcher = module.get(DurableTaskDispatcherService);
    disbandHandler = module.get(DisbandGroupTaskHandler);
    disbandHandler.onModuleInit();
  });

  afterAll(async () => {
    disbandHandler.onModuleDestroy();
    await module.close();
    log.mockRestore();
    if (previousSampleRate === undefined)
      delete process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE;
    else process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE = previousSampleRate;
    if (previousQueryLog === undefined) delete process.env.DATABASE_QUERY_LOG;
    else process.env.DATABASE_QUERY_LOG = previousQueryLog;
  });

  it('counts a complex business operation and a nested durable task', async () => {
    const beforeDriverProbe = measurements().length;
    await runMeasuredExecution(
      { kind: 'business', name: 'measurement.driver-probe' },
      () => database.pool.query('SELECT 1'),
    );
    expect(measurements().slice(beforeDriverProbe)).toMatchObject([
      {
        name: 'measurement.driver-probe',
        sqlExecutionCount: 0,
        databaseRoundTripCount: 1,
        databaseFailureCount: 0,
        unfinishedDatabaseRoundTripCount: 0,
      },
    ]);

    const owner = await seedUser(
      module as unknown as INestApplication,
      'measurement-owner',
    );
    const beforeCreate = measurements().length;

    const created = await groups.createNewGroup({
      name: 'Measured group',
      owner: owner.id,
    });

    const createMeasurement = measurements().slice(beforeCreate);
    expect(createMeasurement).toHaveLength(1);
    expect(createMeasurement[0]).toMatchObject({
      event: 'execution_measurement',
      kind: 'business',
      name: 'group.create',
      outcome: 'SUCCEEDED',
      sqlExecutionCount: 170,
      databaseRoundTripCount: 170,
      databaseFailureCount: 0,
      unfinishedDatabaseRoundTripCount: 0,
    });

    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, created.threadId),
    });
    const queued = await module.get(DurableTaskQueueService).enqueueTask({
      scope: {
        type: 'GROUP',
        address: {
          account: thread!.groupAccount!,
          domain: thread!.groupDomain!,
        },
      },
      taskType: DurableTaskType.DISBAND_GROUP,
      actorUserId: owner.id,
      payload: { threadId: created.threadId },
    });
    const task = await module.get(DurableTaskStoreService).claim(queued.taskId);
    const beforeTask = measurements().length;

    await dispatcher.execute(task!);

    const taskMeasurements = measurements().slice(beforeTask);
    expect(taskMeasurements).toHaveLength(2);
    const [disbandMeasurement, taskMeasurement] = taskMeasurements;
    expect(disbandMeasurement).toMatchObject({
      event: 'execution_measurement',
      executionId: `task:${task!.id.toString()}`,
      kind: 'business',
      name: 'group.disband',
      parentKind: 'task',
      parentName: DurableTaskType.DISBAND_GROUP,
      outcome: 'SUCCEEDED',
      sqlExecutionCount: 24,
      databaseRoundTripCount: 24,
      databaseFailureCount: 0,
      unfinishedDatabaseRoundTripCount: 0,
    });
    expect(taskMeasurement).toMatchObject({
      event: 'execution_measurement',
      executionId: `task:${task!.id.toString()}`,
      kind: 'task',
      name: DurableTaskType.DISBAND_GROUP,
      taskId: task!.id.toString(),
      outcome: 'SUCCEEDED',
      sqlExecutionCount: 50,
      databaseRoundTripCount: 50,
      databaseFailureCount: 0,
      unfinishedDatabaseRoundTripCount: 0,
    });
    expect(taskMeasurement.sqlExecutionCount).toBe(
      disbandMeasurement.sqlExecutionCount + 26,
    );
  });

  function measurements(): ExecutionMeasurement[] {
    return log.mock.calls
      .map(([value]) => value)
      .filter(
        (value): value is ExecutionMeasurement =>
          typeof value === 'object' &&
          value !== null &&
          'event' in value &&
          value.event === 'execution_measurement',
      );
  }
});
