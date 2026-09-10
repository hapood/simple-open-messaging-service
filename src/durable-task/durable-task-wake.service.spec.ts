import { Logger } from '@nestjs/common';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableTaskWakeService } from './durable-task-wake.service.js';

interface MockClient extends EventEmitter {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}
const state = vi.hoisted(() => ({
  clients: [] as MockClient[],
  failConnect: false,
  listenGate: undefined as Promise<void> | undefined,
}));
vi.mock('pg', async (original) => {
  const pg = await original<typeof import('pg')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...pg,
    Client: class extends EventEmitter {
      constructor() {
        super();
        state.clients.push(this);
      }
      connect = vi.fn(async () => {
        if (state.failConnect) throw new Error('connection refused');
      });
      query = vi.fn(async () => {
        await state.listenGate;
      });
      end = vi.fn(async () => {
        this.emit('end');
      });
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  state.clients.length = 0;
  state.failConnect = false;
  state.listenGate = undefined;
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness() {
  const wake = vi.fn().mockResolvedValue(undefined);
  return {
    wake,
    listener: new DurableTaskWakeService(
      { pool: { options: {} } } as never,
      { wake } as never,
    ),
  };
}

describe('DurableTaskWakeService', () => {
  it('subscribes before scanning and needs no timer on a healthy idle connection', async () => {
    let release!: () => void;
    state.listenGate = new Promise((resolve) => {
      release = resolve;
    });
    const { listener, wake } = harness();
    const boot = listener.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.clients[0].query).toHaveBeenCalledWith(
      'LISTEN durable_task_work',
    );
    expect(wake).not.toHaveBeenCalled();
    release();
    await boot;
    expect(wake).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    state.clients[0].emit('notification', { channel: 'unrelated' });
    expect(wake).toHaveBeenCalledOnce();
    state.clients[0].emit('notification', { channel: 'durable_task_work' });
    expect(wake).toHaveBeenCalledTimes(2);
    await listener.onModuleDestroy();
  });

  it('reconnects once after error/end, rescans, and ignores stale connection hints', async () => {
    const { listener, wake } = harness();
    await listener.onApplicationBootstrap();
    const old = state.clients[0];
    old.emit('error', new Error('connection lost'));
    old.emit('end');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1].query).toHaveBeenCalledWith(
      'LISTEN durable_task_work',
    );
    expect(wake).toHaveBeenCalledTimes(2);
    old.emit('notification', { channel: 'durable_task_work' });
    expect(wake).toHaveBeenCalledTimes(2);
    await listener.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.clients).toHaveLength(2);
  });

  it('retries connection failures and cancels pending reconnect on shutdown', async () => {
    state.failConnect = true;
    const { listener, wake } = harness();
    await listener.onApplicationBootstrap();
    expect(wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.clients).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await listener.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.clients).toHaveLength(2);
  });
});
