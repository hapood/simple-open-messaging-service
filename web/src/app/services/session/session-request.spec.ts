import { Observable, of, TimeoutError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionRequest } from './session-request';
import { SessionSupersededError } from './session-identity';

afterEach(() => vi.useRealTimers());

describe('session HTTP cancellation', () => {
  it('never dispatches a request whose scope has already ended', async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatch = vi.fn();
    const source = new Observable(() => {
      dispatch();
    });
    await expect(
      sessionRequest(source, controller.signal),
    ).rejects.toBeInstanceOf(SessionSupersededError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('unsubscribes the transport on scope cancellation', async () => {
    const controller = new AbortController();
    const abortTransport = vi.fn();
    const source = new Observable(() => abortTransport);
    const pending = sessionRequest(source, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    controller.abort();
    await rejected;
    expect(abortTransport).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the transport on request timeout', async () => {
    vi.useFakeTimers();
    const abortTransport = vi.fn();
    const source = new Observable(() => abortTransport);
    const pending = sessionRequest(source, new AbortController().signal, 50);
    const rejected = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(abortTransport).toHaveBeenCalledTimes(1);
  });

  it('removes its cancellation listener after successful completion', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    expect(await sessionRequest(of('ok'), controller.signal)).toBe('ok');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
