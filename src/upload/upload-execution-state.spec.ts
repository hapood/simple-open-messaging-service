import { describe, expect, it, vi } from 'vitest';
import { UploadExecutionState } from './upload-execution-state.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('upload execution transitions', () => {
  it('cancels immediately, rejects new commands and drains resources before cleanup', async () => {
    const state = new UploadExecutionState();
    const entered = deferred();
    const release = deferred();
    const cleanup = vi.fn(async () => {});
    const invalidated = vi.fn();
    const work = state.run(
      'stage:1',
      async () => {
        entered.resolve();
        await release.promise;
        state.assertCurrent();
        state.beginCommit();
      },
      'file',
    );
    const failed = expect(work).rejects.toThrow('was cancelled');
    await entered.promise;
    const cancel = state.cancel('stage:1', cleanup, invalidated, 'file');
    expect(invalidated).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    await expect(state.run('stage:1', async () => {})).rejects.toThrow('busy');
    await expect(state.cancel('stage:1', cleanup, invalidated)).rejects.toThrow(
      'busy',
    );
    release.resolve();
    await failed;
    await cancel;
    expect(cleanup).toHaveBeenCalledOnce();
    await state.run('stage:1', async () => state.assertCurrent());
  });

  it('rejects cancellation after the commit transition wins', async () => {
    const state = new UploadExecutionState();
    const entered = deferred();
    const release = deferred();
    const work = state.run('stage:1', async () => {
      state.beginCommit();
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const invalidate = vi.fn();
    await expect(
      state.cancel('stage:1', async () => {}, invalidate),
    ).rejects.toThrow('busy');
    expect(invalidate).not.toHaveBeenCalled();
    release.resolve();
    await work;
  });

  it('does not let a single-file cancellation abort a sibling execution', async () => {
    const state = new UploadExecutionState();
    const release = deferred();
    const work = state.run('stage:1', () => release.promise, 'other-file');
    await expect(
      state.cancel(
        'stage:1',
        async () => {},
        () => {},
        'file',
      ),
    ).rejects.toThrow('busy');
    release.resolve();
    await work;
  });

  it('rejects callbacks inherited from a finished execution even while its replacement is running', async () => {
    const state = new UploadExecutionState();
    const release = deferred();
    let late: Promise<void> = Promise.resolve();
    await state.run('stage:1', async () => {
      late = release.promise.then(() => state.assertCurrent());
    });
    const rejected = expect(late).rejects.toThrow('no longer current');
    await state.run('stage:1', async () => {
      release.resolve();
      await rejected;
      state.assertCurrent();
    });
    expect(() => state.assertCurrent()).toThrow('context is missing');
  });

  it('keeps admission closed until resources drain when transport invalidation fails', async () => {
    const state = new UploadExecutionState();
    const release = deferred();
    const work = state.run('stage:1', () => release.promise);
    const cleanup = vi.fn(async () => {});
    const cancellation = state.cancel('stage:1', cleanup, () => {
      throw new Error('adapter failure');
    });
    const rejected = expect(cancellation).rejects.toThrow('adapter failure');
    await expect(state.run('stage:1', async () => {})).rejects.toThrow('busy');
    release.resolve();
    await work;
    await rejected;
    expect(cleanup).not.toHaveBeenCalled();
    await state.cancel('stage:1', cleanup, () => {});
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('allows cleanup to be attempted again after a reported failure', async () => {
    const state = new UploadExecutionState();
    await expect(
      state.cancel(
        'stage:1',
        async () => {
          throw new Error('cleanup failed');
        },
        () => {},
      ),
    ).rejects.toThrow('cleanup failed');
    await state.cancel(
      'stage:1',
      async () => {},
      () => {},
    );
  });
});
