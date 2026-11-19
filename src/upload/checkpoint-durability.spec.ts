import { describe, expect, it, vi, beforeEach } from 'vitest';
import { writeCheckpoint } from './write-checkpoint.js';

const io = vi.hoisted(() => ({
  open: vi.fn(),
  lstat: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('node:fs/promises', () => io);

describe('checkpoint durability ordering', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([false, true])(
    'syncs source before checkpoint IO (source sync fails: %s)',
    async (fail) => {
      const events: string[] = [];
      const failure = new Error('source sync failed');
      io.lstat.mockImplementation(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });
      io.open.mockImplementation(async (path: string) => {
        events.push(`open:${path}`);
        return {
          stat: async () => ({ isFile: () => true }),
          writeFile: async () => {
            events.push('write');
          },
          sync: async () => {
            events.push(`sync:${path}`);
            if (fail && path === '/task.part') throw failure;
          },
          close: async () => {
            events.push(`close:${path}`);
          },
        };
      });
      io.rename.mockImplementation(async () => {
        events.push('rename');
      });
      const work = writeCheckpoint(
        '/task.resume.json',
        '{"offset":4}',
        '/task.part',
      );
      if (fail) {
        await expect(work).rejects.toBe(failure);
        expect(events).toEqual([
          'open:/task.part',
          'sync:/task.part',
          'close:/task.part',
        ]);
        expect(io.lstat).not.toHaveBeenCalled();
        expect(io.rename).not.toHaveBeenCalled();
      } else {
        await work;
        expect(events).toEqual([
          'open:/task.part',
          'sync:/task.part',
          'close:/task.part',
          'open:/task.resume.json.tmp',
          'write',
          'sync:/task.resume.json.tmp',
          'close:/task.resume.json.tmp',
          'rename',
          'open:/',
          'sync:/',
          'close:/',
        ]);
      }
    },
  );
});
