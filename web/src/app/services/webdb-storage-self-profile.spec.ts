import { deleteDB, openDB } from 'idb';
import type { AccountSelfProfile } from '../../../../shared/account-state';
import type { ProfileDemand } from '../../../../shared/profile-demand';
import { SessionLifecycleService } from './session-lifecycle.service';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import type { SessionCacheDescriptor } from './session/session-identity';
import { SessionStore } from './session/session-store';
import {
  LocalCacheCorruptionError,
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

const demand: ProfileDemand = {
  publisherNamespaceId: 0,
  lookup: 'ACCOUNT_PROFILE',
  target: {
    profileNamespaceId: 0,
    account: self.account,
    rev: self.profileRev,
  },
};

/** The rejection of an operation that is required to fail. */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to reject');
}

describe('cached self discovery before user binding', () => {
  let descriptor: SessionCacheDescriptor;
  let lifecycle: SessionLifecycleService;
  let storage: WebdbStorage;
  let writer: WebdbStorage;

  /** Make the versionless open of the seeded cache fail like a backend that cannot read it.
   *  The real request genuinely fails, because opening version 2 at version 1 is refused, so no
   *  connection leaks; the request then reports `reported` instead of its own error. */
  function failCacheOpen(reported?: DOMException) {
    const original = IDBFactory.prototype.open;
    return vi.spyOn(IDBFactory.prototype, 'open').mockImplementation(function (
      this: IDBFactory,
      name,
      version,
    ) {
      if (name !== descriptor.indexedDbName || version !== undefined)
        return original.call(this, name, version);
      const request = original.call(this, name, 1);
      if (reported)
        Object.defineProperty(request, 'error', {
          get: () => reported,
          configurable: true,
        });
      return request;
    });
  }

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
      // The refusal is an absence, not damage: discovery keeps the browser's own error.
      const error = await rejection(() => storage.readCachedSelfProfile());
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(LocalCacheCorruptionError);
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
          : LocalCacheCorruptionError;

      for (const restore of [
        () => storage.readCachedSelfProfile(),
        () => storage.openExistingForUser('42'),
      ]) {
        const error = await rejection(restore);
        expect(error).toBeInstanceOf(expectedError);
        // Structural damage is the one failure that may authorize recovery.
        expect(error).toBeInstanceOf(LocalCacheCorruptionError);
      }
      expect(storage.numericUserId).toBeNull();
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
      for (const restore of [
        () => storage.readCachedSelfProfile(),
        () => storage.openExistingForUser('42'),
      ]) {
        const error = await rejection(restore);
        expect(error).toMatchObject({
          name: 'LocalCacheCorruptionError',
          message: `invalid local cache: ${descriptor.indexedDbName}`,
        });
        // A cache that fails validation is still reported as unavailable.
        expect(error).toBeInstanceOf(LocalCacheUnavailableError);
      }
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

  describe('local cache corruption classification', () => {
    const restorePaths = (): Array<() => Promise<unknown>> => [
      () => storage.readCachedSelfProfile(),
      () => storage.openExistingForUser('42'),
    ];

    /** Rejects with `message` and never claims the cache is corrupt. */
    async function plain(run: () => Promise<unknown>, message: string) {
      const error = await rejection(run);
      expect(error).toMatchObject({ message });
      expect(error).not.toBeInstanceOf(LocalCacheCorruptionError);
    }

    it('is one class covering version, schema and readability failures', () => {
      const mismatch = new LocalCacheVersionMismatchError('cache');
      const unreadable = new LocalCacheCorruptionError(
        'unreadable local cache: cache',
      );
      const absent = new LocalCacheUnavailableError(
        'missing local cache: cache',
      );
      for (const error of [mismatch, unreadable]) {
        expect(error).toBeInstanceOf(LocalCacheCorruptionError);
        expect(error).toBeInstanceOf(LocalCacheUnavailableError);
      }
      expect(absent).not.toBeInstanceOf(LocalCacheCorruptionError);
      expect(mismatch).toMatchObject({
        name: 'LocalCacheVersionMismatchError',
        message: 'local cache schema version mismatch: cache',
      });
      expect(unreadable.name).toBe('LocalCacheCorruptionError');
    });

    it('reports an absent cache as unavailable, never as corrupt', async () => {
      await plain(
        () => storage.openExistingForUser('42'),
        `missing local cache: ${descriptor.indexedDbName}`,
      );
      expect(storage.ready()).toBe(false);
    });

    it('reports unsupported enumeration as unavailable, never as corrupt', async () => {
      await seed();
      await writer.close();
      Object.defineProperty(indexedDB, 'databases', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      try {
        for (const restore of restorePaths())
          await plain(restore, 'IndexedDB database enumeration is unavailable');
      } finally {
        Reflect.deleteProperty(indexedDB, 'databases');
      }
      expect(await storage.readCachedSelfProfile()).toEqual(self);
    });

    it('reports a cache that vanished before a strict open as unavailable', async () => {
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
        const error = await rejection(() => storage.openExistingForUser('42'));
        expect(error).toMatchObject({
          name: 'LocalCacheUnavailableError',
          message: `unreadable local cache: ${descriptor.indexedDbName}`,
        });
        expect(error).not.toBeInstanceOf(LocalCacheCorruptionError);
        expect((await databases()).map((db) => db.name)).not.toContain(
          descriptor.indexedDbName,
        );
        expect(storage.ready()).toBe(false);
      } finally {
        enumerate.mockRestore();
      }
    });

    it('declares a backend that cannot read an existing cache corrupt on both paths', async () => {
      await seed();
      await writer.close();
      const backend = new DOMException(
        'Internal error opening backing store',
        'UnknownError',
      );
      const open = failCacheOpen(backend);
      try {
        for (const restore of restorePaths()) {
          const error = await rejection(restore);
          expect(error).toMatchObject({
            name: 'LocalCacheCorruptionError',
            message: `unreadable local cache: ${descriptor.indexedDbName}`,
            cause: backend,
          });
          // A cache the backend cannot read is still reported as unavailable.
          expect(error).toBeInstanceOf(LocalCacheUnavailableError);
        }
        expect(storage.ready()).toBe(false);
      } finally {
        open.mockRestore();
      }
      // Nothing was deleted: the same cache reads again once the backend recovers.
      expect(await storage.readCachedSelfProfile()).toEqual(self);
    });

    it('keeps the backend failure itself as the cause', async () => {
      await seed();
      await writer.close();
      const open = failCacheOpen();
      try {
        const error = await rejection(() => storage.openExistingForUser('42'));
        expect(error).toBeInstanceOf(LocalCacheCorruptionError);
        expect(error).toMatchObject({ cause: { name: 'VersionError' } });
      } finally {
        open.mockRestore();
      }
    });

    it.each(['SecurityError', 'NotAllowedError', 'NotFoundError'])(
      'does not declare corruption when the open is refused with %s',
      async (name) => {
        await seed();
        await writer.close();
        const refused = new DOMException('The open was refused', name);
        const open = failCacheOpen(refused);
        try {
          // Discovery never wrapped these: the browser's error is the only report.
          expect(await rejection(() => storage.readCachedSelfProfile())).toBe(
            refused,
          );
          const error = await rejection(() =>
            storage.openExistingForUser('42'),
          );
          expect(error).toMatchObject({
            name: 'LocalCacheUnavailableError',
            message: `unreadable local cache: ${descriptor.indexedDbName}`,
          });
          expect(error).not.toBeInstanceOf(LocalCacheCorruptionError);
          expect(error).not.toHaveProperty('cause');
        } finally {
          open.mockRestore();
        }
        expect(await storage.readCachedSelfProfile()).toEqual(self);
      },
    );

    it('keeps lifecycle and worker transport failures out of the class', async () => {
      await seed();
      await writer.close();
      // No account is bound to this handle.
      await plain(() => storage.db(), 'webdb: no user / unavailable');

      // Another owner ends the cache lifetime while the strict open validates the schema.
      const original = IDBObjectStore.prototype.get;
      const get = vi
        .spyOn(IDBObjectStore.prototype, 'get')
        .mockImplementation(function (this: IDBObjectStore, ...args) {
          const request = original.apply(this, args);
          if (this.name === 'accountState') lifecycle.invalidateSession();
          return request;
        });
      try {
        await plain(
          () => storage.openExistingForUser('42'),
          'webdb: stale existing-cache open discarded',
        );
      } finally {
        get.mockRestore();
      }

      // The discarded open closed the handle, so ordinary admission stays shut.
      await plain(
        () => storage.readAccountState(),
        'account cache lifetime expired',
      );

      // An open handle without a database worker reports the transport, not damage.
      await storage.openExistingForUser('42');
      await plain(
        () => storage.resolveProfileDemand(demand),
        'database worker unavailable',
      );
    });
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
