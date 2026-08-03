import { describe, expect, it } from 'vitest';
import { matchesLogFilters } from './log-viewer.service.js';
import type { LogRecord } from './log-stream-store.js';

const record: LogRecord = {
  level: 'info',
  time: 1,
  msg: 'deleted orphan CAS blob',
  scope: 'media-gc',
  taskId: 'task-a',
};

describe('matchesLogFilters', () => {
  it('ANDs scope and taskId filters', () => {
    expect(matchesLogFilters(record, {})).toBe(true);
    expect(matchesLogFilters(record, { scope: 'media-gc' })).toBe(true);
    expect(matchesLogFilters(record, { taskId: 'task-a' })).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'media-gc', taskId: 'task-a' }),
    ).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'other', taskId: 'task-a' }),
    ).toBe(false);
    expect(
      matchesLogFilters(record, { scope: 'media-gc', taskId: 'task-b' }),
    ).toBe(false);
  });
});
