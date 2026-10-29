import { describe, expect, it, vi } from 'vitest';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';

function scheduler(global: number, perPeer: number) {
  const instance = new FederationDownloadScheduler({} as never);
  Object.assign(instance as unknown as Record<string, unknown>, {
    limits: { global, perPeer },
    limitsFetchedAt: Date.now(),
  });
  return instance;
}

describe('FederationDownloadScheduler', () => {
  it('enforces global and per-peer concurrency', async () => {
    const subject = scheduler(3, 2);
    let active = 0;
    let maxActive = 0;
    const peerActive = new Map<string, number>();
    let maxPeerA = 0;
    const run = (peer: string, digest: string) =>
      subject.schedule(peer, digest, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const count = (peerActive.get(peer) ?? 0) + 1;
        peerActive.set(peer, count);
        if (peer === 'a.example') maxPeerA = Math.max(maxPeerA, count);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        active -= 1;
        peerActive.set(peer, count - 1);
      });

    const tasks = [
      run('a.example', '1'),
      run('a.example', '2'),
      run('a.example', '3'),
      run('b.example', '4'),
    ];
    await Promise.all(tasks);
    expect(maxActive).toBe(3);
    expect(maxPeerA).toBe(2);
  });

  it('coalesces the same digest only within the same peer', async () => {
    const subject = scheduler(10, 10);
    const task = vi.fn(async () => 'ok');
    const [a1, a2, b] = await Promise.all([
      subject.schedule('a.example', 'digest', task),
      subject.schedule('a.example', 'digest', task),
      subject.schedule('b.example', 'digest', task),
    ]);
    expect([a1, a2, b]).toEqual(['ok', 'ok', 'ok']);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('reports bounded process-local snapshots and removes completed entries', async () => {
    const subject = scheduler(1, 1);
    let release!: () => void;
    const first = subject.schedule(
      'peer',
      'a',
      async (report) => {
        report({ received: 12, total: 100 });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      100,
    );
    const second = subject.schedule('peer', 'b', async () => undefined, 20);
    await vi.waitFor(() => expect(subject.snapshot().active).toBe(1));
    expect(subject.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      total: 2,
    });
    expect(subject.snapshot(0, 1).list).toEqual([
      { digest: 'a', status: 'active', bytesReceived: '12', bytesTotal: '100' },
    ]);
    expect(subject.snapshot(1, 1).list[0]).toMatchObject({
      digest: 'b',
      status: 'queued',
    });
    release();
    await Promise.all([first, second]);
    expect(subject.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      total: 0,
    });
  });

  it('stops a queued download without executing its IO', async () => {
    const subject = scheduler(1, 1);
    let release!: () => void;
    const first = subject.schedule(
      'peer',
      'a',
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const task = vi.fn();
    const second = subject.schedule('peer', 'b', task, 10, controller.signal);
    const rejected = expect(second).rejects.toThrow('cancel queued');
    await vi.waitFor(() => expect(subject.snapshot().queued).toBe(1));
    controller.abort(new Error('cancel queued'));
    await rejected;
    expect(subject.snapshot().queued).toBe(0);
    expect(task).not.toHaveBeenCalled();
    release();
    await first;
  });

  it('keeps shared physical IO alive until the last consumer stops', async () => {
    const subject = scheduler(1, 1);
    const one = new AbortController();
    const two = new AbortController();
    let physicalSignal!: AbortSignal;
    const task = vi.fn(async (_report, signal: AbortSignal) => {
      physicalSignal = signal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    const first = subject.schedule('peer', 'a', task, 100, one.signal);
    const second = subject.schedule('peer', 'a', task, 100, two.signal);
    const firstRejected = expect(first).rejects.toThrow('first stopped');
    const secondRejected = expect(second).rejects.toThrow('second stopped');
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    one.abort(new Error('first stopped'));
    await firstRejected;
    expect(physicalSignal.aborted).toBe(false);
    two.abort(new Error('second stopped'));
    await secondRejected;
    await subject.waitForDigest('a');
    expect(physicalSignal.aborted).toBe(true);
    expect(subject.hasDigest('a')).toBe(false);
  });

  it('stops physical IO and permits a new transfer of the same digest', async () => {
    const subject = scheduler(1, 1);
    const task = vi.fn(async (_report, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    const transfer = subject.schedule('peer', 'a', task, 10);
    const rejected = expect(transfer).rejects.toThrow(
      'stopped by administrator',
    );
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    await subject.stopDigest('a');
    await rejected;
    await expect(
      subject.schedule('peer', 'a', async () => 'retried'),
    ).resolves.toBe('retried');
    expect(subject.snapshot().total).toBe(0);
  });
});
