import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMediaTool } from './media-tool.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

describe('media tool cancellation', () => {
  let child: Child;
  beforeEach(() => {
    vi.resetAllMocks();
    child = new Child();
    spawn.mockReturnValue(child);
  });

  it('does not spawn a process for an already cancelled execution', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      runMediaTool('ffprobe', [], 1024, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills on cancellation but settles only after the child closes', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const result = runMediaTool('ffmpeg', [], 1024, controller.signal);
    const rejected = expect(result).rejects.toBe(reason);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort(reason);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null);
    await rejected;
  });

  it('removes the abort listener after normal completion', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = runMediaTool('ffprobe', [], 1024, controller.signal);
    child.stdout.write('{}');
    child.emit('close', 0);
    expect((await result).toString()).toBe('{}');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
