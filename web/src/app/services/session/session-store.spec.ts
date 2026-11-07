import { describe, expect, it } from 'vitest';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session-identity';
import {
  parseSessionStore,
  SessionStore,
  type SessionStoreStorage,
} from './session-store';

class MemoryStorage implements SessionStoreStorage {
  value: unknown;
  readFailure = false;
  writeFailure = false;

  async getStrict<T>(): Promise<T | undefined> {
    if (this.readFailure) throw new Error('Read failed');
    return structuredClone(this.value) as T | undefined;
  }

  async set<T>(_scope: 'device', _key: string, value: T): Promise<void> {
    if (this.writeFailure) throw new Error('Write failed');
    this.value = structuredClone(value);
  }
}

function setup() {
  const storage = new MemoryStorage();
  const sessionStore = new SessionStore(storage);
  return { storage, sessionStore };
}

describe('session store', () => {
  it('restores legacy records without inventing server identity', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    storage.value = {
      version: 1,
      phase: 'active',
      session,
      pendingCleanup: [],
    };
    expect((await sessionStore.read())?.identity).toBeNull();
    await sessionStore.bindIdentity(session.id, { userId: 42, serverSessionId: 11 });
    expect((await new SessionStore(storage).read())?.identity).toEqual({
      userId: 42,
      serverSessionId: 11,
    });
  });

  it('binds identity once and rejects old-login handshakes after logout', async () => {
    const { sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    const identity = { userId: 42, serverSessionId: 11 };
    await sessionStore.prepare(session);
    await expect(sessionStore.bindIdentity(session.id, identity)).rejects.toThrow(
      SessionSupersededError,
    );
    await sessionStore.activate(session.id);
    await sessionStore.bindIdentity(session.id, identity);
    await sessionStore.bindIdentity(session.id, identity);
    await expect(
      sessionStore.bindIdentity(session.id, { ...identity, serverSessionId: 12 }),
    ).rejects.toThrow(SessionSupersededError);
    await sessionStore.end(session.id);
    expect((await sessionStore.read())?.identity).toBeNull();
    await expect(sessionStore.bindIdentity(session.id, identity)).rejects.toThrow(
      SessionSupersededError,
    );
  });

  it('rejects malformed server identities without writing', async () => {
    const { sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    await sessionStore.activate(session.id);
    expect(() =>
      sessionStore.bindIdentity(session.id, { userId: 0, serverSessionId: 11 }),
    ).toThrow();
    expect((await sessionStore.read())?.identity).toBeNull();
  });

  it('distinguishes first boot from durable local logout', async () => {
    const { storage, sessionStore } = setup();
    expect(await sessionStore.read()).toBeNull();
    await sessionStore.end(null);
    const restored = await new SessionStore(storage).read();
    expect(restored?.phase).toBe('signed-out');
    expect(restored?.session).toBeNull();
  });

  it('keeps the same identity across preparation retry and process restoration', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    const restarted = new SessionStore(storage);
    expect((await restarted.prepare(session)).session).toEqual(session);
    await restarted.activate(session.id);
    expect((await new SessionStore(storage).read())?.session).toEqual(session);
  });

  it('blocks successor activation until all old stores have been deleted', async () => {
    const { storage, sessionStore } = setup();
    const old = createSessionCacheDescriptor();
    const next = createSessionCacheDescriptor();
    await sessionStore.prepare(old);
    await sessionStore.activate(old.id);
    await sessionStore.end(old.id);
    const restarted = new SessionStore(storage);
    expect((await restarted.read())?.pendingCleanup).toEqual([old]);
    await expect(restarted.prepare(next)).rejects.toThrow('finish cleanup');
    await restarted.completeCleanup(old.id);
    await restarted.prepare(next);
    expect((await restarted.activate(next.id)).session).toEqual(next);
    await expect(restarted.end(old.id)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    await expect(restarted.completeCleanup(old.id)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    expect((await restarted.read())?.session).toEqual(next);
  });

  it('retains every pending cache across partial cleanup and restart', async () => {
    const { storage, sessionStore } = setup();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    storage.value = {
      version: 1,
      phase: 'ending',
      session: null,
      pendingCleanup: [first, second],
    };
    await sessionStore.completeCleanup(first.id);
    const restarted = new SessionStore(storage);
    expect((await restarted.read())?.pendingCleanup).toEqual([second]);
    await expect(
      restarted.prepare(createSessionCacheDescriptor()),
    ).rejects.toThrow('finish cleanup');
    await restarted.completeCleanup(second.id);
    expect((await restarted.read())?.phase).toBe('signed-out');
  });

  it('does not claim durable logout when persisting ending intent fails', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    await sessionStore.activate(session.id);
    storage.writeFailure = true;
    await expect(sessionStore.end(session.id)).rejects.toThrow('Write failed');
    storage.writeFailure = false;
    await sessionStore.end(session.id);
    expect((await sessionStore.read())?.phase).toBe('ending');
  });

  it('records interrupted preparation as cleanup work', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    await new SessionStore(storage).end(session.id);
    expect((await sessionStore.read())?.pendingCleanup).toEqual([session]);
    await expect(sessionStore.activate(session.id)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
  });

  it('fails closed on read errors instead of treating them as first boot', async () => {
    const { storage, sessionStore } = setup();
    storage.readFailure = true;
    await expect(sessionStore.read()).rejects.toThrow('Read failed');
    await expect(
      sessionStore.prepare(createSessionCacheDescriptor()),
    ).rejects.toThrow('Read failed');
    expect(storage.value).toBeUndefined();
  });

  it('retains cleanup work after a failed completion write and permits retry', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    await sessionStore.end(session.id);
    storage.writeFailure = true;
    await expect(sessionStore.completeCleanup(session.id)).rejects.toThrow(
      'Write failed',
    );
    expect((await sessionStore.read())?.pendingCleanup).toEqual([session]);
    storage.writeFailure = false;
    await sessionStore.completeCleanup(session.id);
    expect((await sessionStore.read())?.phase).toBe('signed-out');
  });

  it('never publishes an active record when durable activation fails', async () => {
    const { storage, sessionStore } = setup();
    const session = createSessionCacheDescriptor();
    await sessionStore.prepare(session);
    storage.writeFailure = true;
    await expect(sessionStore.activate(session.id)).rejects.toThrow('Write failed');
    storage.writeFailure = false;
    expect((await sessionStore.read())?.phase).toBe('preparing');
    expect((await sessionStore.activate(session.id)).phase).toBe('active');
  });

  it('serializes competing preparations without poisoning the queue on failure', async () => {
    const { sessionStore } = setup();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    const results = await Promise.allSettled([
      sessionStore.prepare(first),
      sessionStore.prepare(second),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((await sessionStore.activate(first.id)).session).toEqual(first);
  });

  it('rejects inconsistent metadata before using it for cleanup', () => {
    const session = createSessionCacheDescriptor();
    for (const value of [
      null,
      { version: 2 },
      { version: 1, phase: 'unknown', session: null, pendingCleanup: [] },
      { version: 1, phase: 'active', session: null, pendingCleanup: [] },
      { version: 1, phase: 'signed-out', session, pendingCleanup: [] },
      { version: 1, phase: 'active', session, pendingCleanup: [session] },
      {
        version: 1,
        phase: 'ending',
        session: null,
        pendingCleanup: [session, session],
      },
    ]) {
      expect(() => parseSessionStore(value)).toThrow();
    }
  });
});
