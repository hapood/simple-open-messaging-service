import { describe, expect, it } from 'vitest';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session-identity';
import {
  parseSessionJournal,
  SessionJournal,
  type SessionJournalStorage,
} from './session-journal';

class MemoryStorage implements SessionJournalStorage {
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
  const journal = new SessionJournal(storage);
  return { storage, journal };
}

describe('session journal', () => {
  it('distinguishes first boot from durable local logout', async () => {
    const { storage, journal } = setup();
    expect(await journal.read()).toBeNull();
    await journal.end(null);
    const restored = await new SessionJournal(storage).read();
    expect(restored?.phase).toBe('signed-out');
    expect(restored?.session).toBeNull();
  });

  it('keeps the same identity across preparation retry and process restoration', async () => {
    const { storage, journal } = setup();
    const session = createSessionCacheDescriptor();
    await journal.prepare(session);
    const restarted = new SessionJournal(storage);
    expect((await restarted.prepare(session)).session).toEqual(session);
    await restarted.activate(session.id);
    expect((await new SessionJournal(storage).read())?.session).toEqual(
      session,
    );
  });

  it('blocks successor activation until all old stores have been deleted', async () => {
    const { storage, journal } = setup();
    const old = createSessionCacheDescriptor();
    const next = createSessionCacheDescriptor();
    await journal.prepare(old);
    await journal.activate(old.id);
    await journal.end(old.id);
    const restarted = new SessionJournal(storage);
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
    const { storage, journal } = setup();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    storage.value = {
      version: 1,
      phase: 'ending',
      session: null,
      pendingCleanup: [first, second],
    };
    await journal.completeCleanup(first.id);
    const restarted = new SessionJournal(storage);
    expect((await restarted.read())?.pendingCleanup).toEqual([second]);
    await expect(
      restarted.prepare(createSessionCacheDescriptor()),
    ).rejects.toThrow('finish cleanup');
    await restarted.completeCleanup(second.id);
    expect((await restarted.read())?.phase).toBe('signed-out');
  });

  it('does not claim durable logout when persisting ending intent fails', async () => {
    const { storage, journal } = setup();
    const session = createSessionCacheDescriptor();
    await journal.prepare(session);
    await journal.activate(session.id);
    storage.writeFailure = true;
    await expect(journal.end(session.id)).rejects.toThrow('Write failed');
    storage.writeFailure = false;
    await journal.end(session.id);
    expect((await journal.read())?.phase).toBe('ending');
  });

  it('records interrupted preparation as cleanup work', async () => {
    const { storage, journal } = setup();
    const session = createSessionCacheDescriptor();
    await journal.prepare(session);
    await new SessionJournal(storage).end(session.id);
    expect((await journal.read())?.pendingCleanup).toEqual([session]);
    await expect(journal.activate(session.id)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
  });

  it('fails closed on read errors instead of treating them as first boot', async () => {
    const { storage, journal } = setup();
    storage.readFailure = true;
    await expect(journal.read()).rejects.toThrow('Read failed');
    await expect(
      journal.prepare(createSessionCacheDescriptor()),
    ).rejects.toThrow('Read failed');
    expect(storage.value).toBeUndefined();
  });

  it('retains cleanup work after a failed completion write and permits retry', async () => {
    const { storage, journal } = setup();
    const session = createSessionCacheDescriptor();
    await journal.prepare(session);
    await journal.end(session.id);
    storage.writeFailure = true;
    await expect(journal.completeCleanup(session.id)).rejects.toThrow(
      'Write failed',
    );
    expect((await journal.read())?.pendingCleanup).toEqual([session]);
    storage.writeFailure = false;
    await journal.completeCleanup(session.id);
    expect((await journal.read())?.phase).toBe('signed-out');
  });

  it('never publishes an active record when durable activation fails', async () => {
    const { storage, journal } = setup();
    const session = createSessionCacheDescriptor();
    await journal.prepare(session);
    storage.writeFailure = true;
    await expect(journal.activate(session.id)).rejects.toThrow('Write failed');
    storage.writeFailure = false;
    expect((await journal.read())?.phase).toBe('preparing');
    expect((await journal.activate(session.id)).phase).toBe('active');
  });

  it('serializes competing preparations without poisoning the queue on failure', async () => {
    const { journal } = setup();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    const results = await Promise.allSettled([
      journal.prepare(first),
      journal.prepare(second),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((await journal.activate(first.id)).session).toEqual(first);
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
      expect(() => parseSessionJournal(value)).toThrow();
    }
  });
});
