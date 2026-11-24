import { describe, expect, it } from 'vitest';
import {
  HistoryIntervalEventsService,
  type HistoryIntervalEvent,
} from './history-interval-events.service.js';

function collect(
  service: HistoryIntervalEventsService,
  threadId: number,
  left: number,
  right: number,
) {
  const received: HistoryIntervalEvent[] = [];
  const subscription = service
    .observe(threadId, left, right)
    .subscribe((event) => received.push(event));
  return { received, subscription };
}

describe('HistoryIntervalEventsService', () => {
  it('delivers a committed interval only to overlapping thread observers', () => {
    const service = new HistoryIntervalEventsService(100);
    const overlapping = collect(service, 7, 90, 110);
    const otherThread = collect(service, 8, 90, 110);
    const adjacent = collect(service, 7, 110, 130);

    service.publishCommitted({ threadId: 7, left: 100, right: 105 });

    expect(overlapping.received).toEqual([
      { threadId: 7, left: 100, right: 105 },
    ]);
    expect(otherThread.received).toEqual([]);
    expect(adjacent.received).toEqual([]);
  });

  it('treats left as exclusive and right as inclusive', () => {
    const service = new HistoryIntervalEventsService(100);
    const before = collect(service, 7, 90, 100);
    const after = collect(service, 7, 100, 120);

    service.publishCommitted({ threadId: 7, left: 99, right: 100 });
    service.publishCommitted({ threadId: 7, left: 100, right: 101 });

    expect(before.received).toEqual([{ threadId: 7, left: 99, right: 100 }]);
    expect(after.received).toEqual([{ threadId: 7, left: 100, right: 101 }]);
  });

  it('releases a listener on unsubscribe and keeps the others', () => {
    const service = new HistoryIntervalEventsService(100);
    const first = collect(service, 7, 90, 110);
    const second = collect(service, 7, 90, 110);

    first.subscription.unsubscribe();
    expect(service.hasObservers(7)).toBe(true);
    service.publishCommitted({ threadId: 7, left: 95, right: 100 });
    expect(first.received).toEqual([]);
    expect(second.received).toHaveLength(1);

    second.subscription.unsubscribe();
    expect(service.hasObservers(7)).toBe(false);
  });

  it('rejects invalid intervals at both ends of the boundary', () => {
    const service = new HistoryIntervalEventsService(100);
    expect(() => service.observe(7, 100, 100)).toThrow(
      'history interval requires',
    );
    expect(() =>
      service.publishCommitted({ threadId: 7, left: 0, right: 0 }),
    ).toThrow('history interval requires');
    expect(() =>
      service.publishCommitted({ threadId: 0, left: 0, right: 1 }),
    ).toThrow('history interval requires');
  });
});
