import { describe, expect, it } from 'vitest';
import { deleteBrowserSessionCache } from './session/browser-session-cache';
import { createSessionCacheDescriptor } from './session/session-identity';
import { BrowserSendOutboxStorage, type StoredSendTask } from './send-outbox-storage';

const task = (): StoredSendTask => ({
  clientMessageId: 'cid', threadId: 1,
  item: { type: 'AUDIO', file: { partId: 'part', path: 'runtime-file-key', name: 'voice.webm', size: 5, mimeType: 'audio/webm' } },
});

describe('reference-only browser send storage', () => {
  it('deletes pending metadata through existing session database cleanup', async () => {
    const descriptor = createSessionCacheDescriptor();
    const name = `${descriptor.indexedDbName}-pending-sends`;
    const store = await BrowserSendOutboxStorage.open(name);
    await store.enqueue(task());
    store.close();
    await deleteBrowserSessionCache();
    const reopened = await BrowserSendOutboxStorage.open(name);
    expect(await reopened.list()).toEqual([]);
    reopened.close();
  });

  it('reopens the original path and request without runtime phase or file bytes', async () => {
    const name = crypto.randomUUID();
    const store = await BrowserSendOutboxStorage.open(name);
    await store.enqueue(task());
    store.close();
    const reopened = await BrowserSendOutboxStorage.open(name);
    const saved = await reopened.get('cid');
    expect(saved).toEqual(task());
    expect(Object.hasOwn(saved!, 'phase')).toBe(false);
    if (!saved || !('file' in saved.item)) throw new Error('expected attachment');
    expect(Object.hasOwn(saved.item.file, 'blob')).toBe(false);
    await reopened.remove('cid');
    expect(await reopened.get('cid')).toBeUndefined();
    reopened.close();
  });

  it('rejects embedded Blob content without writing a record', async () => {
    const store = await BrowserSendOutboxStorage.open(crypto.randomUUID());
    const saved = task();
    if (!('file' in saved.item)) throw new Error('expected attachment');
    const invalid = { ...saved, item: { ...saved.item, file: { ...saved.item.file, blob: new Blob(['audio']) } } };
    await expect(store.enqueue(invalid)).rejects.toThrow('not file bytes');
    expect(await store.list()).toEqual([]);
    store.close();
  });

  it('preserves contact and forwarding request parameters', async () => {
    const store = await BrowserSendOutboxStorage.open(crypto.randomUUID());
    const tasks: StoredSendTask[] = [
      { clientMessageId: 'contact', threadId: 1, item: { type: 'CONTACT_CARD', target: { account: 'alice', namespaceId: 2, profileRev: 7 } } },
      { clientMessageId: 'forward', threadId: 1, item: { type: 'FORWARD', sourceMessages: [{ threadId: 3, seq: 9 }], mode: 'HISTORY' } },
    ];
    for (const entry of tasks) await store.enqueue(entry);
    expect(await store.list()).toEqual(tasks);
    await store.clear();
    store.close();
  });

  it('rejects duplicate identities and isolates database partitions', async () => {
    const store = await BrowserSendOutboxStorage.open(crypto.randomUUID());
    const other = await BrowserSendOutboxStorage.open(crypto.randomUUID());
    await store.enqueue(task());
    await expect(store.enqueue({ ...task(), threadId: 2 })).rejects.toThrow();
    expect((await store.list())[0].threadId).toBe(1);
    expect(await other.list()).toEqual([]);
    await store.clear();
    expect(await store.list()).toEqual([]);
    store.close(); other.close();
  });

  it('preserves gallery order, paths, sizes and exact MIME', async () => {
    const store = await BrowserSendOutboxStorage.open(crypto.randomUUID());
    const gallery: StoredSendTask = { clientMessageId: 'gallery', threadId: 1, item: { type: 'GALLERY', files: [
      { partId: 'a', path: 'first', name: 'a', size: 2, mimeType: 'application/x-custom', intent: 'FILE' },
      { partId: 'b', path: 'second', name: 'b', size: 3, mimeType: 'image/png', intent: 'IMAGE' },
    ] } };
    await store.enqueue(gallery);
    expect(await store.get('gallery')).toEqual(gallery);
    await store.clear(); store.close();
  });
});
