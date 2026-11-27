import { nativeHistoryInterval } from './native-history-interval';

describe('native history interval IPC', () => {
  const original = window.__TAURI__;
  let emit: (event: unknown) => void;
  let registered: (id: string) => void;
  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    invoke = vi.fn((command: string) =>
      command === 'native_message_history_interval_start'
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

  it('only forwards Rust pages and mount coordinates; no renderer HTTP or retry machine', async () => {
    const next = vi.fn();
    const subscription = nativeHistoryInterval(1, 42, 20, 80, 'newer').subscribe(next);
    expect(invoke).toHaveBeenCalledWith(
      'native_message_history_interval_start',
      expect.objectContaining({
        userId: 1,
        threadId: 42,
        left: 20,
        right: 80,
        direction: 'newer',
      }),
    );
    const page = { left: 70, right: 80, items: [] };
    emit({ state: 'page', page });
    emit({ state: 'page', page: { ...page, left: 60 } });
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenNthCalledWith(1, page);
    registered('watch');
    await Promise.resolve();
    subscription.unsubscribe();
    expect(invoke).toHaveBeenLastCalledWith('native_message_history_cancel', {
      requestId: 'watch',
    });
  });

  it('cancels a late registration after unmount and ignores late pages', async () => {
    const next = vi.fn();
    const subscription = nativeHistoryInterval(1, 42, 20, 80, 'older').subscribe(next);
    subscription.unsubscribe();
    emit({ state: 'page', page: { left: 70, right: 80, items: [] } });
    registered('late');
    await Promise.resolve();
    expect(invoke).toHaveBeenLastCalledWith('native_message_history_cancel', {
      requestId: 'late',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('pagehide cancels mounted native ownership', async () => {
    const subscription = nativeHistoryInterval(1, 42, 20, 80, 'older').subscribe();
    registered('hidden');
    await Promise.resolve();
    window.dispatchEvent(new Event('pagehide'));
    expect(subscription.closed).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('native_message_history_cancel', {
      requestId: 'hidden',
    });
  });
});
