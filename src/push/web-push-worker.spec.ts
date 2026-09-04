import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../web/public/push/sw-push.js', import.meta.url)),
  'utf8',
);

class TestMessageChannel {
  readonly port1: TestMessagePort;
  readonly port2: TestMessagePort;

  constructor() {
    this.port1 = new TestMessagePort();
    this.port2 = new TestMessagePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class TestMessagePort {
  peer?: TestMessagePort;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(data: unknown): void {
    this.peer?.onmessage?.({ data });
  }
}

function memoryIndexedDb(initial: number) {
  let checkpoint = initial;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: (_store: string, _mode: string) => {
      const tx: {
        objectStore: () => {
          get: () => Record<string, unknown>;
          put: (value: number) => void;
        };
        oncomplete?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        error?: unknown;
      } = {
        objectStore: () => ({
          get: () => {
            const request: Record<string, unknown> = { result: undefined };
            queueMicrotask(() => {
              request.result = checkpoint;
              (request.onsuccess as (() => void) | undefined)?.();
              queueMicrotask(() => tx.oncomplete?.());
            });
            return request;
          },
          put: (value: number) => {
            checkpoint = value;
          },
        }),
      };
      return tx;
    },
  };
  return {
    api: {
      open: () => {
        const request: Record<string, unknown> = { result: undefined };
        queueMicrotask(() => {
          request.result = db;
          (request.onsuccess as (() => void) | undefined)?.();
        });
        return request;
      },
    },
    read: () => checkpoint,
  };
}

function workerHarness(opts: {
  checkpoint?: number;
  pages?: Array<{
    postMessage: (data: unknown, ports: TestMessagePort[]) => void;
  }>;
  fetch: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<
    string,
    (event: { waitUntil: (p: Promise<void>) => void }) => void
  >();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const indexedDb = memoryIndexedDb(opts.checkpoint ?? 0);
  const worker = {
    __SOMS_API_PREFIX__: '/api/v1',
    __SOMS_NOTIF_MSG__: {
      CLAIM: 'soms-notif-claim',
      DISMISS: 'soms-notif-dismiss',
      OPEN: 'soms-notif-open',
    },
    navigator: { language: 'en' },
    clients: {
      matchAll: vi.fn().mockResolvedValue(opts.pages ?? []),
      openWindow: vi.fn(),
    },
    registration: {
      showNotification,
    },
    addEventListener: (
      name: string,
      handler: (event: { waitUntil: (p: Promise<void>) => void }) => void,
    ) => handlers.set(name, handler),
  };
  vm.runInNewContext(WORKER_SOURCE, {
    self: worker,
    importScripts: vi.fn(),
    indexedDB: indexedDb.api,
    fetch: opts.fetch,
    MessageChannel: TestMessageChannel,
    setTimeout,
    queueMicrotask,
  });
  return {
    showNotification,
    checkpoint: indexedDb.read,
    async push(): Promise<void> {
      let work: Promise<void> | undefined;
      handlers.get('push')?.({ waitUntil: (promise) => (work = promise) });
      await work;
    },
  };
}

describe('browser Push worker takeover', () => {
  it('does not query or render when a healthy SSE page claims the Push', async () => {
    const fetch = vi.fn();
    const page = {
      postMessage: (_data: unknown, ports: TestMessagePort[]) =>
        ports[0].postMessage({ claimed: true }),
    };
    const worker = workerHarness({ pages: [page], fetch });

    await worker.push();

    expect(fetch).not.toHaveBeenCalled();
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it('falls back from the persisted cursor and advances it only after a successful query', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          stateFeedEndId: 8,
          notifications: [
            {
              kind: 'thread-message',
              title: 'Alice',
              body: 'New message',
              tag: 'soms-thread-7',
              data: { threadId: 7, seq: 9 },
              actions: [],
            },
          ],
        },
      }),
    });
    const worker = workerHarness({ checkpoint: 5, fetch });

    await worker.push();

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ after: 5 });
    expect(worker.showNotification).toHaveBeenCalledOnce();
    expect(worker.checkpoint()).toBe(8);
  });

  it('does not advance the persisted cursor when the fallback query fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const worker = workerHarness({ checkpoint: 3, fetch });

    await worker.push();

    expect(worker.checkpoint()).toBe(3);
    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it('treats an empty delta as a no-op while still advancing the cursor', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { stateFeedEndId: 9, notifications: [] },
      }),
    });
    const worker = workerHarness({ checkpoint: 8, fetch });

    await worker.push();

    expect(worker.showNotification).not.toHaveBeenCalled();
    expect(worker.checkpoint()).toBe(9);
  });
});
