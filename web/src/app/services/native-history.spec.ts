import { nativeHistoryRequest } from './native-history';

describe('native history transport', () => {
  const original = window.__TAURI__;
  let emit: (event: unknown) => void;
  let registered: (id: string) => void;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((command: string) =>
      command === 'native_message_history_start'
        ? new Promise<string>((resolve) => {
            registered = resolve;
          })
        : Promise.resolve(),
    );
    window.__TAURI__ = {
      core: {
        invoke,
        Channel: class {
          constructor(callback: (event: unknown) => void) {
            emit = callback;
          }
        },
      },
    } as unknown as typeof window.__TAURI__;
  });
  afterEach(() => {
    window.__TAURI__ = original;
  });

  it('passes the known opening ceiling to the Rust-owned history walk', async () => {
    const pending = nativeHistoryRequest(
      1,
      42,
      { kind: 'newer', after: 19, count: 50 },
      new AbortController().signal,
      20,
    );
    expect(invoke).toHaveBeenCalledWith(
      'native_message_history_start',
      expect.objectContaining({ userId: 1, threadId: 42, knownNewestSeq: 20 }),
    );
    const result = { items: [], hasOlder: true, hasNewer: false, failed: false };
    emit({ state: 'ready', result });
    registered('completed');
    expect(await pending).toEqual(result);
  });

  it('cancels a handle returned after unbind and ignores late events', async () => {
    const controller = new AbortController();
    const pending = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      controller.signal,
      undefined,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejected;
    registered('old-binding');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('native_message_history_cancel', {
      requestId: 'old-binding',
    });
    emit({ state: 'ready', result: { items: [] } });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('handles an immediate result before the registration reply', async () => {
    const controller = new AbortController();
    const pending = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      controller.signal,
      undefined,
    );
    const result = {
      items: [],
      hasOlder: false,
      hasNewer: false,
      failed: false,
    };
    emit({ state: 'ready', result });
    expect(await pending).toEqual(result);
    registered('finished');
    controller.abort();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends cancellation on pagehide for an active registration', async () => {
    const pending = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      new AbortController().signal,
      undefined,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    registered('page');
    await Promise.resolve();
    window.dispatchEvent(new Event('pagehide'));
    await rejected;
    expect(invoke).toHaveBeenCalledWith('native_message_history_cancel', {
      requestId: 'page',
    });
  });

  it('pairs same-thread results with their own channels despite reversed replies', async () => {
    const first = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      new AbortController().signal,
      undefined,
    );
    const firstEmit = emit;
    const firstRegistered = registered;
    const second = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 20 },
      new AbortController().signal,
      undefined,
    );
    const secondEmit = emit;
    const secondRegistered = registered;
    const firstResult = {
      items: [],
      hasOlder: true,
      hasNewer: false,
      failed: false,
    };
    const secondResult = {
      items: [],
      hasOlder: false,
      hasNewer: true,
      failed: false,
    };
    secondRegistered('second');
    secondEmit({ state: 'ready', result: secondResult });
    expect(await second).toEqual(secondResult);
    firstEmit({ state: 'ready', result: firstResult });
    firstRegistered('first');
    expect(await first).toEqual(firstResult);
    await Promise.resolve();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'native_message_history_start',
      'native_message_history_start',
    ]);
  });

  it('cancels only the matching late handle and ignores its event while a sibling remains active', async () => {
    const controller = new AbortController();
    const first = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      controller.signal,
      undefined,
    );
    const firstEmit = emit;
    const firstRegistered = registered;
    const rejected = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    const second = nativeHistoryRequest(
      1,
      42,
      { kind: 'latest', count: 10 },
      new AbortController().signal,
      undefined,
    );
    const secondEmit = emit;
    registered('sibling');
    controller.abort();
    await rejected;
    firstRegistered('cancelled');
    await Promise.resolve();
    firstEmit({ state: 'failed', reason: 'late abandoned request' });
    const result = {
      items: [],
      hasOlder: false,
      hasNewer: false,
      failed: false,
    };
    secondEmit({ state: 'ready', result });
    expect(await second).toEqual(result);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'native_message_history_cancel',
      ),
    ).toEqual([['native_message_history_cancel', { requestId: 'cancelled' }]]);
  });

  it('does not start a previously cancelled request', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      nativeHistoryRequest(
        1,
        42,
        { kind: 'latest', count: 10 },
        controller.signal,
        undefined,
      ),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
