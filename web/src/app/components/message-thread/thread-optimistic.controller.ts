import type { CbItem, ScrollerApi } from '../../lib/chat-box/chat-box-scroller';
import { uuid } from '../../lib/uuid';
import { messageCreatorKey } from '../../services/model';
import type {
  AlbumImage,
  AuthoredContentType,
  ChatItemData,
  ChatMsgData,
  FileInfo,
} from '../message-cards/chat-item';
import type { MessageThreadSource } from './message-thread-adapter';

export interface OptimisticAuthor {
  account: string;
  name: string;
  domain: string;
  namespaceId: number;
}

/** Owns pending-message identity, insertion, reconciliation and newest-end queuing. */
export class ThreadOptimisticController {
  private scroller?: ScrollerApi<ChatItemData>;
  private source?: MessageThreadSource;
  private queued: CbItem<ChatItemData>[] = [];
  private readonly acceptanceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly allocatePlaceholderId: () => number,
    private readonly onConfirmationTimeout?: (clientMessageId: string) => void,
    private readonly failDetached?: (clientMessageId: string) => void,
  ) {}

  bind(scroller: ScrollerApi<ChatItemData>, source: MessageThreadSource): void {
    this.scroller = scroller;
    this.source = source;
    for (const item of source.acceptedPending?.() ?? []) {
      if (item.clientMessageId)
        this.scheduleAcceptanceTimeout(item.clientMessageId, item, source);
    }
  }

  reset(): void {
    for (const timer of this.acceptanceTimers.values()) clearTimeout(timer);
    this.acceptanceTimers.clear();
    this.queued = [];
    this.scroller = undefined;
    this.source = undefined;
  }

  newClientMessageId(): string {
    return uuid();
  }

  makeItem(
    clientMessageId: string,
    author: OptimisticAuthor,
    isGroupConversation: boolean,
    text: string,
    contentType: AuthoredContentType,
    images: AlbumImage[] | null,
    file: FileInfo | null,
  ): CbItem<ChatMsgData> {
    const now = new Date();
    const placeholderId = this.allocatePlaceholderId();
    const stampedImages =
      images?.map((image) => ({ ...image, msgId: placeholderId })) ?? null;
    return {
      id: placeholderId,
      clientMessageId,
      data: {
        type: 'msg',
        msgId: placeholderId,
        creator: messageCreatorKey({
          account: author.account,
          namespaceId: author.namespaceId,
        }),
        isSelf: true,
        isGroupConversation,
        name: author.name,
        text,
        time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        contentType,
        images: stampedImages,
        file,
        createdAtMs: now.getTime(),
        status: 'sending',
        kind: 'pending',
      },
    };
  }

  dispatch(item: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller) return;
    if (scroller.getInfo().noNewer) this.insert(item);
    else {
      this.queued.push(item);
      scroller.scrollToBottom();
    }
  }

  drainAtNewest(noNewer: boolean): void {
    if (!noNewer || this.queued.length === 0) return;
    const queued = this.queued;
    this.queued = [];
    for (const item of queued) this.insert(item);
  }

  register(item: CbItem<ChatItemData>): void {
    this.source?.addPending(item);
  }

  cancel(clientMessageId: string): boolean {
    const source = this.source;
    const scroller = this.scroller;
    if (!source || !scroller) return false;
    const item = source.pendingByClientMessageId(clientMessageId);
    if (!item || !source.discardPending(clientMessageId)) return false;
    this.clearAcceptanceTimer(clientMessageId);
    scroller.removeItem(item.id);
    return true;
  }

  async fail(item: CbItem<ChatItemData>): Promise<void> {
    const clientMessageId = item.clientMessageId;
    if (clientMessageId === undefined) return;
    if (
      !this.source ||
      !this.scroller ||
      !this.source.pendingByClientMessageId(clientMessageId)
    ) {
      this.failDetached?.(clientMessageId);
      return;
    }
    this.clearAcceptanceTimer(clientMessageId);
    if (this.source.failPending(clientMessageId))
      await this.scroller.reconcilePending();
  }

  async accept(item: CbItem<ChatItemData>): Promise<boolean> {
    const clientMessageId = item.clientMessageId;
    if (!this.source || !this.scroller || clientMessageId === undefined)
      return false;
    const source = this.source;
    const scroller = this.scroller;
    if (!this.source.markPendingAccepted(clientMessageId)) return false;
    await scroller.reconcilePending();
    if (this.source !== source || this.scroller !== scroller) return true;
    this.scheduleAcceptanceTimeout(clientMessageId, item, source);
    return true;
  }

  private scheduleAcceptanceTimeout(
    clientMessageId: string,
    item: CbItem<ChatItemData>,
    source: MessageThreadSource,
  ): void {
    this.clearAcceptanceTimer(clientMessageId);
    // HTTP acceptance is not a delivery echo. If the feed never confirms it, keep the original
    // clientMessageId retryable instead of leaving an un-cancellable spinner forever.
    this.acceptanceTimers.set(
      clientMessageId,
      setTimeout(() => {
        this.acceptanceTimers.delete(clientMessageId);
        if (
          this.source !== source ||
          source.pendingByClientMessageId(clientMessageId)?.data.status !==
            'accepted'
        )
          return;
        void this.fail(item).then(() => {
          if (
            this.source === source &&
            source.pendingByClientMessageId(clientMessageId)?.data.status ===
              'failed'
          )
            this.onConfirmationTimeout?.(clientMessageId);
        });
      }, 45_000),
    );
  }

  async beginRetry(
    clientMessageId: string,
  ): Promise<CbItem<ChatItemData> | undefined> {
    if (!this.source || !this.scroller) return undefined;
    this.clearAcceptanceTimer(clientMessageId);
    const item = this.source.retryPending(clientMessageId);
    if (!item) return undefined;
    await this.scroller.reconcilePending();
    return item;
  }

  private clearAcceptanceTimer(clientMessageId: string): void {
    const timer = this.acceptanceTimers.get(clientMessageId);
    if (timer) clearTimeout(timer);
    this.acceptanceTimers.delete(clientMessageId);
  }

  private insert(item: CbItem<ChatItemData>): boolean {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source) return false;
    source.addPending(item);
    const afterId = scroller.getInfo().newestId ?? -1;
    const inserted = scroller.insertAfter(afterId, item, { optimistic: true });
    if (inserted) scroller.scrollToBottom();
    return inserted;
  }
}
