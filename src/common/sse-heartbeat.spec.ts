import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subject, of, take, throwError } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { withSseHeartbeat } from './sse-heartbeat.js';
import {
  SSE_HEARTBEAT_EVENT,
  SSE_HEARTBEAT_MS,
} from '../../shared/sse-policy.js';

afterEach(() => vi.useRealTimers());

describe('SSE heartbeat', () => {
  it('opens immediately, survives quiet periods and preserves domain events', () => {
    vi.useFakeTimers();
    const source = new Subject<MessageEvent>();
    const events: MessageEvent[] = [];
    const sub = source
      .pipe(withSseHeartbeat())
      .subscribe((e) => events.push(e));
    expect(events).toEqual([{ type: SSE_HEARTBEAT_EVENT, data: {} }]);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    expect(events).toHaveLength(4);
    source.next({ type: 'HELLO', data: { cursor: 1 } });
    expect(events.at(-1)).toEqual({ type: 'HELLO', data: { cursor: 1 } });
    sub.unsubscribe();
    expect(source.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans timers on synchronous completion and errors', () => {
    vi.useFakeTimers();
    of({ type: 'log', data: {} }).pipe(withSseHeartbeat()).subscribe();
    expect(vi.getTimerCount()).toBe(0);
    const error = vi.fn();
    throwError(() => new Error('failed'))
      .pipe(withSseHeartbeat())
      .subscribe({ error });
    expect(error).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not subscribe domain work after the opening frame already cancels the stream', () => {
    vi.useFakeTimers();
    const source = new Subject<MessageEvent>();
    source.pipe(withSseHeartbeat(), take(1)).subscribe();
    expect(source.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops heartbeats when the domain stream completes', () => {
    vi.useFakeTimers();
    const source = new Subject<MessageEvent>();
    const next = vi.fn();
    source.pipe(withSseHeartbeat()).subscribe(next);
    source.complete();
    vi.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
