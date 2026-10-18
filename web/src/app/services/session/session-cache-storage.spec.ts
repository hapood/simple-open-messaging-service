import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebdbStorage } from '../webdb-storage';
import { createSessionCacheDescriptor } from './session-identity';

const owned: WebdbStorage[] = [];

function storage(worker?: Worker): WebdbStorage {
  const result = new WebdbStorage(() => worker ?? null);
  owned.push(result);
  return result;
}

afterEach(async () => {
  for (const item of owned.splice(0)) await item.closeAndDelete('1');
});

describe('UUID-bound browser cache', () => {
  it('uses UUID names for both databases and deletes both at logout', async () => {
    const cache = storage();
    const descriptor = createSessionCacheDescriptor();
    cache.bindSessionCache(descriptor);
    expect((await cache.openForUser('1'))?.name).toBe(descriptor.indexedDbName);
    const names = (await indexedDB.databases()).map((item) => item.name);
    expect(names).toContain(descriptor.indexedDbName);
    expect(names).toContain(descriptor.messageIndexedDbName);
    await cache.closeAndDelete('1');
    const remaining = (await indexedDB.databases()).map((item) => item.name);
    expect(remaining).not.toContain(descriptor.indexedDbName);
    expect(remaining).not.toContain(descriptor.messageIndexedDbName);
  });

  it('retains the same cache on restoration and isolates a fresh same-user login', async () => {
    const descriptor = createSessionCacheDescriptor();
    const original = storage();
    original.bindSessionCache(descriptor);
    await original.openForUser('1');
    await original.putMeta('probe', 'old-session');
    await original.close();

    const restored = storage();
    restored.bindSessionCache(descriptor);
    await restored.openExistingForUser('1');
    expect(await restored.getMeta('probe')).toBe('old-session');
    await restored.close();

    const successor = storage();
    successor.bindSessionCache(createSessionCacheDescriptor());
    await successor.openForUser('1');
    expect(await successor.getMeta('probe')).toBeUndefined();
  });

  it('rejects rebinding live or closing resources, then permits rebinding after deletion', async () => {
    const cache = storage();
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    cache.bindSessionCache(first);
    await cache.openForUser('1');
    expect(() => cache.bindSessionCache(second)).toThrow(
      'close session resources',
    );
    const deleting = cache.closeAndDelete('1');
    expect(() => cache.bindSessionCache(second)).toThrow(
      'close session resources',
    );
    await deleting;
    cache.bindSessionCache(second);
    expect((await cache.openForUser('1'))?.name).toBe(second.indexedDbName);
  });

  it('rejects a different user instead of deleting and reusing the login cache', async () => {
    const cache = storage();
    const descriptor = createSessionCacheDescriptor();
    cache.bindSessionCache(descriptor);
    await cache.openForUser('1');
    await cache.putMeta('probe', 'original-user');
    await expect(cache.openForUser('2')).rejects.toThrow(
      'bound to another user',
    );
    expect(await cache.getMeta('probe')).toBe('original-user');
  });

  it('rebuilds the bound UUID partition without falling back to user-named databases', async () => {
    const cache = storage();
    const descriptor = createSessionCacheDescriptor();
    cache.bindSessionCache(descriptor);
    await cache.openForUser('1');
    await cache.putMeta('probe', 'before-rebuild');
    expect((await cache.recreateForUser('1'))?.name).toBe(
      descriptor.indexedDbName,
    );
    expect(await cache.getMeta('probe')).toBeUndefined();
    expect((await indexedDB.databases()).map((item) => item.name)).toContain(
      descriptor.messageIndexedDbName,
    );
  });

  it('passes the immutable descriptor when assigning database worker ownership', async () => {
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const cache = storage(worker);
    const descriptor = createSessionCacheDescriptor();
    cache.bindSessionCache(descriptor);
    await cache.openForUser('1');
    const binding = cache.createThreadFeedPort();
    const request = vi.mocked(worker.postMessage).mock.calls[0][0] as {
      id: number;
      port: MessagePort;
      cacheDescriptor: unknown;
    };
    expect(request.cacheDescriptor).toEqual(descriptor);
    worker.onmessage!.call(worker, {
      data: { id: request.id, ok: true },
    } as MessageEvent);
    const port = await binding;
    port?.close();
    request.port.close();
  });
});
