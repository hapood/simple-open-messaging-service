import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
  it('aborts shared physical IO and removes queued work before infrastructure closes', async () => {
    const subject = scheduler(1, 1);
    const closeDatabase = vi.fn();
    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: 'database',
          useValue: { onApplicationShutdown: closeDatabase },
        },
        { provide: FederationDownloadScheduler, useValue: subject },
      ],
    }).compile();
    let release!: () => void;
    let physical!: AbortSignal;
    let report!: (progress: { received: number; total: number }) => void;
    const task = vi.fn((progress, signal) => {
      physical = signal;
      report = progress;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = expect(
      subject.schedule('peer', 'shared', task, 4, new AbortController().signal),
    ).rejects.toThrow('download scheduler shutting down');
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    const second = expect(
      subject.schedule('peer', 'shared', task, 4, new AbortController().signal),
    ).rejects.toThrow('download scheduler shutting down');
    const queuedTask = vi.fn();
    const queued = expect(
      subject.schedule(
        'peer',
        'queued',
        queuedTask,
        4,
        new AbortController().signal,
      ),
    ).rejects.toThrow('download scheduler shutting down');
    await vi.waitFor(() => expect(subject.snapshot().queued).toBe(1));
    const closing = mod.close();
    try {
      await vi.waitFor(() => expect(physical.aborted).toBe(true));
      await queued;
      expect(subject.snapshot()).toMatchObject({
        active: 1,
        queued: 0,
        total: 1,
      });
      expect(closeDatabase).not.toHaveBeenCalled();
      report({ received: 4, total: 4 });
      expect(subject.snapshot().list[0].bytesReceived).toBe('0');
      await expect(
        subject.schedule('peer', 'new', task, 4, new AbortController().signal),
      ).rejects.toThrow('download scheduler shutting down');
      await expect(subject.stopDigest('shared')).rejects.toThrow(
        'download scheduler shutting down',
      );
    } finally {
      release();
      await Promise.all([first, second, closing]);
    }
    expect(queuedTask).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(subject.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      total: 0,
    });
  });

  it.each([false, true])(
    'drains a pending limits query on shutdown (failure: %s)',
    async (fails) => {
      let resolve!: (rows: unknown[]) => void;
      let reject!: (error: Error) => void;
      const findMany = vi.fn(
        () =>
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      );
      const subject = new FederationDownloadScheduler({
        db: { query: { systemSetting: { findMany } } },
      } as never);
      const failure = new Error('settings query failed');
      const task = vi.fn();
      const admission = expect(
        subject.schedule(
          'peer',
          'digest',
          task,
          4,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        fails ? failure.message : 'download scheduler shutting down',
      );
      await vi.waitFor(() => expect(findMany).toHaveBeenCalledOnce());
      let closed = false;
      const closing = subject.beforeApplicationShutdown().finally(() => {
        closed = true;
      });
      const drain = fails
        ? expect(closing).rejects.toMatchObject({ errors: [failure] })
        : expect(closing).resolves.toBeUndefined();
      expect(closed).toBe(false);
      subject.invalidateLimits();
      if (fails) reject(failure);
      else resolve([{ key: 'federation:download:globalLimit', value: '1' }]);
      await admission;
      await drain;
      expect(task).not.toHaveBeenCalled();
      expect(findMany).toHaveBeenCalledOnce();
      expect(subject.snapshot().limits.global).toBe(10);
    },
  );

  it('retains all physical cleanup failures after consumers have already left', async () => {
    const subject = scheduler(2, 2);
    const failures = [
      new Error('first cleanup failed'),
      new Error('second cleanup failed'),
    ];
    const controllers = [new AbortController(), new AbortController()];
    const rejects: Array<(error: Error) => void> = [];
    const consumers = controllers.map((controller, i) => {
      const work = subject.schedule(
        'peer',
        `digest-${i}`,
        () =>
          new Promise<void>((_resolve, reject) => {
            rejects[i] = reject;
          }),
        4,
        controller.signal,
      );
      return expect(work).rejects.toThrow('caller stopped');
    });
    await vi.waitFor(() => expect(rejects.filter(Boolean)).toHaveLength(2));
    controllers.forEach((controller) =>
      controller.abort(new Error('caller stopped')),
    );
    await Promise.all(consumers);
    let closed = false;
    const closing = subject.beforeApplicationShutdown().finally(() => {
      closed = true;
    });
    const drain = expect(closing).rejects.toMatchObject({ errors: failures });
    rejects[0](failures[0]);
    await vi.waitFor(() => expect(subject.snapshot().active).toBe(1));
    expect(closed).toBe(false);
    rejects[1](failures[1]);
    await drain;
    expect(subject.snapshot().total).toBe(0);
  });

  it.each(['stop', 'wait'] as const)(
    'reports physical cleanup failure during %s',
    async (command) => {
      const subject = scheduler(2, 2);
      const controller = new AbortController();
      const failure = new Error('writer cleanup failed');
      let rejectWriter!: (error: Error) => void;
      const task = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectWriter = reject;
          }),
      );
      const consumer = subject.schedule(
        'peer.test',
        'digest',
        task,
        4,
        controller.signal,
      );
      const stopped = new Error('consumer stopped');
      const rejected = expect(consumer).rejects.toBe(
        command === 'stop' ? failure : stopped,
      );
      await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
      if (command === 'wait') controller.abort(stopped);
      const draining = expect(
        command === 'stop'
          ? subject.stopDigest('digest')
          : subject.waitForDigest('digest'),
      ).rejects.toMatchObject({
        message: 'download writer cleanup failed',
        errors: [failure],
      });
      rejectWriter(failure);
      await draining;
      await rejected;
      expect(subject.hasDigest('digest')).toBe(false);
    },
  );

  it('stops one shared writer, blocks source replacement until drained, and reports cleanup failure to every consumer', async () => {
    const subject = scheduler(2, 2);
    const failure = new Error('writer cleanup failed');
    let rejectWriter!: (error: Error) => void;
    const first = subject.schedule(
      'first.test',
      'digest',
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWriter = reject;
        }),
      4,
      new AbortController().signal,
    );
    const firstRejected = expect(first).rejects.toBe(failure);
    await vi.waitFor(() => expect(rejectWriter).toBeDefined());
    const replacement = vi.fn(async () => 'replacement');
    const second = subject.schedule(
      'second.test',
      'digest',
      replacement,
      4,
      new AbortController().signal,
    );
    const secondRejected = expect(second).rejects.toBe(failure);
    let settled = false;
    const stop = subject.stopDigest('digest').finally(() => {
      settled = true;
    });
    const rejected = expect(stop).rejects.toMatchObject({ errors: [failure] });
    try {
      expect(settled).toBe(false);
      expect(subject.snapshot().total).toBe(1);
      await expect(
        subject.schedule(
          'third.test',
          'digest',
          replacement,
          4,
          new AbortController().signal,
        ),
      ).rejects.toThrow('download is stopping');
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      rejectWriter(failure);
      await Promise.all([firstRejected, secondRejected, rejected]);
    }
    expect(subject.hasDigest('digest')).toBe(false);
    await expect(
      subject.schedule(
        'third.test',
        'digest',
        replacement,
        4,
        new AbortController().signal,
      ),
    ).resolves.toBe('replacement');
  });

  it('retries a failed limits read on the next admission instead of caching failure', async () => {
    const failure = new Error('configuration database unavailable');
    const findMany = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    const subject = new FederationDownloadScheduler({
      db: { query: { systemSetting: { findMany } } },
    } as never);
    const task = vi.fn().mockResolvedValue('ready');
    await expect(
      subject.schedule(
        'peer.test',
        'digest',
        task,
        4,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(task).not.toHaveBeenCalled();
    expect(subject.snapshot().total).toBe(0);
    await expect(
      subject.schedule(
        'peer.test',
        'digest',
        task,
        4,
        new AbortController().signal,
      ),
    ).resolves.toBe('ready');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('logs background limits refresh failure and permits a later fresh read', async () => {
    const failure = new Error('settings lookup failed');
    const findMany = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    const subject = new FederationDownloadScheduler({
      db: { query: { systemSetting: { findMany } } },
    } as never);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      subject.invalidateLimits();
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledExactlyOnceWith(
          'Could not refresh download concurrency limits',
          failure,
        ),
      );
      await expect(
        subject.schedule(
          'peer.test',
          'digest',
          async () => 'ready',
          4,
          new AbortController().signal,
        ),
      ).resolves.toBe('ready');
      expect(findMany).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it('enforces global and per-peer concurrency', async () => {
    const subject = scheduler(3, 2);
    let active = 0;
    let maxActive = 0;
    const peerActive = new Map<string, number>();
    let maxPeerA = 0;
    const run = (peer: string, digest: string) =>
      subject.schedule(
        peer,
        digest,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const count = (peerActive.get(peer) ?? 0) + 1;
          peerActive.set(peer, count);
          if (peer === 'a.example') maxPeerA = Math.max(maxPeerA, count);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          active -= 1;
          peerActive.set(peer, count - 1);
        },
        undefined,
        new AbortController().signal,
      );

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

  it('shares progress across peers without allowing observers or one consumer to cancel other consumers', async () => {
    const subject = scheduler(2, 1);
    let report!: (value: { received: number; total: number }) => void;
    let release!: () => void;
    let physical!: AbortSignal;
    const firstController = new AbortController();
    const firstProgress = vi.fn();
    const first = subject.schedule(
      'a.test',
      'digest',
      async (notify, signal) => {
        report = notify;
        physical = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'ready';
      },
      4,
      firstController.signal,
      firstProgress,
    );
    const cancelled = expect(first).rejects.toThrow('consumer left');
    await vi.waitFor(() => expect(report).toBeDefined());
    report({ received: 2, total: 4 });
    const secondProgress = vi.fn();
    const unusedSource = vi.fn();
    const second = subject.schedule(
      'b.test',
      'digest',
      unusedSource,
      4,
      new AbortController().signal,
      secondProgress,
    );
    await vi.waitFor(() =>
      expect(secondProgress).toHaveBeenCalledWith({ received: 2, total: 4 }),
    );
    const observed = vi.fn();
    const subscription = subject.observeDigest('digest').subscribe(observed);
    expect(observed).toHaveBeenCalledWith({
      received: 2,
      total: 4,
      status: 'downloading',
      bytesPerSecond: 0,
    });
    subscription.unsubscribe();
    firstController.abort(new Error('consumer left'));
    await cancelled;
    expect(physical.aborted).toBe(false);
    report({ received: 4, total: 4 });
    expect(secondProgress).toHaveBeenLastCalledWith({ received: 4, total: 4 });
    expect(firstProgress).not.toHaveBeenCalledWith({ received: 4, total: 4 });
    expect(unusedSource).not.toHaveBeenCalled();
    release();
    await expect(second).resolves.toBe('ready');
    expect(subject.hasDigest('digest')).toBe(false);
  });

  it('coalesces the same digest across different peers', async () => {
    const subject = scheduler(10, 10);
    const task = vi.fn(async () => 'ok');
    const [a1, a2, b] = await Promise.all([
      subject.schedule(
        'a.example',
        'digest',
        task,
        undefined,
        new AbortController().signal,
      ),
      subject.schedule(
        'a.example',
        'digest',
        task,
        undefined,
        new AbortController().signal,
      ),
      subject.schedule(
        'b.example',
        'digest',
        task,
        undefined,
        new AbortController().signal,
      ),
    ]);
    expect([a1, a2, b]).toEqual(['ok', 'ok', 'ok']);
    expect(task).toHaveBeenCalledTimes(1);
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
      new AbortController().signal,
    );
    const second = subject.schedule(
      'peer',
      'b',
      async () => undefined,
      20,
      new AbortController().signal,
    );
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
      undefined,
      new AbortController().signal,
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

  it('blocks new consumers across peers during stop and suppresses late progress and success', async () => {
    const subject = scheduler(2, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportLate!: () => void;
    const task = vi.fn(async (report) => {
      report({ received: 2, total: 10 });
      reportLate = () => report({ received: 10, total: 10 });
      await gate;
      return 'late success';
    });
    const transfer = subject.schedule(
      'peer',
      'a',
      task,
      10,
      new AbortController().signal,
    );
    const rejected = expect(transfer).rejects.toThrow(
      'stopped by administrator',
    );
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    const stopping = subject.stopDigest('a');
    try {
      reportLate();
      expect(subject.snapshot().list[0].bytesReceived).toBe('2');
      for (const peer of ['peer', 'another-peer']) {
        await expect(
          subject.schedule(
            peer,
            'a',
            async () => 'new',
            undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow('download is stopping');
      }
      await expect(subject.stopDigest('a')).rejects.toThrow(
        'download is stopping',
      );
    } finally {
      release();
      await stopping;
      await rejected;
    }
    await expect(
      subject.schedule(
        'peer',
        'a',
        async () => 'new',
        undefined,
        new AbortController().signal,
      ),
    ).resolves.toBe('new');
  });

  it('rejects joining an aborted writer after its last consumer leaves', async () => {
    const subject = scheduler(1, 1);
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => gate);
    const transfer = subject.schedule('peer', 'a', task, 10, controller.signal);
    const rejected = expect(transfer).rejects.toThrow('consumer stopped');
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    controller.abort(new Error('consumer stopped'));
    await rejected;
    try {
      await expect(
        subject.schedule(
          'peer',
          'a',
          task,
          undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow('download is stopping');
    } finally {
      release();
      await subject.waitForDigest('a');
    }
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
    const transfer = subject.schedule(
      'peer',
      'a',
      task,
      10,
      new AbortController().signal,
    );
    const rejected = expect(transfer).rejects.toThrow(
      'stopped by administrator',
    );
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    await subject.stopDigest('a');
    await rejected;
    await expect(
      subject.schedule(
        'peer',
        'a',
        async () => 'retried',
        undefined,
        new AbortController().signal,
      ),
    ).resolves.toBe('retried');
    expect(subject.snapshot().total).toBe(0);
  });
});
