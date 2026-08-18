import { computed, Injectable, signal } from '@angular/core';
import type { ConversationItem } from '../app/services/model';

/**
 * Small in-memory conversation-list facade for the standalone playground.
 *
 * The production header and profile panel deliberately communicate through
 * ConversationListService. Keeping that contract here makes their optimistic
 * mute/pin/alias state observable instead of leaving the demo input detached.
 */
@Injectable({ providedIn: 'root' })
export class PlaygroundConversationList {
  readonly current = signal<ConversationItem | undefined>(undefined);
  private readonly related = signal<readonly ConversationItem[]>([]);
  readonly items = computed(() => {
    const item = this.current();
    return [
      ...(item ? [item] : []),
      ...this.related().filter((candidate) => candidate.threadId !== item?.threadId),
    ];
  });
  readonly openThreadId = computed(() => this.current()?.threadId);

  setConversation(item: ConversationItem): void {
    this.current.set({ ...item });
  }

  setRelatedConversations(items: readonly ConversationItem[]): void {
    this.related.set(items.map((item) => ({ ...item })));
  }

  applyThreadMeta(
    threadId: number,
    patch: Partial<ConversationItem>,
  ): void {
    this.current.update((item) =>
      item?.threadId === threadId ? ({ ...item, ...patch } as ConversationItem) : item,
    );
  }

  updatePeerUser(threadId: number, peerUser: ConversationItem['peerUser']): void {
    this.applyThreadMeta(threadId, { peerUser });
  }

  latestSeq(): number | undefined {
    return this.current()?.lastMessageSeq ?? undefined;
  }

  unreadEntryBoundary(): undefined {
    return undefined;
  }

  markReadStable(): void {}
  flushRead(): void {}
  load(): void {}

  async removeThread(threadId: number): Promise<void> {
    if (this.current()?.threadId === threadId) this.current.set(undefined);
  }
}
