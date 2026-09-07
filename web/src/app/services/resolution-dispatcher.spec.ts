import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  ResolutionDispatcher,
  ResolutionTerminal,
} from './resolution-dispatcher';
import type { WebsocketService } from './websocket.service';

function realtime() {
  return {
    eventSubject: new Subject<unknown>(),
    helloReady$: new BehaviorSubject(true),
    helloGeneration$: new BehaviorSubject(1),
  };
}

describe('shared resolution dispatcher', () => {
  it('does not restart an ended session request when HELLO arrives for another session', async () => {
    const ws = realtime();
    ws.helloReady$.next(false);
    const start = vi.fn(async () => ({ status: 'READY' as const, result: 42 }));
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      () => null,
    );
    const old = firstValueFrom(dispatcher.resolve({ id: 1 })).catch(
      (error: Error) => error.message,
    );
    dispatcher.reset();
    ws.helloReady$.next(true);
    expect(await old).toBe('resolution session ended');
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps cached first render available while the realtime connection is offline', async () => {
    const ws = realtime();
    ws.helloReady$.next(false);
    const start = vi.fn(async () => ({ status: 'READY' as const, result: 42 }));
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      () => null,
    );
    const result = firstValueFrom(dispatcher.resolve({ id: 1 }));
    await dispatcher.prepare({ id: 1 });
    expect(start).not.toHaveBeenCalled();
    ws.helloReady$.next(true);
    expect(await result).toBe(42);
  });

  it('delivers READY data before releasing the first-render barrier', async () => {
    const ws = realtime();
    let finish!: (value: { status: 'READY'; result: number }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ status: 'READY'; result: number }>(
          (resolve) => (finish = resolve),
        ),
    );
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      () => null,
    );
    const received: number[] = [];
    dispatcher.resolve({ id: 1 }).subscribe((value) => received.push(value));
    let prepared = false;
    const initial = dispatcher.prepare({ id: 1 }).then(() => {
      prepared = true;
      expect(received).toEqual([42]);
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(prepared).toBe(false);
    finish({ status: 'READY', result: 42 });
    await initial;
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('releases first render on PENDING and delivers the later terminal to the same subscriber', async () => {
    const ws = realtime();
    const start = vi.fn(async () => ({
      status: 'PENDING' as const,
      requestId: 'later',
    }));
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      (e) => e as ResolutionTerminal<number>,
    );
    const result = firstValueFrom(dispatcher.resolve({ id: 1 }));
    await dispatcher.prepare({ id: 1 });
    expect(start).toHaveBeenCalledTimes(1);
    ws.eventSubject.next({ requestId: 'later', result: 42 });
    expect(await result).toBe(42);
  });

  it('releases first render when the initial request fails', async () => {
    const ws = realtime();
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      async () => {
        throw new Error('offline');
      },
      () => null,
    );
    const failed = vi.fn();
    dispatcher.resolve({ id: 1 }).subscribe({ error: failed });
    await dispatcher.prepare({ id: 1 });
    expect(failed).toHaveBeenCalledOnce();
  });

  it('coalesces mounts and handles an SSE terminal arriving before the HTTP response', async () => {
    const ws = realtime();
    const start = vi.fn(async () => {
      ws.eventSubject.next({ requestId: 'r1', result: 42 });
      return { status: 'PENDING' as const, requestId: 'r1' };
    });
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      (e) => e as ResolutionTerminal<number>,
    );
    const a = dispatcher.resolve({ id: 1 });
    const b = dispatcher.resolve({ id: 1 });
    expect(a).toBe(b);
    expect(await Promise.all([firstValueFrom(a), firstValueFrom(b)])).toEqual([
      42, 42,
    ]);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('reissues after reconnect and accepts a ready response', async () => {
    const ws = realtime();
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'PENDING', requestId: 'old' })
      .mockResolvedValueOnce({ status: 'READY', result: 9 });
    const dispatcher = new ResolutionDispatcher<{ id: number }, number>(
      ws as unknown as WebsocketService,
      start,
      (e) => e as ResolutionTerminal<number>,
    );
    const result = firstValueFrom(dispatcher.resolve({ id: 1 }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    ws.helloGeneration$.next(2);
    expect(await result).toBe(9);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
