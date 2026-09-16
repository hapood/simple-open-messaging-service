import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  runMeasuredExecution,
  type ExecutionMeasurement,
} from '../diagnostics/execution-measurement.js';
import { instrumentDatabaseClient } from './database-execution-measurement.js';

describe('database execution measurement', () => {
  it('measures promise-based driver queries once', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query };
    instrumentDatabaseClient(client as never);
    instrumentDatabaseClient(client as never);
    let measurement: ExecutionMeasurement | undefined;

    await runMeasuredExecution(
      { kind: 'business', name: 'test.promise-query' },
      async () => {
        await client.query('SELECT 1');
      },
      { sampleRate: 1, publish: (value) => (measurement = value) },
    );

    expect(query).toHaveBeenCalledOnce();
    expect(measurement).toEqual(
      expect.objectContaining({
        databaseRoundTripCount: 1,
        databaseFailureCount: 0,
        unfinishedDatabaseRoundTripCount: 0,
      }),
    );
  });

  it('records callback and event-source failures', async () => {
    const callbackFailure = new Error('callback failed');
    const callbackQuery = vi.fn(
      (_sql: string, callback: (error: Error) => void) => {
        callback(callbackFailure);
      },
    );
    const callbackClient = { query: callbackQuery };
    instrumentDatabaseClient(callbackClient as never);
    let callbackMeasurement: ExecutionMeasurement | undefined;
    await runMeasuredExecution(
      { kind: 'business', name: 'test.callback-query' },
      async () => {
        callbackClient.query('SELECT 1', vi.fn());
      },
      {
        sampleRate: 1,
        publish: (value) => (callbackMeasurement = value),
      },
    );

    const eventFailure = new Error('event failed');
    const queryEvents = new EventEmitter();
    const eventClient = { query: vi.fn(() => queryEvents) };
    instrumentDatabaseClient(eventClient as never);
    let eventMeasurement: ExecutionMeasurement | undefined;
    await runMeasuredExecution(
      { kind: 'business', name: 'test.event-query' },
      async () => {
        eventClient.query('SELECT 1');
        queryEvents.emit('error', eventFailure);
      },
      { sampleRate: 1, publish: (value) => (eventMeasurement = value) },
    );

    expect(callbackMeasurement?.databaseFailureCount).toBe(1);
    expect(eventMeasurement?.databaseFailureCount).toBe(1);
  });
});
