import { Injectable, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';

export const MAX_HISTORY_INTERVAL_SUBSCRIPTIONS = 100;

export class HistoryIntervalEvictedError extends Error {
  constructor() {
    super('history interval subscription evicted due to global capacity limit');
    this.name = 'HistoryIntervalEvictedError';
  }
}

/** One committed local interval. Bounds are `Message.seq` values and the
 *  interval is left-exclusive/right-inclusive, `(left, right]`. */
export interface HistoryIntervalEvent {
  threadId: number;
  left: number;
  right: number;
}

type HistoryIntervalListener = (event: HistoryIntervalEvent) => void;

interface ActiveSubscription {
  threadId: number;
  listener: HistoryIntervalListener;
  evict: () => void;
}

/**
 * Process-local fan-out for committed reverse-history pages.
 *
 * Enforces a process-wide capacity of 100 active subscriptions with oldest-first
 * eviction. No message payload crosses this boundary: clients reread their local database.
 */
@Injectable()
export class HistoryIntervalEventsService {
  private readonly listeners = new Map<number, Set<HistoryIntervalListener>>();
  private readonly active = new Set<ActiveSubscription>();
  private readonly maxSubscriptions: number;

  constructor(@Optional() maxSubscriptions = MAX_HISTORY_INTERVAL_SUBSCRIPTIONS) {
    if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1) {
      throw new Error('maxSubscriptions must be a positive safe integer');
    }
    this.maxSubscriptions = maxSubscriptions;
  }

  observe(
    threadId: number,
    left: number,
    right: number,
  ): Observable<HistoryIntervalEvent> {
    assertHistoryInterval({ threadId, left, right });
    return new Observable<HistoryIntervalEvent>((sink) => {
      const listener: HistoryIntervalListener = (event) => {
        if (!sink.closed && overlaps({ left, right }, event)) sink.next(event);
      };
      const cleanup = () => {
        this.active.delete(entry);
        const current = this.listeners.get(threadId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) this.listeners.delete(threadId);
      };
      const entry: ActiveSubscription = {
        threadId,
        listener,
        evict: () => {
          cleanup();
          if (!sink.closed) sink.error(new HistoryIntervalEvictedError());
        },
      };
      while (this.active.size >= this.maxSubscriptions) {
        const oldest = this.active.values().next().value;
        if (!oldest) break;
        oldest.evict();
      }
      let threadListeners = this.listeners.get(threadId);
      if (!threadListeners) {
        threadListeners = new Set();
        this.listeners.set(threadId, threadListeners);
      }
      threadListeners.add(listener);
      this.active.add(entry);
      return cleanup;
    });
  }

  /** Publish one committed local reverse-page interval to overlapping observers. */
  publishCommitted(event: HistoryIntervalEvent): void {
    assertHistoryInterval(event);
    const threadListeners = this.listeners.get(event.threadId);
    if (!threadListeners) return;
    for (const listener of [...threadListeners]) listener(event);
  }

  /** Whether any mounted interval still observes this thread. */
  hasObservers(threadId: number): boolean {
    return (this.listeners.get(threadId)?.size ?? 0) > 0;
  }

  activeCount(): number {
    return this.active.size;
  }
}

function overlaps(
  subscription: { left: number; right: number },
  event: { left: number; right: number },
): boolean {
  // Both intervals are open on the left and closed on the right.
  return subscription.left < event.right && event.left < subscription.right;
}

function assertHistoryInterval(event: HistoryIntervalEvent): void {
  if (
    !Number.isSafeInteger(event.threadId) ||
    event.threadId < 1 ||
    !Number.isSafeInteger(event.left) ||
    event.left < 0 ||
    !Number.isSafeInteger(event.right) ||
    event.right <= event.left
  ) {
    throw new Error(
      'history interval requires a positive threadId and 0 <= left < right',
    );
  }
}
