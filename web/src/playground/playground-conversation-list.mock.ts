import { computed, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  ConversationItem,
  GroupConversationItem,
  GroupThreadPatch,
  P2PConversationItem,
} from '../app/services/model';
import type { ConversationListService } from '../app/services/conversation-list.service';
import type { ThreadNotificationUpdate } from '../app/services/thread-notification';
import { ConversationLoadStatus } from '../app/services/thread-store.service';

type ConversationMetaPatch = Partial<
  Omit<P2PConversationItem, 'type' | 'peerUser' | 'group'> &
    Omit<GroupConversationItem, 'type' | 'peerUser' | 'group'>
>;

/** In-memory implementation of the production conversation-list facade. */
@Injectable({ providedIn: 'root' })
export class PlaygroundConversationList
  implements Pick<ConversationListService, keyof ConversationListService>
{
  private readonly conversations = signal<readonly ConversationItem[]>([]);
  readonly items = computed(() =>
    this.conversations()
      .map((item) => ({
        ...item,
        threadFeedId: item.threadFeedId ?? item.threadId,
      }))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
          b.threadId - a.threadId,
      ),
  );
  readonly navigationReady = signal(true);
  readonly status = signal(ConversationLoadStatus.READY);
  readonly error = signal('');
  readonly openThreadId = signal<number | undefined>(undefined);
  readonly current = computed(() =>
    this.conversations().find((item) => item.threadId === this.openThreadId()),
  );
  readonly threadSeq$ = new Subject<{ threadId: number; seq: number }>();
  readonly threadNotifications$ = new Subject<ThreadNotificationUpdate[]>();

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

  applyGroupUpdate(
    threadId: number,
    patch: GroupThreadPatch,
  ): void {
    this.conversations.update((items) =>
      items.map((item) => {
        if (item.threadId !== threadId || item.type !== 'GROUP') return item;
        const next = { ...item };
        if (patch.role !== undefined) next.role = patch.role;
        if (patch.profile) next.profile = { ...item.profile, ...patch.profile };
        if (patch.meta) next.meta = { ...item.meta, ...patch.meta };
        return next;
      }),
    );
  }

  latestSeq(threadId: number): number | undefined {
    return (
      this.conversations().find((item) => item.threadId === threadId)
        ?.messageEndSeq ?? undefined
    );
  }

  unreadEntryBoundary(): undefined {
    return undefined;
  }

  previewUnreadEntryBoundary(): undefined {
    return undefined;
  }
  captureUnreadEntryBoundary(): undefined {
    return undefined;
  }
  resetUnreadEntryBoundary(): void {}

  markReadStable(): void {}
  flushRead(): void {}
  markJoinRequestsReadLocally(threadId: number, feedId: number): void {
    const thread = this.items().find((item) => item.threadId === threadId);
    if (thread?.type !== 'GROUP' || thread.joinRequestReadFeedId === -1) return;
    this.patch(threadId, {
      joinRequestReadFeedId: Math.max(
        thread.joinRequestReadFeedId ?? 0,
        Math.min(feedId, thread.joinRequestEndFeedId ?? 0),
      ),
    });
  }

  markAnnouncementReadLocally(threadId: number, feedId: number): void {
    const thread = this.items().find((item) => item.threadId === threadId);
    if (thread?.type !== 'GROUP') return;
    this.patch(threadId, {
      announcementReadFeedId: Math.max(
        thread.announcementReadFeedId ?? 0,
        Math.min(feedId, Number(thread.meta.announcementFeedId ?? 0)),
      ),
    });
  }
  confirmThreadAlias(
    result: Parameters<ConversationListService['confirmThreadAlias']>[0],
  ): void {
    this.patch(result.threadId, { alias: result.alias });
  }

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
