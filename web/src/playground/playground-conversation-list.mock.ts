import { computed, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  ConversationItem,
  P2PConversationItem,
  User,
} from '../app/services/model';
import { ConversationLoadStatus } from '../app/services/thread-store.service';

type ConversationMetaPatch = Partial<
  Omit<P2PConversationItem, 'type' | 'peerUser' | 'group'>
>;

/** In-memory implementation of the production conversation-list facade. */
@Injectable({ providedIn: 'root' })
export class PlaygroundConversationList {
  private readonly conversations = signal<readonly ConversationItem[]>([]);
  readonly items = computed(() => this.conversations());
  readonly status = signal(ConversationLoadStatus.READY);
  readonly error = signal<string | null>(null);
  readonly openThreadId = signal<number | undefined>(undefined);
  readonly current = computed(() =>
    this.conversations().find((item) => item.threadId === this.openThreadId()),
  );
  readonly threadSeq$ = new Subject<unknown>();
  readonly threadNotifications$ = new Subject<unknown>();

  setConversation(item: ConversationItem): void {
    this.upsert(item);
    this.open(item.threadId);
  }

  setRelatedConversations(items: readonly ConversationItem[]): void {
    for (const item of items) this.upsert(item);
  }

  open(threadId: number): void {
    this.openThreadId.set(threadId);
  }

  close(): void {
    this.openThreadId.set(undefined);
  }

  load(): void {
    this.status.set(ConversationLoadStatus.READY);
  }

  refreshAfterMutation(): Promise<void> {
    return Promise.resolve();
  }

  refreshBackgroundThreadFeed(_userId: number): Promise<void> {
    return Promise.resolve();
  }

  applyThreadMeta(threadId: number, patch: ConversationMetaPatch): void {
    this.patch(threadId, patch);
  }

  updatePeerUser(threadId: number, peerUser: User): void {
    this.conversations.update((items) =>
      items.map((item) =>
        item.threadId === threadId && item.type === 'P2P'
          ? { ...item, peerUser }
          : item,
      ),
    );
  }

  applyGroupUpdate(
    threadId: number,
    patch: Partial<NonNullable<ConversationItem['group']>>,
  ): void {
    this.conversations.update((items) =>
      items.map((item) =>
        item.threadId === threadId && item.type === 'GROUP'
          ? { ...item, group: { ...item.group, ...patch } }
          : item,
      ),
    );
  }

  latestSeq(threadId: number): number | undefined {
    return (
      this.conversations().find((item) => item.threadId === threadId)
        ?.lastMessageSeq ?? undefined
    );
  }

  unreadEntryBoundary(): undefined {
    return undefined;
  }

  markReadStable(): void {}
  flushRead(): void {}
  markJoinRequestsReadLocally(): void {}
  confirmThreadAlias(): void {}

  async removeThread(threadId: number): Promise<void> {
    this.conversations.update((items) =>
      items.filter((item) => item.threadId !== threadId),
    );
    if (this.openThreadId() === threadId) this.close();
  }

  private upsert(item: ConversationItem): void {
    this.conversations.update((items) => {
      const index = items.findIndex(
        (candidate) => candidate.threadId === item.threadId,
      );
      if (index < 0) return [...items, { ...item }];
      return items.map((candidate, candidateIndex) =>
        candidateIndex === index ? { ...item } : candidate,
      );
    });
  }

  private patch(threadId: number, patch: ConversationMetaPatch): void {
    this.conversations.update((items) =>
      items.map((item) =>
        item.threadId === threadId ? { ...item, ...patch } : item,
      ),
    );
  }
}
