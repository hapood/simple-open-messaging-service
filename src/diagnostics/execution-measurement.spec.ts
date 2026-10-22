import { describe, expect, it, vi } from 'vitest';
import {
  beginDatabaseRoundTrip,
  recordSqlExecution,
  runMeasuredExecution,
  type ExecutionMeasurement,
} from './execution-measurement.js';

describe('execution measurement', () => {
  it('attributes SQL and database round trips to nested business and task scopes', async () => {
    const measurements: ExecutionMeasurement[] = [];

    await runMeasuredExecution(
      { kind: 'task', name: 'TEST_TASK', executionId: 'task:7', taskId: '7' },
      () =>
        runMeasuredExecution(
          { kind: 'business', name: 'test.apply' },
          async () => {
            recordSqlExecution();
            const finish = beginDatabaseRoundTrip();
            await Promise.resolve();
            finish?.();
          },
          { publish: (value) => measurements.push(value) },
        ),
      {
        sampleRate: 1,
        publish: (value) => measurements.push(value),
      },
    );

    expect(measurements).toHaveLength(2);
    expect(measurements[0]).toEqual(
      expect.objectContaining({
        executionId: 'task:7',
        kind: 'business',
        name: 'test.apply',
        parentKind: 'task',
        parentName: 'TEST_TASK',
        sqlExecutionCount: 1,
        databaseRoundTripCount: 1,
        databaseFailureCount: 0,
        unfinishedDatabaseRoundTripCount: 0,
      }),
    );
    expect(measurements[1]).toEqual(
      expect.objectContaining({
        executionId: 'task:7',
        kind: 'task',
        name: 'TEST_TASK',
        taskId: '7',
        sqlExecutionCount: 1,
        databaseRoundTripCount: 1,
      }),
    );
  });

  it('records failed driver calls without changing the operation error', async () => {
    const publish = vi.fn<(value: ExecutionMeasurement) => void>();
    const failure = new Error('database unavailable');

    await expect(
      runMeasuredExecution(
        { kind: 'business', name: 'test.fail' },
        async () => {
          recordSqlExecution();
          beginDatabaseRoundTrip()?.(failure);
          throw failure;
        },
        { sampleRate: 1, publish },
      ),
    ).rejects.toBe(failure);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        sqlExecutionCount: 1,
        databaseRoundTripCount: 1,
        databaseFailureCount: 1,
      }),
    );
  });

  it('does not create a context when sampling is disabled', async () => {
    const publish = vi.fn();
    await runMeasuredExecution(
      { kind: 'business', name: 'test.disabled' },
      async () => {
        recordSqlExecution();
        expect(beginDatabaseRoundTrip()).toBeUndefined();
      },
      { sampleRate: 0, publish },
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
