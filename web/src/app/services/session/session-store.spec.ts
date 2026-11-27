import { describe, expect, it } from 'vitest';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session-identity';
import { parseSessionState, SessionStore } from './session-store';
import {
  MemorySessionStorage,
  resetTestAppState,
} from './session-store.test-helper';
import { AppStateStorage, PreferenceStorage } from '../preference-storage';

async function setup() {
  const storage = new MemorySessionStorage();
  const store = new SessionStore(storage);
  await store.initialize();
  await store.configure({ primary: 'https://chat.test' });
  return { storage, store };
}

describe('app-state session lifecycle', () => {
  it('initializes the current format as unconfigured and requires server setup', async () => {
    const storage = new MemorySessionStorage();
    const store = new SessionStore(storage);
    expect((await store.initialize()).lifecycleState).toBe('unconfigured');
    expect(storage.state.get('schemaVersion')).toBe(1);
    await expect(
      store.activate(createSessionCacheDescriptor().id),
    ).rejects.toThrow(SessionSupersededError);
    await store.configure({ primary: 'https://chat.test' });
    expect((await store.read()).lifecycleState).toBe('signed-out');
  });

  it.each([undefined, 0, 2, '1'])(
    'rejects schema version %s without resetting state',
    async (version) => {
      const storage = new MemorySessionStorage();
      if (version === undefined) storage.state.delete('schemaVersion');
      else storage.state.set('schemaVersion', version);
      storage.state.set('sessionUuid', createSessionCacheDescriptor().id);
      storage.state.set('serverConfig', { primary: 'https://chat.test' });
      storage.state.set('pushDeviceId', 'retain');
      const before = structuredClone(storage.state);
      await expect(new SessionStore(storage).initialize()).rejects.toMatchObject({
        name: 'DatabaseRestorationError',
        cause: expect.objectContaining({ message: 'Invalid app-state version' }),
      });
      expect(storage.state).toEqual(before);
    },
  );

  it('binds notification identity once and rejects stale or conflicting HELLOs', async () => {
    const { store } = await setup();
    const { id } = createSessionCacheDescriptor();
    const identity = { userId: 42, serverSessionId: 11 };
    await expect(store.bindIdentity(id, identity)).rejects.toThrow(
      SessionSupersededError,
    );
    await store.activate(id);
    await store.bindIdentity(id, identity);
    await store.bindIdentity(id, identity);
    await expect(
      store.bindIdentity(id, { ...identity, serverSessionId: 12 }),
    ).rejects.toThrow(SessionSupersededError);
    expect(() =>
      store.bindIdentity(id, { userId: 0, serverSessionId: 1 }),
    ).toThrow();
    await store.beginCleaning(id);
    expect((await store.read()).identity).toBeNull();
    await expect(store.bindIdentity(id, identity)).rejects.toThrow(
      SessionSupersededError,
    );
  });

  it('retains UUID during cleanup and preserves installation state but not account state', async () => {
    const { store, storage } = await setup();
    storage.state.set('pushDeviceId', 'installation');
    storage.state.set('forwardRecentThreads', [1]);
    storage.state.set('cacheRebuild', 'pending');
    const { id } = createSessionCacheDescriptor();
    await store.activate(id);
    await store.beginCleaning(id);
    const restarted = new SessionStore(storage);
    expect(await restarted.read()).toMatchObject({
      lifecycleState: 'cleaning',
      session: { id },
    });
    await expect(
      restarted.activate(createSessionCacheDescriptor().id),
    ).rejects.toThrow();
    await restarted.finishCleaning(id);
    expect(await restarted.read()).toMatchObject({
      lifecycleState: 'signed-out',
      session: null,
    });
    expect(storage.state.get('pushDeviceId')).toBe('installation');
    expect(storage.state.get('serverConfig')).toEqual({
      primary: 'https://chat.test',
    });
    expect(storage.state.has('forwardRecentThreads')).toBe(false);
    expect(storage.state.has('cacheRebuild')).toBe(false);
    const next = createSessionCacheDescriptor();
    await store.activate(next.id);
    await expect(store.beginCleaning(id)).rejects.toThrow(
      SessionSupersededError,
    );
    await expect(store.finishCleaning(id)).rejects.toThrow(
      SessionSupersededError,
    );
    await expect(store.configure({})).rejects.toThrow(SessionSupersededError);
  });

  it('never publishes failed activation and retains cleaning after failed completion', async () => {
    const { store, storage } = await setup();
    const { id } = createSessionCacheDescriptor();
    storage.failWrites = true;
    await expect(store.activate(id)).rejects.toThrow('Metadata unavailable');
    expect((await store.read()).lifecycleState).toBe('signed-out');
    storage.failWrites = false;
    await store.activate(id);
    await store.beginCleaning(id);
    storage.failWrites = true;
    await expect(store.finishCleaning(id)).rejects.toThrow(
      'Metadata unavailable',
    );
    expect((await store.read()).lifecycleState).toBe('cleaning');
    storage.failWrites = false;
    await store.finishCleaning(id);
  });

  it('fails closed on reads and inconsistent lifecycle records', async () => {
    const { store, storage } = await setup();
    storage.failReads = true;
    await expect(store.read()).rejects.toThrow('Read failed');
    await expect(
      store.activate(createSessionCacheDescriptor().id),
    ).rejects.toThrow('Read failed');
    for (const state of [
      'preparing',
      'revoking',
      'ending',
      'active',
      'unknown',
    ]) {
      expect(() =>
        parseSessionState(
          new Map<string, unknown>([
            ['schemaVersion', 1],
            ['lifecycleState', state],
          ]),
        ),
      ).toThrow();
    }
  });

  it('atomically admits only one competing activation across store instances', async () => {
    const { store, storage } = await setup();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    const results = await Promise.allSettled([
      store.activate(first.id),
      new SessionStore(storage).activate(second.id),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((await store.read()).session?.id).toBe(first.id);
  });

  it('rolls back a failed real IDB transaction and reads a coherent lifecycle snapshot', async () => {
    const appState = new AppStateStorage();
    await resetTestAppState(appState);
    try {
      const store = new SessionStore(appState);
      await store.initialize();
      await store.configure({ primary: 'https://chat.test' });
      const { id } = createSessionCacheDescriptor();
      await store.activate(id);
      await expect(
        appState.update((state) => {
          state.set('lifecycleState', 'cleaning');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await store.read()).toMatchObject({
        lifecycleState: 'active',
        session: { id },
      });
    } finally {
      try {
        await resetTestAppState(appState);
      } finally {
        await new PreferenceStorage().close();
      }
    }
  });
});
