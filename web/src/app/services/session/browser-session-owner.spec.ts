import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionOwner,
  type BrowserSessionResources,
} from './browser-session-owner';
import { SessionJournal, type SessionJournalStorage } from './session-journal';
import { SessionSupersededError } from './session-identity';

class MemoryStorage implements SessionJournalStorage {
  value: unknown;
  failWrites = false;
  async getStrict<T>(): Promise<T | undefined> {
    return structuredClone(this.value) as T | undefined;
  }
  async set<T>(_scope: 'device', _key: string, value: T): Promise<void> {
    if (this.failWrites) throw new Error('Metadata unavailable');
    this.value = structuredClone(value);
  }
}

function setup(storage = new MemoryStorage()) {
  const resources = {
    close: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    prepareFreshCache: vi.fn(async () => {}),
    resetState: vi.fn(),
  } satisfies BrowserSessionResources;
  const journal = new SessionJournal(storage);
  const invalidate = vi.fn();
  const publish = vi.fn();
  const owner = new BrowserSessionOwner(
    journal,
    resources,
    invalidate,
    publish,
  );
  return { owner, journal, resources, invalidate, publish, storage };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function login(owner: BrowserSessionOwner) {
  await owner.authenticate(async (signal) => {
    await owner.activate(signal);
  });
  return owner.currentSession!;
}

afterEach(() => vi.useRealTimers());

describe('browser session owner', () => {
  it('invalidates and resets once per boundary, releasing but not deleting on logout', async () => {
    const { owner, resources, invalidate, journal } = setup();
    const session = await login(owner);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(resources.resetState).toHaveBeenCalledTimes(1);
    expect(resources.close).toHaveBeenCalledTimes(1);
    expect(resources.initialize).toHaveBeenCalledExactlyOnceWith(session);
    resources.prepareFreshCache.mockClear();

    await owner.end();
    expect(owner.currentSession).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(resources.resetState).toHaveBeenCalledTimes(2);
    expect(resources.close).toHaveBeenCalledTimes(2);
    expect(resources.delete).not.toHaveBeenCalled();
    expect(resources.prepareFreshCache).not.toHaveBeenCalled();
    expect((await journal.read())?.pendingCleanup).toEqual([session]);
  });

  it('deletes the previous cache exactly once before issuing fresh authentication', async () => {
    const { owner, resources } = setup();
    const previous = await login(owner);
    await owner.end();
    const request = vi.fn(async (signal: AbortSignal) => {
      expect(resources.delete).toHaveBeenCalledExactlyOnceWith(previous);
      await owner.activate(signal);
    });
    await owner.authenticate(request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(owner.currentSession?.id).not.toBe(previous.id);
  });

  it('blocks authentication on failed deletion and retries only at the next login', async () => {
    const { owner, resources, journal } = setup();
    const session = await login(owner);
    await owner.end();
    resources.delete.mockRejectedValueOnce(new Error('Database blocked'));
    const request = vi.fn(async () => {});
    await expect(owner.authenticate(request)).rejects.toThrow(
      'Database blocked',
    );
    expect(request).not.toHaveBeenCalled();
    expect((await journal.read())?.pendingCleanup).toEqual([session]);
    const successor = await login(owner);
    expect(successor.id).not.toBe(session.id);
  });

  it('closes resources even when the durable logout marker cannot be saved', async () => {
    const { owner, storage, resources } = setup();
    await login(owner);
    resources.close.mockClear();
    storage.failWrites = true;
    const ending = owner.end();
    expect(owner.currentSession).toBeNull();
    await expect(ending).rejects.toThrow('Metadata unavailable');
    expect(resources.close).toHaveBeenCalledTimes(1);
    expect(resources.delete).not.toHaveBeenCalled();
  });

  it('rejects a residual credential without a journal and permits only explicit fresh login', async () => {
    const { owner, journal, resources, publish, storage } = setup();
    expect(await owner.restore(true)).toBe(false);
    expect(owner.currentSession).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(resources.close).toHaveBeenCalledOnce();
    expect(resources.initialize).not.toHaveBeenCalled();
    expect(resources.restore).not.toHaveBeenCalled();
    expect(resources.delete).not.toHaveBeenCalled();
    expect(resources.prepareFreshCache).not.toHaveBeenCalled();
    expect(await journal.read()).toMatchObject({
      phase: 'signed-out',
      session: null,
      pendingCleanup: [],
    });
    const restarted = setup(storage);
    expect(await restarted.owner.restore(true)).toBe(false);
    const session = await login(restarted.owner);
    expect(restarted.publish).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('fails closed when recording an unowned residual credential fails', async () => {
    const { owner, storage, resources, publish } = setup();
    storage.failWrites = true;
    await expect(owner.restore(true)).rejects.toThrow('Metadata unavailable');
    expect(owner.currentSession).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(resources.close).toHaveBeenCalledOnce();
    expect(resources.initialize).not.toHaveBeenCalled();
    expect(resources.restore).not.toHaveBeenCalled();
  });

  it('restores the same UUID without initializing or deleting its cache', async () => {
    const original = setup();
    const session = await login(original.owner);
    const restored = setup(original.storage);
    expect(await restored.owner.restore(true)).toBe(true);
    expect(restored.owner.currentSession).toEqual(session);
    expect(restored.resources.initialize).not.toHaveBeenCalled();
    expect(restored.resources.delete).not.toHaveBeenCalled();
    expect(restored.resources.prepareFreshCache).not.toHaveBeenCalled();
    expect(restored.resources.restore).toHaveBeenCalledWith(
      session,
      expect.any(AbortSignal),
    );
  });

  it('does not resurrect or physically delete an ended cache on restart', async () => {
    const original = setup();
    const session = await login(original.owner);
    await original.owner.end();
    const restored = setup(original.storage);
    expect(await restored.owner.restore(true)).toBe(false);
    expect(restored.owner.currentSession).toBeNull();
    expect(restored.resources.restore).not.toHaveBeenCalled();
    expect(restored.resources.delete).not.toHaveBeenCalled();
    expect(restored.resources.prepareFreshCache).not.toHaveBeenCalled();
    expect((await restored.journal.read())?.pendingCleanup).toEqual([session]);
  });

  it('permits new login after failed remote revocation without replaying that request', async () => {
    const { owner } = setup();
    const previous = await login(owner);
    const revoke = vi.fn(async () => {
      throw new Error('Offline');
    });
    await expect(owner.logout(revoke)).resolves.toBeUndefined();
    const successor = await login(owner);
    expect(successor.id).not.toBe(previous.id);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('waits for an already-dispatched logout response before sending new login', async () => {
    const { owner } = setup();
    await login(owner);
    const release = deferred();
    const dispatched = deferred();
    const logout = owner.logout(async () => {
      dispatched.resolve();
      await release.promise;
    });
    await dispatched.promise;
    const request = vi.fn(async (signal: AbortSignal) =>
      owner.activate(signal),
    );
    const signingIn = owner.authenticate(request);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    release.resolve();
    await logout;
    await signingIn;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('aborts the logout transport on timeout and then allows fresh authentication', async () => {
    vi.useFakeTimers();
    const { owner } = setup();
    await login(owner);
    const dispatched = deferred();
    let transportSignal!: AbortSignal;
    const exiting = owner.logout(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          transportSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
          dispatched.resolve();
        }),
      50,
    );
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(50);
    await exiting;
    expect(transportSignal.aborted).toBe(true);
    expect(await login(owner)).not.toBeNull();
  });

  it('does not dispatch a queued logout after its deadline has expired', async () => {
    vi.useFakeTimers();
    const { owner } = setup();
    const response = deferred();
    const dispatched = deferred();
    const signingIn = owner.authenticate(async (signal) => {
      dispatched.resolve();
      await response.promise;
      await owner.activate(signal);
    });
    const rejected = expect(signingIn).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    await dispatched.promise;
    const revoke = vi.fn(async () => {});
    const exiting = owner.logout(revoke, 50);
    await vi.advanceTimersByTimeAsync(50);
    await exiting;
    response.resolve();
    await rejected;
    await login(owner);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('rejects an authentication response that arrives after local logout', async () => {
    const { owner, resources } = setup();
    const response = deferred();
    const dispatched = deferred();
    const signingIn = owner.authenticate(async (signal) => {
      dispatched.resolve();
      await response.promise;
      await owner.activate(signal);
    });
    const rejected = expect(signingIn).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    await dispatched.promise;
    await owner.end();
    response.resolve();
    await rejected;
    expect(resources.initialize).not.toHaveBeenCalled();
    expect(owner.currentSession).toBeNull();
  });

  it('rejects queued duplicate submissions instead of replacing a successful login', async () => {
    const { owner } = setup();
    const first = login(owner);
    const duplicate = owner.authenticate(async (signal) =>
      owner.activate(signal),
    );
    const rejected = expect(duplicate).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    const session = await first;
    await rejected;
    expect(owner.currentSession).toEqual(session);
  });

  it('resumes interrupted cache preparation without another server login', async () => {
    const original = setup();
    original.resources.initialize.mockRejectedValueOnce(new Error('Disk full'));
    await expect(login(original.owner)).rejects.toThrow('Disk full');
    const saved = await original.journal.read();
    expect(saved?.phase).toBe('preparing');
    const restored = setup(original.storage);
    expect(await restored.owner.restore(true)).toBe(true);
    expect(restored.owner.currentSession).toEqual(saved?.session);
    expect(restored.resources.initialize).toHaveBeenCalledExactlyOnceWith(
      saved?.session,
    );
  });
});
