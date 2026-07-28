import { Injectable } from '@angular/core';
import type { CbItem } from '../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../components/message-cards/chat-item';

/**
 * Application-scoped, memory-only optimistic-send outbox.
 *
 * A HttpItemSource is recreated whenever its thread view is recreated. Keeping pending sends here,
 * keyed by threadId, lets the new source remount the same optimistic bubbles without introducing
 * IndexedDB/native persistence. The server-confirmed Message remains the durable truth; this store
 * only survives for the lifetime of the current JavaScript application.
 */
@Injectable({ providedIn: 'root' })
export class ThreadSendOutbox {
  private readonly byThread = new Map<number, CbItem<ChatItemData>[]>();
  private nextPlaceholderId = -1;

  /** Return the live array owned by this outbox. HttpItemSource is the sole mutator. */
  forThread(threadId: number): CbItem<ChatItemData>[] {
    let pending = this.byThread.get(threadId);
    if (!pending) {
      pending = [];
      this.byThread.set(threadId, pending);
    }
    return pending;
  }

  /** Allocate an application-wide synthetic id that cannot collide across restored thread sources. */
  allocatePlaceholderId(): number {
    return this.nextPlaceholderId--;
  }

  /** Drop the empty thread bucket once all optimistic sends have been confirmed or discarded. */
  releaseIfEmpty(threadId: number): void {
    if (this.byThread.get(threadId)?.length === 0)
      this.byThread.delete(threadId);
  }

  /** Session teardown hook; intentionally does not persist anything across a JavaScript restart. */
  clear(): void {
    this.byThread.clear();
    this.nextPlaceholderId = -1;
  }
}
