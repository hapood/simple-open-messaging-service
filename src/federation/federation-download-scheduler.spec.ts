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
});
