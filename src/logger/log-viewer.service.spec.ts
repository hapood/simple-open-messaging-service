import { describe, expect, it } from 'vitest';
import { matchesLogFilters } from './log-viewer.service.js';
import type { LogRecord } from './log-stream-store.js';

const record: LogRecord = {
  level: 'info',
  time: 1,
  msg: 'retried media transfer',
  scope: 'media-transfer',
  taskId: 'task-a',
};

describe('matchesLogFilters', () => {
  it('ANDs scope and taskId filters', () => {
    expect(matchesLogFilters(record, {})).toBe(true);
    expect(matchesLogFilters(record, { scope: 'media-transfer' })).toBe(true);
    expect(matchesLogFilters(record, { taskId: 'task-a' })).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'media-transfer', taskId: 'task-a' }),
    ).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'other', taskId: 'task-a' }),
    ).toBe(false);
    expect(
      matchesLogFilters(record, { scope: 'media-transfer', taskId: 'task-b' }),
    ).toBe(false);
  });
});
