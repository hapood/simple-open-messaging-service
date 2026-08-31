import { computed, signal } from '@angular/core';
import type {
  CbScrollInfo,
  ScrollerApi,
} from '../../lib/chat-box/chat-box-scroller';
import { UNREAD_DIVIDER_HEIGHT_PX } from '../../lib/sticky-date';
import type { ChatItemData } from '../message-cards/chat-item';
import { isMessageViewportAtBottom } from './message-scroll-state';

/** Owns viewport-derived thread state and the frozen unread-entry boundary. */
export class ThreadScrollController {
  readonly atBottom = signal(true);
  readonly newMessageCount = signal(0);
  readonly unreadBoundaryAbove = signal(false);
  readonly mountedMessageCount = signal(0);
  readonly newMessageLabel = computed(() => {
    const count = this.newMessageCount();
    return count > 99 ? '99+' : String(count);
  });

  private unreadSeq: number | null = null;
  private needsUnreadReanchor = false;

  get firstUnreadSeq(): number | null {
    return this.unreadSeq;
  }

  open(firstUnreadSeq: number | null): void {
    this.unreadSeq = firstUnreadSeq;
    this.needsUnreadReanchor = false;
  }

  markUnreadReanchorNeeded(): void {
    this.needsUnreadReanchor = true;
  }

  noteNewerAvailable(): void {
    if (!this.atBottom()) this.newMessageCount.update((count) => count + 1);
  }

  update(
    info: CbScrollInfo,
    scroller: ScrollerApi<ChatItemData> | undefined,
  ): number | null {
    const atVisibleBottom = isMessageViewportAtBottom(info);
    this.atBottom.set(atVisibleBottom);
    if (atVisibleBottom) this.newMessageCount.set(0);
    this.mountedMessageCount.set(info.mounted);
    this.updateUnreadBoundary(info, scroller);

    const unread = this.unreadSeq;
    if (
      this.needsUnreadReanchor &&
      unread !== null &&
      info.oldestId !== null &&
      info.newestId !== null &&
      info.oldestId <= unread &&
      unread <= info.newestId
    ) {
      this.needsUnreadReanchor = false;
      return unread;
    }
    return null;
  }

  reset(): void {
    this.unreadSeq = null;
    this.needsUnreadReanchor = false;
    this.unreadBoundaryAbove.set(false);
    this.mountedMessageCount.set(0);
    this.atBottom.set(true);
    this.newMessageCount.set(0);
  }

  private updateUnreadBoundary(
    info: CbScrollInfo,
    scroller: ScrollerApi<ChatItemData> | undefined,
  ): void {
    const target = this.unreadSeq;
    if (target === null || !scroller) {
      this.unreadBoundaryAbove.set(false);
      return;
    }
    const geometry = scroller.getMountedGeometry(target);
    if (geometry?.el.classList.contains('cb-unread-entry')) {
      this.unreadBoundaryAbove.set(geometry.top + UNREAD_DIVIDER_HEIGHT_PX < 8);
      return;
    }
    this.unreadBoundaryAbove.set(
      info.oldestId !== null && info.oldestId > target,
    );
  }
}
