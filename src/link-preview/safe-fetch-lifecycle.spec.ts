import { Test } from '@nestjs/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  lookup: vi.fn(),
  close: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('undici', () => ({
  fetch: network.fetch,
  Agent: class {
    close = network.close;
  },
}));
import { SafeFetchService } from './safe-fetch.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  network.close.mockResolvedValue(undefined);
});

describe('link-preview network shutdown', () => {
  it('rejects HTML and image admission without resolving DNS after module destruction', async () => {
    const service = new SafeFetchService();
    service.onModuleDestroy();
    await expect(service.fetchHtml('https://example.com')).rejects.toThrow(
      'link-preview network shutting down',
    );
    await expect(
      service.fetchImage('https://example.com/image'),
    ).rejects.toThrow('link-preview network shutting down');
    await service.beforeApplicationShutdown();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('waits for DNS but never starts HTTP from its late result', async () => {
    const service = new SafeFetchService();
    const dns = deferred<Array<{ address: string; family: number }>>();
    network.lookup.mockReturnValueOnce(dns.promise);
    const work = expect(
      service.fetchHtml('https://example.com'),
    ).rejects.toThrow('link-preview network shutting down');
    await vi.waitFor(() => expect(network.lookup).toHaveBeenCalledOnce());
    let closed = false;
    const closing = service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    dns.resolve([{ address: '8.8.8.8', family: 4 }]);
    await work;
    await closing;
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('aborts headers and waits for dispatcher cleanup before infrastructure closes', async () => {
    const service = new SafeFetchService();
    const cleanup = deferred<void>();
    network.close.mockReturnValueOnce(cleanup.promise);
    let signal!: AbortSignal;
    network.fetch.mockImplementationOnce((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    const closeDatabase = vi.fn();
    const mod = await Test.createTestingModule({
      providers: [
        { provide: SafeFetchService, useValue: service },
        {
          provide: 'database',
          useValue: { onApplicationShutdown: closeDatabase },
        },
      ],
    }).compile();
    const work = expect(
      service.fetchHtml('https://example.com'),
    ).rejects.toThrow('link-preview network shutting down');
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledOnce());
    const closing = mod.close();
    try {
      await vi.waitFor(() => expect(network.close).toHaveBeenCalledOnce());
      expect(signal.aborted).toBe(true);
      expect(closeDatabase).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await work;
      await closing;
    }
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('aborts a stalled body through the same network signal', async () => {
    const service = new SafeFetchService();
    network.fetch.mockImplementationOnce((_url, options) =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: new ReadableStream({
          start(controller) {
            options.signal.addEventListener(
              'abort',
              () => controller.error(options.signal.reason),
              { once: true },
            );
          },
        }),
      }),
    );
    const work = expect(
      service.fetchHtml('https://example.com'),
    ).rejects.toThrow('link-preview network shutting down');
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledOnce());
    await service.beforeApplicationShutdown();
    await work;
    expect(network.close).toHaveBeenCalledOnce();
  });

  it('does not follow a redirect after shutdown during connection cleanup', async () => {
    const service = new SafeFetchService();
    const cleanup = deferred<void>();
    network.close.mockReturnValueOnce(cleanup.promise);
    network.fetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'https://other.example/path' }),
      body: null,
    });
    const work = expect(
      service.fetchHtml('https://example.com'),
    ).rejects.toThrow('link-preview network shutting down');
    await vi.waitFor(() => expect(network.close).toHaveBeenCalledOnce());
    const closing = service.beforeApplicationShutdown();
    cleanup.resolve();
    await work;
    await closing;
    expect(network.lookup).toHaveBeenCalledOnce();
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('reports dispatcher cleanup failures to the request and shutdown', async () => {
    const service = new SafeFetchService();
    const cleanup = deferred<void>();
    const failure = new Error('dispatcher close failed');
    network.close.mockReturnValueOnce(cleanup.promise);
    network.fetch.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: null,
    });
    const work = expect(service.fetchHtml('https://example.com')).rejects.toBe(
      failure,
    );
    await vi.waitFor(() => expect(network.close).toHaveBeenCalledOnce());
    const closing = expect(
      service.beforeApplicationShutdown(),
    ).rejects.toMatchObject({ errors: [failure] });
    cleanup.reject(failure);
    await work;
    await closing;
  });
});
