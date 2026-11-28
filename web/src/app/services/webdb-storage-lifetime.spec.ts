import {
  DatabaseOperationLifetimeEndedError,
  WebdbStorage,
} from './webdb-storage';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { threadFeedSnapshot } from './thread-feed.test-helper';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('WebdbStorage terminal lifetime', () => {
  let storage: WebdbStorage;
  let lifetime: AbortController;
  const userId = '9142';

  beforeEach(async () => {
    storage = new WebdbStorage();
    lifetime = new AbortController();
    storage.bindAppDataLifetime(lifetime.signal);
    storage.bindSessionCache(await prepareTestSessionCache());
    await storage.openForUser(userId);
    await storage.mergeThreadStates(
      [
        threadFeedSnapshot(7, {
          publisherNamespaceId: 0,
          profileAccount: 'peer',
          profileRev: 0,
        }),
      ],
      1,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await storage.closeAndDelete(userId);
  });

  it.each(['resolve', 'reject'] as const)(
    'drains an actual deferred projection before closing handles (%s)',
    async (outcome) => {
      const entered = deferred<void>();
      const count = deferred<number>();
      vi.spyOn(storage, 'countUnreadMessageSlots').mockImplementation(() => {
        entered.resolve();
        return count.promise;
      });
      const handle = await storage.db();
      const closeHandle = vi.spyOn(handle, 'close');
      const projection = storage.projectThreadAttention(7, {
        account: 'self',
        namespaceId: 0,
      });
      const rejected = expect(projection).rejects.toThrow();
      await entered.promise;
      lifetime.abort();
      const closed = vi.fn();
      const closing = storage.close().then(closed);
      await Promise.resolve();
      expect(closeHandle).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      if (outcome === 'resolve') count.resolve(0);
      else count.reject(new Error('count failed'));
      await rejected;
      await closing;
      expect(closeHandle).toHaveBeenCalledOnce();
      expect(storage.ready()).toBe(false);
    },
  );

  it('rejects an active browser result even before the owner starts cleanup', async () => {
    const entered = deferred<void>();
    const count = deferred<number>();
    vi.spyOn(storage, 'countUnreadMessageSlots').mockImplementation(() => {
      entered.resolve();
      return count.promise;
    });
    const pending = storage.projectThreadAttention(7, {
      account: 'self',
      namespaceId: 0,
    });
    const rejected = expect(pending).rejects.toThrow('lifetime ended');
    await entered.promise;
    lifetime.abort();
    count.resolve(0);
    await rejected;
    // The gate fences delivery, not transaction execution. Cleanup is still explicit.
    expect(storage.ready()).toBe(false);
  });

  it('rejects new business work, cached-self restoration, raw acquisition and worker ports', async () => {
    lifetime.abort();
    await expect(storage.getThreads()).rejects.toThrow('lifetime ended');
    await expect(storage.countCachedMessages()).rejects.toThrow(
      'lifetime ended',
    );
    await expect(storage.readCachedSelfProfile()).rejects.toThrow(
      'lifetime ended',
    );
    await expect(storage.db()).rejects.toThrow('lifetime ended');
    await expect(storage.createThreadFeedPort()).rejects.toThrow(
      'lifetime ended',
    );
    await expect(storage.openForUser(userId)).rejects.toThrow('lifetime ended');
    await expect(storage.openExistingForUser(userId)).rejects.toThrow(
      'lifetime ended',
    );
    await expect(storage.clearPendingSends()).rejects.toThrow('lifetime ended');
  });

  it('does not start a queued feed-lock callback after termination', async () => {
    const name = 'soms-thread-feed-' + userId;
    const acquired = deferred<void>();
    const release = deferred<void>();
    const holding = navigator.locks.request(name, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const work = vi.fn(async () => storage.getThreads());
    const queued = storage.withThreadFeedLock(work);
    const rejected = expect(queued).rejects.toThrow();
    lifetime.abort();
    await storage.close();
    release.resolve();
    await holding;
    await rejected;
    expect(work).not.toHaveBeenCalled();
  });

  it('cancels a message commit queued behind a browser lock before it writes', async () => {
    const acquired = deferred<void>();
    const release = deferred<void>();
    const holding = navigator.locks.request(
      `soms-message-commit-${userId}-7`,
      async () => {
        acquired.resolve();
        await release.promise;
      },
    );
    await acquired.promise;
    const handle = await storage.db();
    const before = await handle.get('threads', 7);
    const queued = storage.putMessageHead(7, 123);
    const rejected = expect(queued).rejects.toThrow();
    lifetime.abort();
    await rejected;
    release.resolve();
    await holding;
    expect(await handle.get('threads', 7)).toEqual(before);
  });

  it('terminates the worker RPC endpoint and rejects later port creation', async () => {
    const url = URL.createObjectURL(
      new Blob(
        [`onmessage = ({ data }) => postMessage({ id: data.id, ok: true });`],
        { type: 'text/javascript' },
      ),
    );
    const worker = new Worker(url);
    const terminate = vi.spyOn(worker, 'terminate');
    const workerStorage = new WebdbStorage(() => worker);
    workerStorage.bindAppDataLifetime(lifetime.signal);
    workerStorage.bindSessionCache(await prepareTestSessionCache());
    try {
      await workerStorage.openForUser(userId);
      const port = await workerStorage.createThreadFeedPort();
      expect(port).not.toBeNull();
      lifetime.abort();
      expect(terminate).toHaveBeenCalledOnce();
      await expect(workerStorage.createThreadFeedPort()).rejects.toThrow(
        'lifetime ended',
      );
      port?.close();
    } finally {
      await workerStorage.closeAndDelete(userId);
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  it('rejects and drains a worker binding RPC still awaiting acknowledgement', async () => {
    const url = URL.createObjectURL(
      new Blob(['onmessage = () => {};'], {
        type: 'text/javascript',
      }),
    );
    const worker = new Worker(url);
    const workerStorage = new WebdbStorage(() => worker);
    workerStorage.bindAppDataLifetime(lifetime.signal);
    workerStorage.bindSessionCache(await prepareTestSessionCache());
    try {
      await workerStorage.openForUser(userId);
      const binding = workerStorage.createThreadFeedPort();
      const rejected = expect(binding).rejects.toThrow('lifetime ended');
      lifetime.abort();
      await rejected;
      await workerStorage.close();
    } finally {
      await workerStorage.closeAndDelete(userId);
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  it('fences empty and invalid-input fast paths after termination', async () => {
    await expect(
      storage.getProfileAvatarBlob('invalid'),
    ).resolves.toBeUndefined();
    await expect(storage.getMessageDeletions(7, [])).resolves.toEqual([]);
    await expect(storage.putCachedMessages([])).resolves.toBeUndefined();
    lifetime.abort();
    await expect(
      storage.getProfileAvatarBlob('invalid'),
    ).rejects.toBeInstanceOf(DatabaseOperationLifetimeEndedError);
    await expect(storage.getMessageDeletions(7, [])).rejects.toBeInstanceOf(
      DatabaseOperationLifetimeEndedError,
    );
    await expect(storage.putCachedMessages([])).rejects.toBeInstanceOf(
      DatabaseOperationLifetimeEndedError,
    );
  });

  it.each(['close', 'recreate'] as const)(
    'does not hold the DB drain during stalled namespace HTTP (%s)',
    async (maintenance) => {
      const entered = deferred<void>();
      const response = deferred<Response>();
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        entered.resolve();
        return response.promise;
      });
      const pull = storage.pullProfileNamespaceChanges();
      const rejected = expect(pull).rejects.toThrow(
        'account cache lifetime expired',
      );
      await entered.promise;
      if (maintenance === 'close') {
        await storage.close();
        await storage.openForUser(userId);
      } else {
        await storage.recreateForUser(userId);
      }
      expect(lifetime.signal.aborted).toBe(false);
      response.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: { items: [], scannedThrough: 99, endId: 99, hasMore: false },
          }),
        ),
      );
      await rejected;
      expect(
        (await storage.readAccountState()).profileNamespaceChangeEndId,
      ).not.toBe(99);
    },
  );

  it.each([
    'openForUser',
    'openExistingForUser',
    'initializeSessionCache',
  ] as const)(
    'normalizes late success/stale-open failure from %s without joining its own drain',
    async (method) => {
      await storage.close();
      const open = indexedDB.open.bind(indexedDB);
      vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
        const request = open(name, version);
        request.addEventListener('success', () => lifetime.abort(), {
          once: true,
        });
        return request;
      });
      const operation =
        method === 'initializeSessionCache'
          ? storage.initializeSessionCache()
          : storage[method](userId);
      await expect(operation).rejects.toBeInstanceOf(
        DatabaseOperationLifetimeEndedError,
      );
      await storage.close();
      expect(storage.ready()).toBe(false);
    },
  );

  it.each([
    'openForUser',
    'openExistingForUser',
    'initializeSessionCache',
  ] as const)(
    'normalizes an underlying late failure from %s',
    async (method) => {
      await storage.close();
      vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        lifetime.abort();
        throw new Error('open failed');
      });
      const operation =
        method === 'initializeSessionCache'
          ? storage.initializeSessionCache()
          : storage[method](userId);
      await expect(operation).rejects.toBeInstanceOf(
        DatabaseOperationLifetimeEndedError,
      );
      await storage.close();
    },
  );

  it('allows explicit reset and delete cleanup without reopening terminal admission', async () => {
    lifetime.abort();
    await storage.recreateMessageCache();
    await expect(storage.recreateForUser(userId)).resolves.toBeNull();
    await storage.closeAndDelete(userId);
    await storage.recreateSessionCache();
    await storage.close();
    expect(storage.ready()).toBe(false);
    await expect(storage.getThreads()).rejects.toThrow('lifetime ended');
  });
});
