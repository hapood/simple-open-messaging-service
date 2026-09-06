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
