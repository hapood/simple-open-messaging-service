import { deleteDB, openDB } from 'idb';
import type { AccountSelfProfile } from '../../../../shared/account-state';
import { SessionLifecycleService } from './session-lifecycle.service';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import type { SessionCacheDescriptor } from './session/session-identity';
import { SessionStore } from './session/session-store';
import {
  LocalCacheUnavailableError,
  LocalCacheVersionMismatchError,
  WebdbStorage,
} from './webdb-storage';

const self: AccountSelfProfile = {
  id: 42,
  account: 'alice',
  namespaceId: 0,
  profileRev: 7,
  isGroup: false,
  isDeleted: false,
};

describe('cached self discovery before user binding', () => {
  let descriptor: SessionCacheDescriptor;
  let lifecycle: SessionLifecycleService;
  let storage: WebdbStorage;
  let writer: WebdbStorage;

  beforeEach(async () => {
    descriptor = await prepareTestSessionCache();
    await deleteDB(descriptor.indexedDbName);
    lifecycle = new SessionLifecycleService();
    storage = new WebdbStorage(() => null, lifecycle);
    storage.bindSessionCache(descriptor);
    writer = new WebdbStorage(() => null);
    writer.bindSessionCache(descriptor);
  });

  afterEach(async () => {
    await storage.close();
    await writer.close();
    storage.dispose();
    writer.dispose();
    await deleteDB(descriptor.indexedDbName);
    await deleteDB(`${descriptor.indexedDbName}-pending-sends`);
    await deleteDB(`${descriptor.indexedDbName}-download-history`);
  });

  async function seed() {
    await writer.openForUser('42');
    await writer.writeSelfProfile(self);
  }

  it('returns null without creating an absent cache or binding a user', async () => {
    expect(await storage.readCachedSelfProfile()).toBeNull();
    expect(storage.numericUserId).toBeNull();
    expect(storage.ready()).toBe(false);
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(
      descriptor.indexedDbName,
    );
  });

  it('does not recreate a cache deleted between enumeration and self discovery', async () => {
    await seed();
    await writer.close();
    const databases = indexedDB.databases.bind(indexedDB);
    const enumerate = vi
      .spyOn(indexedDB, 'databases')
      .mockImplementationOnce(async () => {
        const names = await databases();
        await deleteDB(descriptor.indexedDbName);
        return names;
      });
    try {
      await expect(storage.readCachedSelfProfile()).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect((await databases()).map((db) => db.name)).not.toContain(
        descriptor.indexedDbName,
      );
      expect(storage.numericUserId).toBeNull();
      expect(storage.ready()).toBe(false);
    } finally {
      enumerate.mockRestore();
    }
  });

  it('requires a bound browser descriptor', async () => {
    const unbound = new WebdbStorage();
    await expect(unbound.readCachedSelfProfile()).rejects.toThrow(
      'no login-session cache is bound',
    );
    unbound.dispose();
  });

  it('returns null for initialized state without self facts', async () => {
    await writer.openForUser('42');
    expect(await storage.readCachedSelfProfile()).toBeNull();
    expect(storage.numericUserId).toBeNull();
  });

  it('reads coherent self facts without publishing a handle or consuming user binding', async () => {
    await seed();
    expect(await storage.readCachedSelfProfile()).toEqual(self);
    expect(storage.numericUserId).toBeNull();
    expect(storage.ready()).toBe(false);
    await storage.openExistingForUser('42');
    expect(storage.numericUserId).toBe(42);
    expect((await storage.readAccountState()).selfProfile).toEqual(self);
  });

  it('restores after a closed predecessor without reopening ordinary account admission', async () => {
    await seed();
    await storage.openExistingForUser('42');
    await storage.close();
    storage.bindSessionCache(descriptor);
    expect(await storage.readCachedSelfProfile()).toEqual(self);
    expect(storage.numericUserId).toBeNull();
    expect(storage.ready()).toBe(false);
    await expect(storage.readAccountState()).rejects.toThrow(
      'account cache lifetime expired',
    );
    await storage.openExistingForUser('42');
    expect((await storage.readAccountState()).selfProfile).toEqual(self);
  });

  it('admits discovery after session initialization without binding a user', async () => {
    await storage.initializeSessionCache();
    expect(await storage.readCachedSelfProfile()).toBeNull();
    expect(storage.numericUserId).toBeNull();
    expect(storage.ready()).toBe(false);
    await expect(storage.readAccountState()).rejects.toThrow(
      'account cache lifetime expired',
    );
  });

  it('forces corrupt cache recovery before binding and removes ancillary caches', async () => {
    await seed();
    const db = await writer.db();
    const state = (await db.get('accountState', 'account'))!;
    await db.put(
      'accountState',
      { ...state, selfProfile: { ...self, id: 0 } },
      'account',
    );
    await writer.close();
    const ancillaryNames = ['pending-sends', 'download-history'].map(
      (suffix) => `${descriptor.indexedDbName}-${suffix}`,
    );
    for (const name of ancillaryNames) {
      const cache = await openDB(name, 1, {
        upgrade(db) {
          db.createObjectStore('probe');
        },
      });
      await cache.put('probe', 'private cached data', 'probe');
      cache.close();
    }
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'invalid cached self owner',
    );
    await storage.close();
    await storage.recreateSessionCache();
    expect(storage.numericUserId).toBeNull();
    expect(storage.ready()).toBe(false);
    expect(await storage.readCachedSelfProfile()).toBeNull();
    const names = (await indexedDB.databases()).map((db) => db.name);
    expect(names).toContain(descriptor.indexedDbName);
    for (const name of ancillaryNames) expect(names).not.toContain(name);
    await storage.openExistingForUser('42');
    expect((await storage.readAccountState()).selfProfile).toBeNull();
    expect((await storage.readAccountState()).selfIdentity).toBeNull();
  });

  it('fences discovery against concurrent close and admits a later restoration', async () => {
    await seed();
    const original = SessionStore.prototype.read;
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi
      .spyOn(SessionStore.prototype, 'read')
      .mockImplementationOnce(async function (this: SessionStore) {
        entered();
        await gate;
        return original.call(this);
      });
    const pending = storage.readCachedSelfProfile();
    const rejected = expect(pending).rejects.toThrow(
      'account cache lifetime expired',
    );
    await reading;
    const closing = storage.close();
    try {
      await expect(storage.readCachedSelfProfile()).rejects.toThrow(
        'account cache lifetime expired',
      );
      release();
      await rejected;
      await closing;
    } finally {
      release();
      read.mockRestore();
      await closing;
    }
    expect(await storage.readCachedSelfProfile()).toEqual(self);
    expect(storage.numericUserId).toBeNull();
  });

  it('rejects malformed cached owners and conflicting self identities', async () => {
    await seed();
    const db = await writer.db();
    const state = (await db.get('accountState', 'account'))!;
    await db.put(
      'accountState',
      {
        ...state,
        selfProfile: { ...self, id: 0 },
      },
      'account',
    );
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'invalid cached self owner',
    );
    await db.put(
      'accountState',
      {
        ...state,
        selfIdentity: { account: 'someone-else' },
      },
      'account',
    );
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'cached self identity mismatch',
    );
  });

  it.each(['missing-state', 'invalid-target', 'physical-version'] as const)(
    'rejects %s during discovery and strict restore without changing cached data',
    async (corruption) => {
      await seed();
      const db = await writer.db();
      const state = (await db.get('accountState', 'account'))!;
      if (corruption === 'missing-state')
        await db.delete('accountState', 'account');
      if (corruption === 'invalid-target')
        await db.put(
          'accountState',
          { ...state, stateFeedTarget: -1 },
          'account',
        );
      await writer.close();
      const damaged = await openDB(
        descriptor.indexedDbName,
        corruption === 'physical-version' ? 3 : 2,
      );
      const before = await damaged.get('accountState', 'account');
      damaged.close();
      const expectedError =
        corruption === 'physical-version'
          ? LocalCacheVersionMismatchError
          : LocalCacheUnavailableError;

      await expect(storage.readCachedSelfProfile()).rejects.toThrowError(
        expectedError,
      );
      expect(storage.numericUserId).toBeNull();
      await expect(storage.openExistingForUser('42')).rejects.toThrowError(
        expectedError,
      );
      expect(storage.ready()).toBe(false);
      const unchanged = await openDB(descriptor.indexedDbName);
      try {
        expect(unchanged.version).toBe(
          corruption === 'physical-version' ? 3 : 2,
        );
        expect(await unchanged.get('accountState', 'account')).toEqual(before);
      } finally {
        unchanged.close();
      }
    },
  );

  it('rejects unreadable account state without deleting it', async () => {
    await seed();
    const original = IDBObjectStore.prototype.get;
    const get = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'accountState')
          throw new Error('account state read failed');
        return original.apply(this, args);
      });
    try {
      await expect(storage.readCachedSelfProfile()).rejects.toThrowError(
        LocalCacheUnavailableError,
      );
      await expect(storage.openExistingForUser('42')).rejects.toThrowError(
        LocalCacheUnavailableError,
      );
      expect(storage.ready()).toBe(false);
    } finally {
      get.mockRestore();
    }
    expect(await storage.readCachedSelfProfile()).toEqual(self);
  });

  it('rejects an expired durable session even while its cache still exists', async () => {
    await seed();
    await new SessionStore().beginCleaning(descriptor.id);
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'cached self session expired',
    );
    expect(storage.numericUserId).toBeNull();
  });

  it('rejects a closed predecessor descriptor after a successor takes the fixed cache name', async () => {
    await seed();
    await storage.close();
    const successor = await prepareTestSessionCache();
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'cached self session expired',
    );
    storage.bindSessionCache(successor);
    // The owner deletes predecessor data before a new login initializes this fixed name.
    await writer.close();
    await storage.recreateSessionCache();
    expect(await storage.readCachedSelfProfile()).toBeNull();
    expect(storage.numericUserId).toBeNull();
  });

  it('rechecks the durable session after reading cached self facts', async () => {
    await seed();
    const original = SessionStore.prototype.read;
    let reads = 0;
    const read = vi
      .spyOn(SessionStore.prototype, 'read')
      .mockImplementation(async function (this: SessionStore) {
        if (++reads === 2) await this.beginCleaning(descriptor.id);
        return original.call(this);
      });
    try {
      await expect(storage.readCachedSelfProfile()).rejects.toThrow(
        'cached self session expired',
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(storage.numericUserId).toBeNull();
    } finally {
      read.mockRestore();
    }
  });

  it('rejects a session invalidated while the cache read is in flight', async () => {
    await seed();
    const original = IDBObjectStore.prototype.get;
    const get = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = original.apply(this, args);
        if (this.name === 'accountState') lifecycle.invalidateSession();
        return request;
      });
    try {
      await expect(storage.readCachedSelfProfile()).rejects.toThrow(
        'account cache lifetime expired',
      );
      expect(storage.numericUserId).toBeNull();
    } finally {
      get.mockRestore();
    }
  });
});

describe('native cached self discovery', () => {
  it('uses the owner-discovery IPC without a fabricated account or browser descriptor', async () => {
    const invoke = vi.fn().mockResolvedValue(self);
    const storage = new WebdbStorage();
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    try {
      expect(await storage.readCachedSelfProfile()).toEqual(self);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        'native_db_read_cached_self_profile',
        {},
      );
      expect(storage.numericUserId).toBeNull();
      invoke.mockRejectedValueOnce(new Error('native login superseded'));
      await expect(storage.readCachedSelfProfile()).rejects.toThrow(
        'native login superseded',
      );
    } finally {
      storage.dispose();
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
    }
  });
});
