import { describe, expect, it, vi } from 'vitest';
import { HistoryIntervalEventsService } from './history-interval-events.service.js';
import { HistoryIntervalService } from './history-interval.service.js';

interface SchedulingRow {
  peerDomain: string;
  namespaceId: number;
  namespaceActive: boolean;
  authorityNamespaceId: number;
  threadType: string;
  roundsEnabled: boolean;
  gapStartSeq: number | null;
  gapEndSeq: number | null;
  gapMessageSeqOffset: number | null;
  gapRecoverable: boolean | null;
}

const overlappingGap: SchedulingRow = {
  peerDomain: 'peer.example',
  namespaceId: 7,
  namespaceActive: true,
  authorityNamespaceId: 7,
  threadType: 'P2P',
  roundsEnabled: true,
  gapStartSeq: 1,
  gapEndSeq: 200,
  gapMessageSeqOffset: 0,
  gapRecoverable: true,
};

const viewer = {
  clearedSeq: null as number | null,
  currentEnd: 200,
  visibleThroughSeq: null as number | null,
  blocked: false,
  threadType: 'P2P',
};

function setup(rows: SchedulingRow[] = [overlappingGap]) {
  const scope = vi.fn().mockResolvedValue([viewer]);
  const gaps = vi.fn().mockResolvedValue(rows);
  const select = vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({
        where: scope,
        innerJoin: () => ({ where: gaps }),
      }),
    }),
  }));
  const events = new HistoryIntervalEventsService(100);
  const wake = vi.fn().mockResolvedValue(undefined);
  const service = new HistoryIntervalService(
    { db: { select } } as never,
    events,
    { onWake: wake } as never,
  );
  return { service, events, wake, scope, gaps, select };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('HistoryIntervalService', () => {
  it('emits the mounted interval immediately and wakes reverse for an overlapping gap', async () => {
    const { service, wake, events, scope } = setup();
    const received: unknown[] = [];
    scope.mockImplementation(async () => {
      expect(events.hasObservers(2)).toBe(true);
      return [viewer];
    });
    const subscription = (await service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 90, right: 110 }]);
    expect(wake).toHaveBeenCalledWith({
      threadId: 2,
      namespaceId: 7,
      mode: 'thread',
    });
    subscription.unsubscribe();
    expect(events.hasObservers(2)).toBe(false);
  });

  it('does no query or scheduling until subscribed', async () => {
    const s = setup();
    await s.service.open(1, 2, 90, 110);
    expect(s.select).not.toHaveBeenCalled();
    expect(s.events.hasObservers(2)).toBe(false);
    expect(s.wake).not.toHaveBeenCalled();
  });

  it.each([
    { ...overlappingGap, gapStartSeq: 201, gapEndSeq: 300 },
    { ...overlappingGap, roundsEnabled: false },
    { ...overlappingGap, gapRecoverable: false },
    {
      ...overlappingGap,
      gapStartSeq: null,
      gapEndSeq: null,
      gapMessageSeqOffset: null,
      gapRecoverable: null,
    },
  ])(
    'does not wake reverse for a non-intersecting or unavailable gap: %j',
    async (row) => {
      const s = setup([row]);
      const subscription = (await s.service.open(1, 2, 90, 110)).subscribe();
      await flush();
      expect(s.wake).not.toHaveBeenCalled();
      subscription.unsubscribe();
    },
  );

  it('converts inclusive publisher gap coordinates using their local offset', async () => {
    const s = setup([
      {
        ...overlappingGap,
        gapStartSeq: 1,
        gapEndSeq: 10,
        gapMessageSeqOffset: 100,
      },
    ]);
    const adjacent = (await s.service.open(1, 2, 90, 100)).subscribe();
    await flush();
    expect(s.wake).not.toHaveBeenCalled();
    const overlapping = (await s.service.open(1, 2, 100, 101)).subscribe();
    await flush();
    expect(s.wake).toHaveBeenCalledExactlyOnceWith({
      threadId: 2,
      namespaceId: 7,
      mode: 'thread',
    });
    adjacent.unsubscribe();
    overlapping.unsubscribe();
  });

  it('uses each intersecting gap source even for a P2P thread with local authority', async () => {
    const s = setup([
      { ...overlappingGap, authorityNamespaceId: 0 },
      { ...overlappingGap, authorityNamespaceId: 0, gapStartSeq: 101 },
      {
        ...overlappingGap,
        authorityNamespaceId: 0,
        namespaceId: 8,
        peerDomain: 'other.example',
      },
    ]);
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe();
    await flush();
    expect(s.wake.mock.calls).toEqual([
      [
        {
          threadId: 2,
          namespaceId: 7,
          mode: 'thread',
        },
      ],
      [
        {
          threadId: 2,
          namespaceId: 8,
          mode: 'thread',
        },
      ],
    ]);
    subscription.unsubscribe();
  });

  it.each([
    { ...overlappingGap, namespaceId: 0 },
    { ...overlappingGap, namespaceActive: false },
    { ...overlappingGap, threadType: 'GROUP', authorityNamespaceId: 0 },
    { ...overlappingGap, threadType: 'GROUP', authorityNamespaceId: 8 },
  ])(
    'does not reverse local, inactive, or non-authority group sources: %j',
    async (row) => {
      const s = setup([row]);
      const subscription = (await s.service.open(1, 2, 90, 110)).subscribe();
      await flush();
      expect(s.wake).not.toHaveBeenCalled();
      subscription.unsubscribe();
    },
  );

  it('wakes a group mirror authority gap', async () => {
    const s = setup([{ ...overlappingGap, threadType: 'GROUP' }]);
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe();
    await flush();
    expect(s.wake).toHaveBeenCalledExactlyOnceWith({
      threadId: 2,
      namespaceId: 7,
      mode: 'thread',
    });
    subscription.unsubscribe();
  });

  it('matches history-page visibility for a blocked P2P viewer', async () => {
    const s = setup();
    s.scope.mockResolvedValue([
      { ...viewer, blocked: true, visibleThroughSeq: 105 },
    ]);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 90, right: 105 }]);
    subscription.unsubscribe();
  });

  it('keeps an authorized empty-tail spinner subscribed until a first page commits', async () => {
    const s = setup();
    s.scope.mockResolvedValue([{ ...viewer, currentEnd: 0 }]);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 0, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    expect(subscription.closed).toBe(false);
    expect(s.events.hasObservers(2)).toBe(true);
    expect(received).toEqual([]);
    expect(s.gaps).not.toHaveBeenCalled();
    s.scope.mockResolvedValue([{ ...viewer, currentEnd: 110 }]);
    s.events.publishCommitted({ threadId: 2, left: 60, right: 110 });
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 60, right: 110 }]);
    subscription.unsubscribe();
  });

  it('forwards only overlapping committed intervals after clipping to subscription bounds', async () => {
    const { service, events, scope } = setup();
    const received: unknown[] = [];
    const subscription = (await service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    received.length = 0;
    events.publishCommitted({ threadId: 2, left: 100, right: 150 });
    await flush();
    expect(scope).toHaveBeenCalledTimes(2);
    expect(received).toEqual([{ threadId: 2, left: 100, right: 110 }]);
    events.publishCommitted({ threadId: 2, left: 110, right: 120 });
    await flush();
    expect(received).toHaveLength(1);
    expect(scope).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('clips the initial frame to retained history and current viewer visibility', async () => {
    const s = setup();
    s.scope.mockResolvedValue([
      { ...viewer, clearedSeq: 95, visibleThroughSeq: 105 },
    ]);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 95, right: 105 }]);
    subscription.unsubscribe();
  });

  it('clips to the current local thread end even with an unbounded viewer', async () => {
    const s = setup();
    s.scope.mockResolvedValue([{ ...viewer, currentEnd: 100 }]);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 90, right: 100 }]);
    subscription.unsubscribe();
  });

  it('does not schedule a gap outside the clipped viewer interval', async () => {
    const s = setup([{ ...overlappingGap, gapStartSeq: 106 }]);
    s.scope.mockResolvedValue([{ ...viewer, visibleThroughSeq: 105 }]);
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe();
    await flush();
    expect(s.wake).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('revalidates frozen departure and clear boundaries for every notification', async () => {
    const s = setup();
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    received.length = 0;
    s.scope.mockResolvedValue([
      { ...viewer, clearedSeq: 95, visibleThroughSeq: 105 },
    ]);
    s.events.publishCommitted({ threadId: 2, left: 90, right: 120 });
    s.events.publishCommitted({ threadId: 2, left: 105, right: 110 });
    await flush();
    expect(received).toEqual([{ threadId: 2, left: 95, right: 105 }]);
    subscription.unsubscribe();
  });

  it.each([
    { scope: [] },
    { scope: [{ ...viewer, visibleThroughSeq: 90 }] },
    { scope: [{ ...viewer, clearedSeq: 110 }] },
  ])(
    'closes without leaking coordinates when access disappears: %j',
    async ({ scope }) => {
      const s = setup();
      const received: unknown[] = [];
      const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
        (event) => received.push(event),
      );
      await flush();
      received.length = 0;
      s.scope.mockResolvedValue(scope);
      s.events.publishCommitted({ threadId: 2, left: 100, right: 105 });
      await flush();
      expect(subscription.closed).toBe(true);
      expect(received).toEqual([]);
      expect(s.events.hasObservers(2)).toBe(false);
    },
  );

  it('revalidates access lost between controller authorization and subscription', async () => {
    const s = setup();
    const stream = await s.service.open(1, 2, 90, 110);
    s.scope.mockResolvedValue([]);
    const received: unknown[] = [];
    const subscription = stream.subscribe((event) => received.push(event));
    await flush();
    expect(received).toEqual([]);
    expect(subscription.closed).toBe(true);
    expect(s.gaps).not.toHaveBeenCalled();
    expect(s.wake).not.toHaveBeenCalled();
  });

  it('retains commits arriving during the initial visibility read and gap query', async () => {
    const s = setup();
    const initial = deferred<(typeof viewer)[]>();
    const gaps = deferred<SchedulingRow[]>();
    s.scope.mockReturnValueOnce(initial.promise);
    s.gaps.mockReturnValueOnce(gaps.promise);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    s.events.publishCommitted({ threadId: 2, left: 100, right: 105 });
    initial.resolve([viewer]);
    await flush();
    s.events.publishCommitted({ threadId: 2, left: 95, right: 100 });
    gaps.resolve([overlappingGap]);
    await flush();
    expect(received).toEqual([
      { threadId: 2, left: 90, right: 110 },
      { threadId: 2, left: 100, right: 105 },
      { threadId: 2, left: 95, right: 100 },
    ]);
    subscription.unsubscribe();
  });

  it('releases listeners and suppresses pending scheduling on disconnect', async () => {
    const s = setup();
    const gaps = deferred<SchedulingRow[]>();
    s.gaps.mockReturnValueOnce(gaps.promise);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    await flush();
    received.length = 0;
    subscription.unsubscribe();
    gaps.resolve([overlappingGap]);
    s.events.publishCommitted({ threadId: 2, left: 100, right: 105 });
    await flush();
    expect(received).toEqual([]);
    expect(s.wake).not.toHaveBeenCalled();
    expect(s.events.hasObservers(2)).toBe(false);
  });

  it('discards an in-flight visibility result after disconnect', async () => {
    const s = setup();
    const scope = deferred<(typeof viewer)[]>();
    s.scope.mockReturnValueOnce(scope.promise);
    const received: unknown[] = [];
    const subscription = (await s.service.open(1, 2, 90, 110)).subscribe(
      (event) => received.push(event),
    );
    subscription.unsubscribe();
    scope.resolve([viewer]);
    await flush();
    expect(received).toEqual([]);
    expect(s.gaps).not.toHaveBeenCalled();
    expect(s.wake).not.toHaveBeenCalled();
    expect(s.events.hasObservers(2)).toBe(false);
  });

  it('releases demand on database failure without publishing unchecked coordinates', async () => {
    const s = setup();
    const failure = new Error('query failed');
    s.scope.mockRejectedValueOnce(failure);
    const error = vi.fn();
    const next = vi.fn();
    (await s.service.open(1, 2, 90, 110)).subscribe({ next, error });
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(failure);
    expect(s.events.hasObservers(2)).toBe(false);
  });
});
