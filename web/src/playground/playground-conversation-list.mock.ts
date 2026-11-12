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
import { ConversationLoadStatus } from '../app/services/conversation-load-status';
import { mergeThreadItems } from '../app/services/thread-list-order';

type ConversationMetaPatch = Partial<
  Omit<P2PConversationItem, 'type' | 'peerUser' | 'group'> &
    Omit<GroupConversationItem, 'type' | 'peerUser' | 'group'>
>;

/** In-memory implementation of the production conversation-list facade.
 *  Row ordering is maintained incrementally through the production merge
 *  (thread-list-order.ts): feed-derived updates reposition only the changed
 *  row, while local read/display progress replaces rows in place. */
@Injectable({ providedIn: 'root' })
export class PlaygroundConversationList
  implements Pick<ConversationListService, keyof ConversationListService>
{
  private readonly conversations = signal<ConversationItem[]>([]);
  private feedId = 0;
  /** Every row enters through upsert(), which always assigns the feed id. */
  readonly items = computed<(ConversationItem & { threadFeedId: number })[]>(
    () =>
      this.conversations() as (ConversationItem & { threadFeedId: number })[],
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

  applyGroupUpdate(threadId: number, patch: GroupThreadPatch): void {
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

  /** Viewport-dwelled read progress mirrors the production store: attention
   *  clears in place and never advances the feed ordering key. */
  markReadStable(threadId: number, seq: number): void {
    const thread = this.conversations().find(
      (item) => item.threadId === threadId,
    );
    if (!thread) return;
    this.patch(
      threadId,
      {
        unreadCount: 0,
        mentionUnread: [],
        lastReadSeq: Math.max(thread.lastReadSeq ?? 0, seq),
      },
      { bumpFeed: false },
    );
  }
  flushRead(): void {}
  markJoinRequestsReadLocally(threadId: number, feedId: number): void {
    const thread = this.items().find((item) => item.threadId === threadId);
    if (thread?.type !== 'GROUP' || thread.joinRequestReadFeedId === -1) return;
    this.patch(
      threadId,
      {
        joinRequestReadFeedId: Math.max(
          thread.joinRequestReadFeedId ?? 0,
          Math.min(feedId, thread.joinRequestEndFeedId ?? 0),
        ),
      },
      { bumpFeed: false },
    );
  }

  markAnnouncementReadLocally(threadId: number, feedId: number): void {
    const thread = this.items().find((item) => item.threadId === threadId);
    if (thread?.type !== 'GROUP') return;
    this.patch(
      threadId,
      {
        announcementReadFeedId: Math.max(
          thread.announcementReadFeedId ?? 0,
          Math.min(feedId, Number(thread.meta.announcementFeedId ?? 0)),
        ),
      },
      { bumpFeed: false },
    );
  }
  confirmThreadAlias(
    result: Parameters<ConversationListService['confirmThreadAlias']>[0],
  ): void {
    // Alias confirmation is display state in production: applied in place.
    this.patch(result.threadId, { alias: result.alias }, { bumpFeed: false });
  }

  async removeThread(threadId: number): Promise<void> {
    this.conversations.update((items) =>
      items.filter((item) => item.threadId !== threadId),
    );
    if (this.openThreadId() === threadId) this.close();
  }

  private upsert(item: ConversationItem): void {
    // Upserts play the role of a committed feed page: the row carries a fresh
    // feed id and repositions incrementally through the production merge.
    const committed = { ...item, threadFeedId: ++this.feedId };
    this.conversations.update((items) => mergeThreadItems(items, [committed]));
  }

  private patch(
    threadId: number,
    patch: ConversationMetaPatch,
    options?: { bumpFeed?: boolean },
  ): void {
    const bumpFeed = options?.bumpFeed !== false;
    const effective: ConversationMetaPatch = {
      ...patch,
      ...(bumpFeed ? { threadFeedId: ++this.feedId } : {}),
      ...(patch.pinned === true && patch.pinnedAt === undefined
        ? { pinnedAt: Date.now() }
        : {}),
    };
    this.conversations.update((items) => {
      const index = items.findIndex(
        (candidate) => candidate.threadId === threadId,
      );
      if (index === -1) return items;
      const changed = { ...items[index], ...effective };
      if (!bumpFeed) {
        // Read/display progress mirrors the production store: replace in place.
        const next = items.slice();
        next[index] = changed;
        return next;
      }
      // Feed-derived activity repositions only the changed row.
      return mergeThreadItems(items, [changed]);
    });
  }
}
