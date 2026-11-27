import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionOwner,
  type BrowserSessionResources,
} from './browser-session-owner';
import { SessionStore } from './session-store';
import { MemorySessionStorage as MemoryStorage } from './session-store.test-helper';
import { DatabaseRestorationError } from './database-restoration-error';
import { SessionSupersededError } from './session-identity';

function setup(storage = new MemoryStorage()) {
  const resources = {
    close: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    restore: vi.fn(
      async (
        _session: import('./session-identity').SessionCacheDescriptor,
        _signal: AbortSignal,
      ) => {},
    ),
    delete: vi.fn(async () => {}),
    prepareFreshCache: vi.fn(async () => {}),
    resetState: vi.fn(),
  } satisfies BrowserSessionResources;
  const sessionStore = new SessionStore(storage);
  const invalidate = vi.fn();
  const publish = vi.fn();
  const owner = new BrowserSessionOwner(
    sessionStore,
    resources,
    invalidate,
    publish,
    { primary: 'https://chat.test' },
  );
  return { owner, sessionStore, resources, invalidate, publish, storage };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function login(owner: BrowserSessionOwner) {
  await owner.authenticate((signal) => owner.activate(signal));
  return owner.currentSession!;
}
afterEach(() => vi.useRealTimers());

describe('browser app-state owner', () => {
  it('invalidates once and deletes the fixed cache on explicit local logout', async () => {
    const { owner, resources, invalidate, sessionStore } = setup();
    const session = await login(owner);
    expect(resources.initialize).toHaveBeenCalledExactlyOnceWith(session);
    resources.delete.mockClear();
    await owner.end();
    expect(owner.currentSession).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(resources.resetState).toHaveBeenCalledTimes(2);
    expect(resources.delete).toHaveBeenCalledOnce();
    expect(await sessionStore.read()).toMatchObject({
      lifecycleState: 'signed-out',
      session: null,
    });
  });

  it('deletes old caches before issuing fresh authentication, including interrupted preparation', async () => {
    const { owner, resources, sessionStore } = setup();
    resources.initialize.mockRejectedValueOnce(new Error('Disk full'));
    await expect(login(owner)).rejects.toThrow('Disk full');
    expect((await sessionStore.read()).lifecycleState).toBe('signed-out');
    resources.delete.mockClear();
    await owner.authenticate(async (signal) => {
      expect(resources.delete).toHaveBeenCalledOnce();
      await owner.activate(signal);
    });
    expect(owner.currentSession).not.toBeNull();
  });

  it('resumes failed deletion at restart, locally, and blocks successor login until completion', async () => {
    const original = setup();
    const previous = await login(original.owner);
    original.resources.delete.mockRejectedValueOnce(
      new Error('Deletion failed'),
    );
    await expect(original.owner.end()).rejects.toThrow('Deletion failed');
    expect(await original.sessionStore.read()).toMatchObject({
      lifecycleState: 'cleaning',
      session: { id: previous.id },
    });
    const restarted = setup(original.storage);
    const deletion = deferred();
    restarted.resources.delete.mockReturnValueOnce(deletion.promise);
    const restoring = restarted.owner
      .restore(true)
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(restarted.resources.delete).toHaveBeenCalledOnce(),
    );
    const request = vi.fn(async (signal: AbortSignal) =>
      restarted.owner.activate(signal),
    );
    const signingIn = restarted.owner.authenticate(request);
    expect(request).not.toHaveBeenCalled();
    deletion.resolve();
    expect(await restoring).toBeInstanceOf(SessionSupersededError);
    await signingIn;
    expect(restarted.owner.currentSession?.id).not.toBe(previous.id);
  });

  it('serializes failed-restore recovery deletion before fresh login admission', async () => {
    const original = setup();
    await login(original.owner);
    const { owner, resources } = setup(original.storage);
    resources.restore.mockRejectedValueOnce(
      new DatabaseRestorationError(new Error('unreadable cache')),
    );
    const deletion = deferred();
    const recover = vi.fn(() => deletion.promise);
    const restoring = owner
      .restore(true, recover)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    const signingIn = login(owner);
    await Promise.resolve();
    expect(resources.initialize).not.toHaveBeenCalled();
    deletion.resolve();
    expect(await restoring).toBeInstanceOf(SessionSupersededError);
    await signingIn;
    expect(resources.initialize).toHaveBeenCalledOnce();
  });

  it('fresh login cancels restoration, drains it, and deletes the cache before creating its successor', async () => {
    const original = setup();
    await login(original.owner);
    const { owner, resources } = setup(original.storage);
    const read = deferred();
    const deletion = deferred();
    resources.restore.mockImplementationOnce(async (_session, signal) => {
      await read.promise;
      expect(signal.aborted).toBe(true);
    });
    const recovery = vi.fn(async () => {});
    const restoring = owner
      .restore(true, recovery)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(resources.restore).toHaveBeenCalledOnce());
    resources.delete.mockReturnValueOnce(deletion.promise);
    const signingIn = login(owner);
    await Promise.resolve();
    expect(resources.delete).not.toHaveBeenCalled();
    read.resolve();
    expect(await restoring).toBeInstanceOf(SessionSupersededError);
    await vi.waitFor(() => expect(resources.delete).toHaveBeenCalledOnce());
    expect(resources.initialize).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    deletion.resolve();
    await signingIn;
    expect(resources.close.mock.invocationCallOrder.at(-1)).toBeLessThan(
      resources.delete.mock.invocationCallOrder[0],
    );
    expect(resources.delete.mock.invocationCallOrder[0]).toBeLessThan(
      resources.initialize.mock.invocationCallOrder[0],
    );
  });

  it('closes handles even if writing the cleanup marker fails, without deleting evidence', async () => {
    const { owner, storage, resources } = setup();
    await login(owner);
    resources.close.mockClear();
    resources.delete.mockClear();
    storage.failWrites = true;
    const ending = owner.end();
    expect(owner.currentSession).toBeNull();
    await expect(ending).rejects.toThrow('Metadata unavailable');
    expect(resources.close).toHaveBeenCalledOnce();
    expect(resources.delete).not.toHaveBeenCalled();
  });

  it('rejects residual cookies without active metadata and never resumes a failed login', async () => {
    const original = setup();
    original.resources.initialize.mockRejectedValueOnce(new Error('Disk full'));
    await expect(login(original.owner)).rejects.toThrow('Disk full');
    const restarted = setup(original.storage);
    expect(await restarted.owner.restore(true)).toBe(false);
    expect(restarted.resources.restore).not.toHaveBeenCalled();
    expect(restarted.publish).not.toHaveBeenCalled();
    expect((await restarted.sessionStore.read()).lifecycleState).toBe(
      'signed-out',
    );
  });

  it('restores only the active UUID without deleting its cache', async () => {
    const original = setup();
    const session = await login(original.owner);
    const restored = setup(original.storage);
    expect(await restored.owner.restore(true)).toBe(true);
    expect(restored.owner.currentSession).toEqual(session);
    expect(restored.resources.initialize).not.toHaveBeenCalled();
    expect(restored.resources.delete).not.toHaveBeenCalled();
    expect(restored.resources.restore).toHaveBeenCalledWith(
      session,
      expect.any(AbortSignal),
    );
  });

  it('rejects restoration if durable ownership changes while cache reads are pending', async () => {
    const original = setup();
    const session = await login(original.owner);
    const restored = setup(original.storage);
    restored.resources.restore.mockImplementationOnce(async () => {
      await original.sessionStore.beginCleaning(session.id);
    });
    await expect(restored.owner.restore(true)).rejects.toThrow(
      SessionSupersededError,
    );
    expect(restored.publish).not.toHaveBeenCalled();
  });

  it('cancels restoration waiting on notification drain before logout publishes stale resources', async () => {
    const original = setup();
    await login(original.owner);
    const { sessionStore, resources, invalidate, publish } = setup(
      original.storage,
    );
    const entered = deferred();
    const drained = deferred();
    class DrainingOwner extends BrowserSessionOwner {
      protected override async withRestoration<T>(
        restore: () => Promise<T>,
      ): Promise<T> {
        entered.resolve();
        await drained.promise;
        return restore();
      }
    }
    const owner = new DrainingOwner(
      sessionStore,
      resources,
      invalidate,
      publish,
    );
    const rejected = expect(owner.restore(true)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    await entered.promise;
    const ending = owner.end();
    drained.resolve();
    await rejected;
    await ending;
    expect(resources.restore).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('retains active durable login throughout the decision and restores it after an interrupted dialog', async () => {
    const original = setup();
    const session = await login(original.owner);
    const entered = deferred();
    const answer = deferred();
    const finalize = vi.fn();
    const exiting = original.owner.logoutWithDecision(
      async () => {
        throw { status: 503 };
      },
      async () => {
        entered.resolve();
        await answer.promise;
        throw new Error('Dialog closed');
      },
      finalize,
    );
    const rejected = expect(exiting).rejects.toThrow('Dialog closed');
    await entered.promise;
    expect(await original.sessionStore.read()).toMatchObject({
      lifecycleState: 'active',
      session: { id: session.id },
    });
    expect(finalize).not.toHaveBeenCalled();
    answer.resolve();
    await rejected;
    const restored = setup(original.storage);
    expect(await restored.owner.restore(true)).toBe(true);
    expect(
      await original.owner.logoutWithDecision(vi.fn(), vi.fn(), finalize),
    ).toBe('revoked');
    expect((await original.sessionStore.read()).lifecycleState).toBe(
      'signed-out',
    );
  });

  it('joins logout and retains the authentication lane until revocation and cleanup finish', async () => {
    const { owner } = setup();
    await login(owner);
    const release = deferred();
    const entered = deferred();
    const revoke = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const finalize = vi.fn();
    const exiting = owner.logoutWithDecision(revoke, vi.fn(), finalize);
    expect(owner.logoutWithDecision(revoke, vi.fn(), finalize)).toBe(exiting);
    await entered.promise;
    const ending = owner.end();
    const request = vi.fn(async (signal: AbortSignal) =>
      owner.activate(signal),
    );
    const signingIn = owner.authenticate(request);
    expect(request).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([exiting, ending, signingIn]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('holds fresh login behind all local finalizers, not just cache deletion', async () => {
    const { owner } = setup();
    await login(owner);
    const entered = deferred();
    const released = deferred();
    const ending = owner.end(async () => {
      entered.resolve();
      await released.promise;
    });
    expect(owner.end()).toBe(ending);
    await entered.promise;
    const request = vi.fn(async (signal: AbortSignal) =>
      owner.activate(signal),
    );
    const signingIn = owner.authenticate(request);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    released.resolve();
    await Promise.all([ending, signingIn]);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not publish initialization that finishes after cancellation', async () => {
    const { owner, resources, sessionStore, publish } = setup();
    const entered = deferred();
    const released = deferred();
    resources.initialize.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
    });
    const rejected = expect(login(owner)).rejects.toThrow(
      SessionSupersededError,
    );
    await entered.promise;
    const ending = owner.end();
    released.resolve();
    await Promise.all([rejected, ending]);
    expect(publish).not.toHaveBeenCalled();
    expect((await sessionStore.read()).lifecycleState).toBe('signed-out');
  });

  it('retries failed cleanup without repeating server revocation', async () => {
    const { owner, resources, sessionStore } = setup();
    await login(owner);
    resources.delete.mockRejectedValueOnce(new Error('Disk busy'));
    const revoke = vi.fn();
    const finalize = vi.fn();
    await expect(
      owner.logoutWithDecision(revoke, vi.fn(), finalize),
    ).rejects.toThrow('Disk busy');
    expect((await sessionStore.read()).lifecycleState).toBe('cleaning');
    await owner.logoutWithDecision(revoke, vi.fn(), finalize);
    expect(revoke).toHaveBeenCalledOnce();
    expect((await sessionStore.read()).lifecycleState).toBe('signed-out');
  });

  it('retries revocation only after explicit consent and marks cleaning before local deletion', async () => {
    const { owner, sessionStore } = setup();
    const session = await login(owner);
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(undefined);
    const finalize = vi.fn(async () => {
      expect(await sessionStore.read()).toMatchObject({
        lifecycleState: 'cleaning',
        session: { id: session.id },
      });
    });
    expect(
      await owner.logoutWithDecision(revoke, async () => 'retry', finalize),
    ).toBe('revoked');
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('aborts and settles a timed-out transport before local-only cleanup', async () => {
    vi.useFakeTimers();
    const { owner } = setup();
    await login(owner);
    const entered = deferred();
    let transportSignal!: AbortSignal;
    const exiting = owner.logoutWithDecision(
      (signal) =>
        new Promise<void>((_, reject) => {
          transportSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
          entered.resolve();
        }),
      async (outcome) => {
        expect(outcome).toEqual({ status: 'timedOut' });
        return 'localOnly';
      },
      vi.fn(),
      50,
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(await exiting).toBe('localOnly');
    expect(transportSignal.aborted).toBe(true);
    expect(await login(owner)).not.toBeNull();
  });

  it('rejects a delayed login response after local logout', async () => {
    const { owner, resources } = setup();
    const response = deferred();
    const entered = deferred();
    const signingIn = owner.authenticate(async (signal) => {
      entered.resolve();
      await response.promise;
      await owner.activate(signal);
    });
    const rejected = expect(signingIn).rejects.toThrow(SessionSupersededError);
    await entered.promise;
    await owner.end();
    response.resolve();
    await rejected;
    expect(resources.initialize).not.toHaveBeenCalled();
  });

  it('rejects queued duplicate logins instead of replacing a completed login', async () => {
    const { owner } = setup();
    const first = login(owner);
    const rejected = expect(
      owner.authenticate((signal) => owner.activate(signal)),
    ).rejects.toThrow(SessionSupersededError);
    const session = await first;
    await rejected;
    expect(owner.currentSession).toEqual(session);
  });
});
