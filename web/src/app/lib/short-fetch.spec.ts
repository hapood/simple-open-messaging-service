import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchShortText } from './short-fetch';

describe('fetchShortText', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('decodes UTF-8 across chunks and reports byte progress in lifecycle order', async () => {
    const bytes = new TextEncoder().encode('你');
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }),
      { headers: { 'content-length': '3' } },
    );
    fetchMock.mockResolvedValue(response);
    const events: string[] = [];
    const result = await fetchShortText(
      '/test',
      {},
      new AbortController().signal,
      {
        onSent: () => events.push('sent'),
        onResponse: () => events.push('headers'),
        onDownloadProgress: (loaded, total) =>
          events.push(`${loaded}/${total}`),
      },
    );
    expect(result).toEqual({ response, text: '你' });
    expect(events).toEqual(['sent', 'headers', '1/3', '3/3']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    'awaits size-limit cancellation acknowledgement (declared=%s)',
    async (declared) => {
      let acknowledge!: () => void;
      const cancel = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      );
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
          },
          cancel,
        }),
        { headers: declared ? { 'content-length': '4' } : {} },
      );
      fetchMock.mockResolvedValue(response);
      let settled = false;
      const pending = fetchShortText(
        '/test',
        {},
        new AbortController().signal,
        { maxResponseSize: 3 },
      );
      const assertion = expect(pending).rejects.toThrow(
        'configured buffer limit (3 bytes)',
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      acknowledge();
      await assertion;
      expect(response.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('rejects already-aborted owners without dispatching', async () => {
    const owner = new AbortController();
    const reason = new Error('ended');
    owner.abort(reason);
    await expect(fetchShortText('/test', {}, owner.signal)).rejects.toBe(
      reason,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests total-timeout cancellation but waits for transport settlement', async () => {
    let transportSignal: AbortSignal | null | undefined;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_url, init) => {
      transportSignal = init?.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    let settled = false;
    const pending = fetchShortText('/test', {}, new AbortController().signal, {
      timeout: 500,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(transportSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    finish(new Response('done'));
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the owner listener and deadlines after fetch setup failure', async () => {
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    const error = new TypeError('invalid fetch init');
    fetchMock.mockImplementation(() => {
      throw error;
    });
    await expect(
      fetchShortText('/test', {}, owner.signal, { timeout: 500 }),
    ).rejects.toBe(error);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
