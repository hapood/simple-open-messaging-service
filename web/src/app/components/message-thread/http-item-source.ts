/**
 * HttpItemSource — production data source implementing CbSource<ChatItemData> (absorbs the old
 * ChatThreadController).
 *
 * Owns DB cursor pagination (oldestMsgId/newestMsgId) + SSE. Returns one timeline item per durable
 * live message slot; persistent deletion markers never enter the timeline. Album merging is a presentation decision
 * done by the kernel's `mergeItems` hook (per batch, before createItem). Date separators are likewise
 * derived by the createItem render layer based on adjacent messages crossing a day boundary (see
 * message-cards/date-format.ts).
 *
 * [Cursor] getOlder(cursorId, count) pages older via a lastId cursor (desc → ascending); getNewer pages
 *  newer (already ascending). cursorId is the msgId of the kernel window's boundary item. Returns
 *  ascending raw messages (CbItem.id = msgId).
 * [Boundary] Reaching the DB floor (hasMore=false) → out[0] (ascending head = oldest) tagged 'oldest';
 *  anchor = latest → out[last] tagged 'newest'. The kernel's absorbBoundary reads these and sets its
 *  noOlder/noNewer.
 * [Dedup] incoming pushes are identity-only signals; message bodies have a single authoritative path through
 *  the repository history walker. This source therefore does not suppress queried ids. Cursor paging keeps pages disjoint,
 *  while the kernel rejects overlap with rows that are currently mounted.
 * A durable THREAD_CONTENT_HEAD advances the repository-owned per-thread newer ceiling and re-checks this viewport's
 *  pending newer demand. It never asks the kernel to retry; the kernel only observes a demand resolving
 *  with actual items.
 */
import {
  firstValueFrom,
  take,
  filter,
  Observable,
  type Subscriber,
  type Subscription,
} from 'rxjs';
import {
  CancellationScope,
  awaitAbortable,
  firstValueFromAbortable,
} from '../../lib/async/cancellation-scope';
import dayjs from 'dayjs';
import {
  MessageRepository,
  type MessageHistorySourceItem,
  type NativeMessageHistoryDemand,
  type NativeMessageHistoryResult,
} from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { messageAuthorAvatarProfile } from '../../services/avatar-profile-ref';
import { messageAuthorProfileDemand } from '../../services/profile-demand';
import { unevidencedProfileDemand } from '../../../../../shared/profile-demand';
import { MsgService } from '../../services/message.service';
import {
  messageCreatorKey,
  parseUserIdentityKey,
  type Message,
  type ConversationItem,
} from '../../services/model';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  CbDemand,
  CbDemandResult,
  CbSource,
  CbSourceInitOpts,
} from '../../lib/chat-box/cb-source';
import type {
  AlbumMedia,
  ChatItemData,
  ChatMsgData,
  FileInfo,
  MediaStatus,
} from '../message-cards/chat-item';
import {
  contextualLinkContent,
  contextualMediaUrl,
  parseAudioContent,
  parseFileContent,
  parseGalleryContent,
  parseImageContent,
  parseVideoContent,
} from '../message-cards/media-content';
import {
  toDisplayText,
  toRenderMessageEntities,
  selfMentionIdentity,
} from '../../lib/message-entity';
import { requireTextMessageContent } from '../../../../../shared/text-message-content';
import { parseClientMessageQuote } from '../../../../../shared/client-message-quote';
import { deriveMessagePreview } from '../../../../../shared/message-preview';
import { isTauri } from '../../services/runtime';
import type { HistoryAnchor } from '../../services/history-anchor';

/**
 * Backend QueryMessagesDto enforces @Max(50) per request — the source owns this ceiling so the kernel's
 * batch tuning (initBatch etc.) can stay a pure UI concern and never produce a "take must be at most 50"
 * rejection. When the kernel asks for more than MAX_PAGE (e.g. initBatch), the source returns one page
 * and the kernel's normal top-up (balance/getOlder) fetches the rest on demand.
 */
const MAX_PAGE = 50;

class MessagePageLoadError extends Error {
  constructor() {
    super('message page load failed; edge remains retryable');
    this.name = 'MessagePageLoadError';
  }
}

export interface HttpItemSourceLiveOpts {
  onQuoteDeleted?: (replySeq: number, targetSeq: number) => void;
  onQuoteUpdated?: (replySeq: number, quote: ChatMsgData['quote']) => void;
  /** Presentation-only notice for the unread/new-message badge. It never invokes a kernel load or retry. */
  onNewerAvailable?: (seq: number) => void;
  /** A mediaStatus change landed for this thread through the shared availability service — the
   *  kernel re-renders that one card in place via updateItemData (height-neutral). */
  onMediaStatus?: (seq: number, status: MediaStatus) => void;
}

export class HttpItemSource implements CbSource<ChatItemData> {
  private readonly lifetime = new CancellationScope();
  private bindingSignal?: AbortSignal;
  private detachBindingAbort?: () => void;
  private readonly deletedQuoteSeqs = new Set<number>();
  private readonly repliesByQuote = new Map<number, Set<number>>();
  private deletedSub?: Subscription;
  private quoteDbSub?: Subscription;
  private readonly mountedQuotes = new Map<
    number,
    { quote: NonNullable<ChatMsgData['quote']>; version: number }
  >();
  private readonly onQuoteUpdated: NonNullable<
    HttpItemSourceLiveOpts['onQuoteUpdated']
  >;
  private noOlder = false;
  private noNewer = true; // anchor is the latest; always true (SSE pushes one way only)

  private readonly profiles = new Map<
    string,
    {
      name: string;
      account: string;
      isSelf: boolean;
      avatarIdentityId?: string;
    }
  >();
  /** In-flight optimistic sends, held separately from the reloadable sequence (mirrors MockItemSource.pending).
   *  Each entry's id === its clientMessageId. On confirm (a real whose clientMessageId matches) the entry is
   *  dropped by reconcilePending inside init/getNewer, and the kernel's reconcileOptimistic removes the mounted
   *  optimistic bubble. The array is owned by the application-scoped ThreadSendOutbox, so failed/in-flight
   *  entries survive destruction and recreation of this thread source. */
  private readonly pending: CbItem<ChatMsgData>[];
  private sseSub?: Subscription;
  private reconnectSub?: Subscription;
  private livePaused = false;
  private mediaStatusSub?: Subscription;
  private readonly onMediaStatus: (seq: number, status: MediaStatus) => void;
  private readonly onNewerAvailable: (seq: number) => void;
  private readonly seqsByCreator = new Map<string, Set<number>>();
  private readonly profilesBySeq = new Map<
    number,
    {
      name: string;
      account: string;
      isSelf: boolean;
      avatarIdentityId: string;
    }
  >();
  private initializingDb = true;
  private loadedSeq = -1;
  private notifiedNewestSeq = -1;
  /** Newer-edge demands are long-lived: at the current newest they remain pending until a real item exists. */
  private readonly newerWaiters = new Set<{
    cursorId: number;
    count: number;
    subscriber: Subscriber<CbDemandResult<ChatItemData>>;
  }>();
  private pumpingNewer = false;
  private newerPumpVersion = 0;
  /** Gap rows use a source-lifetime synthetic id namespace far below optimistic ids. Directional
   * repository cursors are resolved from the canonical interval instead of overloading CbItem.id. */
  private nextGapItemId = Number.MIN_SAFE_INTEGER + 1;
  private readonly gapIdByKey = new Map<string, number>();
  private readonly gapById = new Map<
    number,
    {
      left: number;
      right: number;
      state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    }
  >();

  constructor(
    private readonly conv: ConversationItem,
    private readonly repo: MessageRepository,
    private readonly userService: UserService,
    private readonly outbox: ThreadSendOutbox,
    live: HttpItemSourceLiveOpts,
    private readonly messages: MsgService,
    private readonly profileRepo?: ProfileRepository,
  ) {
    this.pending = outbox.forThread(conv.threadId);
    this.onQuoteUpdated = live.onQuoteUpdated ?? (() => {});
    this.quoteDbSub = repo.slotsChanged$
      .pipe(filter((threadId) => threadId === conv.threadId))
      .subscribe(() => {
        for (const [seq, entry] of this.mountedQuotes) {
          if (!entry.quote.body)
            void this.refreshMountedQuote(seq).catch(() => {});
        }
      });
    this.deletedSub = repo.deletedLive$
      .pipe(filter((event) => event.threadId === conv.threadId))
      .subscribe(({ deletions }) => {
        for (const { seq } of deletions) {
          this.deletedQuoteSeqs.add(seq);
          for (const replySeq of this.repliesByQuote.get(seq) ?? []) {
            live.onQuoteDeleted?.(replySeq, seq);
          }
          for (const item of this.pending) {
            if (item.data.quote?.seq !== seq) continue;
            // Erase the preview. A jump can still resolve an ephemeral mounted
            // notice; after it is unmounted the deleted target is unavailable.
            item.data.quote = { seq };
            live.onQuoteDeleted?.(item.id, seq);
          }
        }
      });
    this.onMediaStatus = live.onMediaStatus ?? (() => {});
    this.onNewerAvailable = live.onNewerAvailable ?? (() => {});
    // MessageRepository turns committed content heads into per-thread live signals.
    // The kernel's subsequent getNewer is the single message-body path (IDB cache hit or backend gap-fill).
    // Filter to THIS thread. Multiple mounted sources share the repository's thread state while keeping
    // their viewport demand/cancellation lifecycle independent.
    this.resumeLiveUpdates();
    // Shared mediaStatus changes → re-render that one card
    // in place via updateItemData. Height-neutral (the overlay/meta slot never change the cell height).
    this.mediaStatusSub = repo.mediaStatusLive$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => this.onMediaStatus(s.seq, s.status));
  }

  /** Stop this chatbox's live mounts while the app is hidden. Account-level thread-feed
   * synchronization remains active; the pending newer demand is resumed from its cursor. */
  pauseLiveUpdates(): void {
    this.livePaused = true;
    this.sseSub?.unsubscribe();
    this.sseSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
  }

  resumeLiveUpdates(latestSeq?: number): void {
    if (this.lifetime.signal.aborted) return;
    if (this.sseSub) {
      this.refreshLatest(latestSeq);
      return;
    }
    this.livePaused = false;
    this.sseSub = this.repo.historyHead$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => {
        this.noteNewerAvailable(s.seq);
        this.requestNewerPump();
      });
    this.reconnectSub = this.repo.reconnectSignal$.subscribe(() =>
      this.requestNewerPump(),
    );
    this.refreshLatest(latestSeq);
  }

  /** Opening and resuming reuse the same history lane; they never change the viewport anchor. */
  refreshLatest(latestSeq?: number): void {
    if (this.lifetime.signal.aborted) return;
    const target = Math.max(
      this.repo.newestKnownSeq(this.conv.threadId),
      latestSeq ?? 0,
    );
    this.repo.retainNewestSeq(this.conv.threadId, target);
    this.noteNewerAvailable(target);
    this.requestNewerPump();
  }

  private noteNewerAvailable(seq: number): void {
    if (
      this.initializingDb ||
      this.livePaused ||
      seq <= Math.max(0, this.loadedSeq, this.notifiedNewestSeq)
    )
      return;
    // Retaining a ceiling can synchronously emit historyHead$. Repeated entry and
    // resume must wake demand, but must not count the same head as another arrival.
    this.notifiedNewestSeq = seq;
    this.onNewerAvailable(seq);
  }

  /**
   * Initialize / re-anchor:
   *  - anchorId === -1: take the latest `olderCount` messages (desc, reversed to ascending); the anchor
   *    is the newest (noNewer=true; SSE pushes one way only).
   *  - otherwise (a real msgId): fetch both directions — older (desc, skip:0, includes anchorId) +
   *    newer (asc, skip:1, excludes anchorId), merged into ascending order; noOlder/noNewer are set from
   *    each direction's hasMore (a middle window leaves both false → scrolling up/down can still reach the
   *    global edges).
   * Returns ascending raw messages; the global oldest/newest carry a boundary flag.
   */
  mountQuote(
    replySeq: number,
    quote: NonNullable<ChatMsgData['quote']>,
  ): () => void {
    const entry = { quote, version: 0 };
    this.mountedQuotes.set(replySeq, entry);
    // The DB listener is already active. Re-read after registration to cover
    // any commit between initial construction and mounting the reply.
    void this.refreshMountedQuote(replySeq).catch(() => {});
    return () => {
      if (this.mountedQuotes.get(replySeq) === entry)
        this.mountedQuotes.delete(replySeq);
    };
  }

  private async refreshMountedQuote(replySeq: number): Promise<void> {
    const entry = this.mountedQuotes.get(replySeq);
    if (!entry) return;
    const version = ++entry.version;
    let quote = entry.quote;
    const anchor = quote.anchor;
    if (anchor?.kind === 'origin') {
      const target = await this.wait(
        this.repo.getMessageByOrigin(
          this.conv.threadId,
          anchor.namespaceId,
          anchor.originSeq,
        ),
      );
      if (target)
        quote = {
          anchor,
          seq: target.seq,
          body: deriveMessagePreview(
            target.contentType,
            target.content,
            toDisplayText,
          ),
        };
    }
    if (quote.seq !== undefined) {
      const seq = quote.seq;
      const replies = this.repliesByQuote.get(seq) ?? new Set<number>();
      replies.add(replySeq);
      this.repliesByQuote.set(seq, replies);
      const deleted = await this.wait(
        this.repo.getMessageDeletions(this.conv.threadId, [seq]),
      );
      if (deleted.length || this.deletedQuoteSeqs.has(seq))
        // Keep only a local jump coordinate for a possible mounted notice;
        // never re-resolve an erased preview through its origin.
        quote = { seq };
    }
    if (this.mountedQuotes.get(replySeq) !== entry || entry.version !== version)
      return;
    if (entry.quote.seq === quote.seq && entry.quote.body === quote.body)
      return;
    entry.quote = quote;
    this.onQuoteUpdated(replySeq, quote);
  }

  async resolveHistoryAnchor(
    anchor: HistoryAnchor,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const request = new CancellationScope(this.lifetime.signal, signal);
    try {
      request.signal.throwIfAborted();
      return await awaitAbortable(
        this.repo.resolveHistoryAnchor(
          this.conv.threadId,
          anchor,
          request.signal,
        ),
        request.signal,
      );
    } finally {
      request.dispose();
    }
  }

  async init(
    anchorId: number,
    olderCount: number,
    newerCount: number,
    _opts?: CbSourceInitOpts,
  ): Promise<CbItem<ChatItemData>[]> {
    if (_opts?.signal && this.bindingSignal !== _opts.signal) {
      this.detachBindingAbort?.();
      const signal = _opts.signal;
      this.bindingSignal = signal;
      const abort = () => this.destroy();
      signal.addEventListener('abort', abort, { once: true });
      this.detachBindingAbort = () =>
        signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
    this.lifetime.signal.throwIfAborted();
    const result = await this.queryHistory(
      anchorId === -1
        ? {
            kind: this.initializingDb ? 'localLatest' : 'latest',
            count: Math.min(olderCount, MAX_PAGE),
          }
        : {
            kind: 'around',
            anchor: anchorId,
            olderCount: Math.min(olderCount, MAX_PAGE),
            newerCount: Math.min(newerCount, MAX_PAGE),
          },
    );
    if (result.failed) throw new MessagePageLoadError();
    const items = await this.wait(this.historyItemsToCb(result.items));
    this.noOlder = !result.hasOlder;
    this.noNewer = !result.hasNewer;
    this.applyBoundaries(items);
    this.reconcilePending(items);
    return items;
  }

  /** Drop any in-flight optimistic (pending) entry whose clientMessageId matches a returned real — its confirm arrived.
   *  Mirrors the kernel's mounted-entry reconcile; keeps this.pending in sync so the kernel's elevatePending doesn't
   *  re-mount an already-confirmed send as a stale optimistic bubble. Must run in EVERY method that returns reals —
   *  init AND getNewer: the kernel routes an empty-thread confirm through init(-1) (loadNewer's no-real-cursor fallback). */
  private reconcilePending(reals: CbItem<ChatItemData>[]): void {
    for (const r of reals) {
      if (r.clientMessageId === undefined) continue;
      const pi = this.pending.findIndex(
        (p) => p.clientMessageId === r.clientMessageId,
      );
      if (pi >= 0) {
        this.pending.splice(pi, 1);
        this.outbox.releaseResource(r.clientMessageId);
      }
    }
    this.outbox.releaseIfEmpty(this.conv.threadId);
  }

  /** Fetch `count` messages older than cursorId (desc, then reversed to ascending). out[0] is tagged
   *  'oldest' when the DB floor is reached. */
  async getOlder(
    cursorId: number,
    count: number,
  ): Promise<CbItem<ChatItemData>[]> {
    if (this.lifetime.signal.aborted) return [];
    if (this.noOlder) return [];
    const take = Math.min(count, MAX_PAGE);
    const result = await this.queryHistory({
      kind: 'older',
      before: (this.gapById.get(cursorId)?.left ?? cursorId - 1) + 1,
      count: take,
    });
    if (result.failed) throw new MessagePageLoadError();
    const items = await this.wait(this.historyItemsToCb(result.items));
    this.noOlder = !result.hasOlder;
    if (this.noOlder && items.length > 0)
      items[0] = { ...items[0], boundary: 'oldest' };
    return items;
  }

  /** Fetch `count` messages newer than cursorId (already ascending). The active source demand decides whether the
   * returned range satisfies its requested count; at the current newest it remains pending until SSE/cache updates make
   * progress possible. */
  async getNewer(
    cursorId: number,
    count: number,
  ): Promise<CbItem<ChatItemData>[]> {
    const take = Math.min(count, MAX_PAGE);
    const result = await this.queryHistory({
      kind: 'newer',
      after: this.gapById.get(cursorId)?.right ?? cursorId,
      count: take,
    });
    if (result.failed) throw new MessagePageLoadError();
    const items = await this.wait(this.historyItemsToCb(result.items));
    this.noNewer = !result.hasNewer;
    if (this.noNewer && items.length > 0)
      items[items.length - 1] = {
        ...items[items.length - 1],
        boundary: 'newest',
      };
    this.reconcilePending(items);
    return items;
  }

  requestOlder(cursorId: number, count: number): CbDemand<ChatItemData> {
    return sourceDemand(async () => {
      const items = await this.getOlder(cursorId, count);
      return items.length > 0 ? { kind: 'items', items } : { kind: 'boundary' };
    });
  }

  requestNewer(cursorId: number, count: number): CbDemand<ChatItemData> {
    return new Observable((subscriber) => {
      if (this.lifetime.signal.aborted) {
        subscriber.complete();
        return;
      }
      const waiter = { cursorId, count, subscriber };
      this.newerWaiters.add(waiter);
      this.requestNewerPump();
      return () => {
        this.newerWaiters.delete(waiter);
      };
    });
  }

  private async pumpNewerWaiters(): Promise<void> {
    if (
      this.lifetime.signal.aborted ||
      this.pumpingNewer ||
      this.initializingDb ||
      this.livePaused ||
      this.newerWaiters.size === 0
    )
      return;
    this.pumpingNewer = true;
    const pumpVersion = this.newerPumpVersion;
    try {
      // The viewport owns at most one newer demand. Keep the loop general so a future second consumer
      // shares the same source contract without changing the completion semantics.
      for (const waiter of [...this.newerWaiters]) {
        if (this.livePaused) break; // finish the current request, but start no new one
        if (!this.newerWaiters.has(waiter)) continue;
        try {
          const items =
            waiter.cursorId === -1
              ? await this.init(-1, waiter.count, 0)
              : await this.getNewer(waiter.cursorId, waiter.count);
          if (!this.newerWaiters.has(waiter) || items.length === 0) continue;
          this.newerWaiters.delete(waiter);
          waiter.subscriber.next({ kind: 'items', items });
          waiter.subscriber.complete();
        } catch (error) {
          if (!this.newerWaiters.delete(waiter)) continue;
          waiter.subscriber.next({ kind: 'error', error });
          waiter.subscriber.complete();
        }
      }
    } finally {
      this.pumpingNewer = false;
      if (!this.livePaused && this.newerPumpVersion !== pumpVersion)
        void this.pumpNewerWaiters();
    }
  }

  private requestNewerPump(): void {
    if (this.lifetime.signal.aborted) return;
    this.newerPumpVersion++;
    if (!this.initializingDb && !this.livePaused) void this.pumpNewerWaiters();
  }

  /** Production SSE data is cached by {@link MessageRepository}; its update event pumps active source demands. The
   * explicit push entry point is therefore a no-op for this repository-backed implementation. */
  pushLive(_rawItems: CbItem<ChatItemData>[]): void {
    /* signal-only: no cache */
  }

  /** In-flight optimistic sends that own a message bubble (defensive copy). Non-audio attachments
   * stay in the outbox for retry/SSE reconciliation, but their aggregate transfer card is their sole
   * pending UI, including after a pane remount. */
  getPending(): CbItem<ChatItemData>[] {
    return this.pending.filter((item) => {
      if (
        item.data.quote?.seq !== undefined &&
        this.deletedQuoteSeqs.has(item.data.quote.seq)
      ) {
        item.data.quote = { seq: item.data.quote.seq };
      }
      if (item.data.type !== 'msg') return true;
      if (item.data.contentType === 'AUDIO' && item.clientMessageId) {
        const resource = this.outbox.resource(item.clientMessageId);
        if (resource?.type === 'voice' || resource?.type === 'native-voice')
          return true;
      }
      return !(
        item.data.status !== 'failed' &&
        (item.data.contentType === 'IMAGE' ||
          item.data.contentType === 'VIDEO' ||
          item.data.contentType === 'FILE' ||
          item.data.contentType === 'AUDIO' ||
          item.data.contentType === 'GALLERY')
      );
    });
  }

  acceptedPending(): CbItem<ChatItemData>[] {
    return this.pending.filter((item) => item.data.status === 'accepted');
  }

  async restoreMediaStages(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    let response;
    try {
      response = await firstValueFromAbortable(
        this.messages.queryMediaStages(this.conv.threadId),
        this.lifetime.signal,
      );
    } catch {
      return;
    }
    this.lifetime.signal.throwIfAborted();
    if (response.code !== 0 || !Array.isArray(response.data)) return;
    const profile = this.userService.sessionProfile();
    if (!profile) return;
    for (const stage of response.data) {
      if (
        this.pending.some(
          (item) => item.clientMessageId === stage.clientMessageId,
        )
      )
        continue;
      this.pending.push(
        this.mediaStageToFailedItem(stage, {
          account: profile.account,
          name: profile.name,
          namespaceId: profile.namespaceId,
        }),
      );
    }
  }

  private mediaStageToFailedItem(
    stage: {
      clientMessageId: string;
      contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
      createdAt: number;
    },
    author: {
      account: string;
      name: string;
      namespaceId: number;
    },
  ): CbItem<ChatMsgData> {
    const createdAtMs = Number(stage.createdAt) || Date.now();
    const date = new Date(createdAtMs);
    const msgId = this.outbox.allocatePlaceholderId();
    const base = {
      type: 'msg' as const,
      msgId,
      creator: messageCreatorKey(author),
      isSelf: true,
      isGroupConversation: this.conv.type === 'GROUP',
      name: author.name,
      text: '',
      time: `${String(date.getHours()).padStart(2, '0')}:${String(
        date.getMinutes(),
      ).padStart(2, '0')}`,
      createdAtMs,
      status: 'failed' as const,
      images: null,
      file: null,
    };
    const failedMedia = {
      kind: 'file' as const,
      src: '',
      w: 1,
      h: 1,
      name: 'Unfinished upload',
      size: 0,
      mimeType: 'application/octet-stream',
      msgId,
      status: 'failed' as MediaStatus,
    };
    const data: ChatMsgData =
      stage.contentType === 'FILE'
        ? {
            ...base,
            contentType: 'FILE',
            file: {
              url: '',
              name: 'Unfinished upload',
              size: 0,
              mimeType: 'application/octet-stream',
            },
          }
        : {
            ...base,
            contentType: stage.contentType,
            images: [failedMedia],
            mediaStatus: 'failed',
          };
    return {
      id: msgId,
      clientMessageId: stage.clientMessageId,
      data,
    };
  }

  /** Store an in-flight optimistic send (separate from the reloadable sequence). */
  addPending(item: CbItem<ChatItemData>): void {
    if (item.data.serverGap)
      throw new Error('server gap cannot enter the optimistic outbox');
    this.pending.push(item as CbItem<ChatMsgData>);
  }

  /** Look up an outbox entry even when it is intentionally omitted from getPending() presentation. */
  pendingByClientMessageId(
    clientMessageId: string,
  ): CbItem<ChatMsgData> | undefined {
    return this.pending.find(
      (item) => item.clientMessageId === clientMessageId,
    );
  }

  /**
   * Mark an in-flight optimistic send FAILED and sink it to the END of the pending queue. The source owns
   * pending order/status; the kernel's reconcilePending re-reads getPending and reflects this (in-place
   * status morph sending→failed + FLIP reorder to the tail). The entry STAYS in `pending` — a failed send is
   * still unconfirmed, not abandoned — so it remains mountable at the newest edge and the failure survives a
   * remount. Stable identity: the SAME clientMessageId (and data.msgId) is kept, so the row's retry output
   * (which emits data.msgId = the clientMessageId) stays a valid retry key. Returns false if no pending
   * entry matches the clientMessageId (e.g. the confirm already arrived and dropped it).
   */
  failPending(clientMessageId: string): boolean {
    return this.outbox.failPending(clientMessageId);
  }

  /**
   * Flip a failed send BACK to 'sending' (a retry) at its CURRENT position (the end), keeping the SAME
   * clientMessageId — stable identity lets the kernel morph the bubble in place (failed→sending) instead of
   * remounting it, and the subsequent confirm reconciles by this same clientMessageId. A NEW data ref carries
   * status:'sending'. Returns the updated item (the caller re-issues the HTTP send with it), or undefined if no
   * pending entry matches (e.g. it was confirmed/dropped meanwhile).
   */
  retryPending(clientMessageId: string): CbItem<ChatMsgData> | undefined {
    const i = this.pending.findIndex(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (i < 0) return undefined;
    const retrying: CbItem<ChatMsgData> = {
      ...this.pending[i],
      data: { ...this.pending[i].data, status: 'sending', kind: 'pending' },
    };
    this.pending[i] = retrying; // stay at the current position (the end)
    return retrying;
  }

  /** Permanently discard a failed optimistic send after explicit user confirmation/action. */
  discardPending(clientMessageId: string): boolean {
    if (!this.pending.some((item) => item.clientMessageId === clientMessageId))
      return false;
    this.outbox.discardPending(clientMessageId);
    void firstValueFrom(this.messages.cancelUploadBatch(clientMessageId)).catch(
      () => undefined,
    );
    return true;
  }

  /** Mark HTTP/upload acceptance without claiming delivery. The entry stays pending at its current position and
   * keeps a spinner, but `accepted` removes cancellation/dimming. Only the push echo advances it to `sent`. */
  markPendingAccepted(clientMessageId: string): boolean {
    const i = this.pending.findIndex(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (i < 0) return false;
    const entry = this.pending[i];
    this.pending[i] = {
      ...entry,
      data: { ...entry.data, status: 'accepted', kind: undefined },
    }; // stay at the current position
    return true;
  }

  destroy(): void {
    if (this.lifetime.signal.aborted) return;
    this.detachBindingAbort?.();
    this.detachBindingAbort = undefined;
    this.bindingSignal = undefined;
    this.lifetime.cancel();
    this.livePaused = true;
    this.quoteDbSub?.unsubscribe();
    this.quoteDbSub = undefined;
    this.mountedQuotes.clear();
    this.deletedSub?.unsubscribe();
    this.deletedSub = undefined;
    this.sseSub?.unsubscribe();
    this.sseSub = undefined;
    this.mediaStatusSub?.unsubscribe();
    this.mediaStatusSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
    for (const waiter of this.newerWaiters) waiter.subscriber.complete();
    this.newerWaiters.clear();
    this.gapIdByKey.clear();
    this.gapById.clear();
    this.profiles.clear();
    this.profilesBySeq.clear();
    this.seqsByCreator.clear();
    this.repliesByQuote.clear();
    this.deletedQuoteSeqs.clear();
  }

  /**
   * Leave the DB-only phase after the scroller has initialized, then reconcile the durable conversation
   * metadata and the live-session HWM against the newest message actually loaded from the local DB.
   *
   * `persistedLatestSeq` is the server-authored `ConversationItem.messageEndSeq` stored with the thread
   * row. It is deliberately independent from the messages cache: after a fresh install, storage migration,
   * or cache eviction the thread can truthfully say "latest = 258" while the local messages table is empty.
   * `liveLatestSeq` covers a newer content head observed after that thread snapshot. Whichever is greater is
   * the remote target; if it leads `loadedSeq`, wake history demand without changing the reading anchor.
   */
  finishLocalInit(
    liveLatestSeq: number | undefined,
    persistedLatestSeq: number = 0,
  ): void {
    if (this.lifetime.signal.aborted) return;
    this.initializingDb = false;
    this.refreshLatest(Math.max(liveLatestSeq ?? 0, persistedLatestSeq));
  }

  // ---------- rawToItems (shape every queried message + per-msg parsing; no album merging — that is the kernel's mergeItems job) ----------

  private async rawToItems(msgs: Message[]): Promise<CbItem<ChatItemData>[]> {
    this.lifetime.signal.throwIfAborted();
    const quoteSeqs = new Set<number>();
    const quotes = new Map<number, ChatMsgData['quote']>();
    for (const message of msgs) {
      const reference = parseClientMessageQuote(message.content);
      if (!reference) continue;
      const target = await this.wait(
        this.repo.getMessageByOrigin(
          this.conv.threadId,
          reference.namespaceId,
          reference.originSeq,
        ),
      );
      const anchor: HistoryAnchor = { kind: 'origin', ...reference };
      quotes.set(message.seq, {
        anchor,
        ...(target
          ? {
              seq: target.seq,
              body: deriveMessagePreview(
                target.contentType,
                target.content,
                toDisplayText,
              ),
            }
          : {}),
      });
      if (!target) continue;
      quoteSeqs.add(target.seq);
      const replies = this.repliesByQuote.get(target.seq) ?? new Set<number>();
      replies.add(message.seq);
      this.repliesByQuote.set(target.seq, replies);
    }
    for (const item of this.pending) {
      if (item.data.quote?.seq !== undefined)
        quoteSeqs.add(item.data.quote.seq);
    }
    await this.wait(this.ensureProfiles(msgs));
    if (quoteSeqs.size) {
      for (const { seq } of await this.wait(
        this.repo.getMessageDeletions(this.conv.threadId, [...quoteSeqs]),
      )) {
        this.deletedQuoteSeqs.add(seq);
      }
    }
    const out: CbItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = m.seq;
      const resolveMediaUrl = (item: Record<string, unknown>) =>
        contextualMediaUrl(item, m.threadId, id);
      if (id > this.loadedSeq) this.loadedSeq = id;
      const creatorKey = this.creatorKey(m.creator);
      if (creatorKey !== null) {
        let creatorSeqs = this.seqsByCreator.get(creatorKey);
        if (!creatorSeqs) {
          creatorSeqs = new Set<number>();
          this.seqsByCreator.set(creatorKey, creatorSeqs);
        }
        creatorSeqs.add(id);
      }
      // Each IMAGE/VIDEO/AUDIO message → a single-element media array (carrying its own msgId); consecutive
      // same-creator IMAGE/VIDEO are merged into an album by the kernel's mergeItems (AUDIO stays standalone).
      let images: AlbumMedia[] | null = null;
      if (m.contentType === 'IMAGE') {
        images = [
          {
            ...parseImageContent(m.content, resolveMediaUrl),
            msgId: id,
            status: m.mediaStatus,
          },
        ];
      } else if (m.contentType === 'VIDEO') {
        const v = parseVideoContent(m.content, resolveMediaUrl);
        if (v) images = [{ ...v, msgId: id, status: m.mediaStatus }];
      } else if (m.contentType === 'AUDIO') {
        const a = parseAudioContent(m.content, resolveMediaUrl);
        if (a) images = [{ ...a, msgId: id, status: m.mediaStatus }];
      } else if (m.contentType === 'GALLERY') {
        images = parseGalleryContent(m.content, resolveMediaUrl).map(
          (media) => ({
            ...media,
            msgId: id,
            status: m.mediaStatus,
          }),
        );
      }
      // FILE message → the attachment metadata parsed from content JSON (url/name/size/mimeType).
      const file: FileInfo | null =
        m.contentType === 'FILE'
          ? parseFileContent(m.content, resolveMediaUrl)
          : null;
      // Surface the clientMessageId so the kernel can pair this server-confirmed real with the optimistic
      // bubble that shares it (mountNewerReals flags resortTarget by clientMessageId; reconcileOptimistic then
      // removes the optimistic duplicate). Without this the optimistic would never be reconciled away → two
      // bubbles. Backend serializeBody ships clientMessageId on the wire (no DTO whitelisting).
      const item: CbItem<ChatMsgData> = {
        id,
        data: { ...this.toMsgData(m, images, file), quote: quotes.get(m.seq) },
      };
      if (
        item.data.quote?.seq !== undefined &&
        this.deletedQuoteSeqs.has(item.data.quote.seq)
      ) {
        item.data.quote = { seq: item.data.quote.seq };
      }
      if (m.clientMessageId) {
        item.clientMessageId = m.clientMessageId;
        // Single-trigger "lock" on the real side: the spinner→check→fade choreography plays on THIS real only when
        // Push echo is the sole owner of the spinner→check choreography. HTTP success only changes the optimistic
        // entry to `accepted` (spinner remains, cancel disappears), so any matching pending entry means this fresh
        // server row must carry `sent`. History / incoming rows without a pending match carry no delivery tick.
        const pending = this.pending.find(
          (p) => p.clientMessageId === m.clientMessageId,
        );
        if (pending) item.data = { ...item.data, status: 'sent' };
      }
      out.push(item);
    }
    return out;
  }

  private async historyItemsToCb(
    sourceItems: MessageHistorySourceItem[],
  ): Promise<CbItem<ChatItemData>[]> {
    const slots = sourceItems
      .filter(
        (
          item,
        ): item is Extract<MessageHistorySourceItem, { kind: 'message' }> =>
          item.kind === 'message',
      )
      .map((item) => item.message);
    // Persisted tombs are suppression metadata, never timeline rows. Only the
    // mounted deletion notification may replace an existing row with a notice.
    const messages = slots.filter((slot) => !slot.isDeleted);
    const shaped = new Map(
      (await this.wait(this.rawToItems(messages))).map((item) => [
        item.id,
        item,
      ]),
    );
    const out: CbItem<ChatItemData>[] = [];
    for (const item of sourceItems) {
      if (item.kind === 'message') {
        const message = shaped.get(item.message.seq);
        // A deletion may arrive while profiles/quotes are being resolved. Never
        // publish that older body after the live notice has already erased it.
        if (message && !this.deletedQuoteSeqs.has(item.message.seq))
          out.push(message);
        continue;
      }
      const gapKey = `${item.state}:${item.left}:${item.right}`;
      let gapId = this.gapIdByKey.get(gapKey);
      if (gapId === undefined) {
        gapId = this.nextGapItemId++;
        this.gapIdByKey.set(gapKey, gapId);
        this.gapById.set(gapId, {
          left: item.left,
          right: item.right,
          state: item.state,
        });
      }
      out.push({
        id: gapId,
        data: {
          type: 'system',
          contentType: 'SYSTEM',
          msgId: item.right,
          isSelf: false,
          name: '',
          text: '',
          time: '',
          images: null,
          file: null,
          createdAtMs: 0,
          serverGap: {
            left: item.left,
            right: item.right,
            state: item.state,
          },
        },
      });
    }
    return out;
  }

  private async wait<T>(work: Promise<T>): Promise<T> {
    const result = await awaitAbortable(work, this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    return result;
  }

  private queryHistory(
    demand: NativeMessageHistoryDemand,
  ): Promise<NativeMessageHistoryResult> {
    this.lifetime.signal.throwIfAborted();
    return this.wait(
      isTauri()
        ? this.repo.queryNativeMessageHistory(
            this.conv.threadId,
            demand,
            this.lifetime.signal,
          )
        : this.repo.queryBrowserMessageHistory(
            this.conv.threadId,
            demand,
            this.lifetime.signal,
          ),
    );
  }

  private applyBoundaries(items: CbItem<ChatItemData>[]): void {
    if (items.length === 0) return;
    if (this.noOlder && this.noNewer && items.length === 1) {
      items[0] = { ...items[0], boundary: 'both' };
      return;
    }
    if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
    if (this.noNewer)
      items[items.length - 1] = {
        ...items[items.length - 1],
        boundary: 'newest',
      };
  }

  private isSelfAddress(account: string, namespaceId: number): boolean {
    const self = this.userService.sessionProfile();
    return (
      self !== undefined &&
      self.account === account &&
      namespaceId === self.namespaceId
    );
  }

  private creatorKey(creator: Message['creator']): string {
    return messageCreatorKey(creator);
  }

  private toMsgData(
    m: Message,
    images: AlbumMedia[] | null,
    file: FileInfo | null,
  ): ChatMsgData {
    if (m.contentType === 'SYSTEM') {
      return {
        type: 'system',
        msgId: m.seq,
        threadId: m.threadId,
        isSelf: false,
        localSystemProfileRevs: m.localSystemProfileRevs,
        isGroupConversation: this.conv.type === 'GROUP',
        name: '',
        text: m.content,
        time: dayjs(m.createdAt).format('HH:mm'),
        contentType: 'SYSTEM',
        images: null,
        file: null,
        createdAtMs: m.createdAt,
      };
    }
    const creatorKey = this.creatorKey(m.creator)!;
    const creatorIdentity = parseUserIdentityKey(creatorKey);
    if (!creatorIdentity) throw new Error('invalid profile identity key');
    const p = this.profilesBySeq.get(m.seq) ?? this.profiles.get(creatorKey);
    if (!p) throw new Error('message User was not resolved');
    const textContent =
      m.contentType === 'PURE_TEXT'
        ? requireTextMessageContent(m.content)
        : null;
    const renderedText = textContent
      ? toRenderMessageEntities(
          textContent.text,
          selfMentionIdentity(
            this.conv,
            this.userService.sessionProfile()?.account,
          ),
        )
      : null;
    return {
      type: 'msg',
      msgId: m.seq,
      threadId: m.threadId,
      creator: creatorKey,
      isSelf: p.isSelf,
      isGroupConversation: this.conv.type === 'GROUP',
      senderDisplayContext: this.conv.type === 'GROUP' ? 'group' : 'direct',
      name: p.name,
      ...(p.avatarIdentityId === undefined
        ? {}
        : { avatarIdentityId: p.avatarIdentityId }),
      sender:
        m.profileRev > 0
          ? {
              kind: 'demand',
              profile: messageAuthorAvatarProfile(m)!,
              fallbackName: p.name,
              account: creatorIdentity.account,
              domainSource: {
                type: 'profile-namespace',
                publisherNamespaceId: m.publisherNamespaceId,
                profileNamespaceId: m.profileNamespaceId,
              },
            }
          : {
              kind: 'snapshot',
              name: p.name,
              imageUrl: null,
              account: creatorIdentity.account,
              domainSource: {
                type: 'profile-namespace',
                publisherNamespaceId: m.publisherNamespaceId,
                profileNamespaceId: m.profileNamespaceId,
              },
            },
      // Non-text cards keep their wire content in `text` as well. In particular, FORWARD content is
      // the JSON card descriptor consumed by parseForwardCard; dropping it here makes every valid
      // forwarded bundle render as "unavailable".
      text: textContent
        ? toDisplayText(textContent.text)
        : m.contentType === 'LINK'
          ? contextualLinkContent(m.content, m.threadId, m.seq)
          : m.content,
      textSegments: renderedText?.segments,
      mentionState: renderedText?.mentionState,
      time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType,
      images,
      file,
      createdAtMs: m.createdAt,
      mediaStatus: m.mediaStatus,
    };
  }

  /** Resolve each author at the revision selected by that message. */
  private async ensureProfiles(msgs: Message[]): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    await Promise.all(
      msgs.map(async (message) => {
        if (message.contentType === 'SYSTEM') return;
        const key = this.creatorKey(message.creator)!;
        const identity = parseUserIdentityKey(key);
        if (!identity) throw new Error('invalid profile identity key');
        // Batch shaping consumes only what caches already hold: the
        // unevidenced form reads the local durable cache plus this server's
        // durable cache — one bounded request that never federates and never
        // returns PENDING — so a remote author can neither stall nor fail the
        // batch. A miss or error degrades this author to the account
        // identity; the sender avatar demand keeps resolving the full
        // evidenced form in the background.
        const demand = messageAuthorProfileDemand(message);
        const cached = await (this.profileRepo && demand
          ? firstValueFromAbortable(
              this.profileRepo
                .watch(unevidencedProfileDemand(demand))
                .pipe(take(1)),
              this.lifetime.signal,
            ).catch(() => undefined)
          : Promise.resolve(undefined));
        this.lifetime.signal.throwIfAborted();
        const presentation = {
          name: cached?.name ?? identity.account,
          account: identity.account,
          avatarIdentityId: JSON.stringify([
            key,
            'profile',
            message.profileRev,
          ]),
          isSelf: this.isSelfAddress(identity.account, identity.namespaceId),
        };
        if (cached) this.profilesBySeq.set(message.seq, presentation);
        if (!this.profiles.has(key))
          this.profiles.set(key, {
            ...presentation,
            name: identity.account,
          });
      }),
    );
  }
}

function sourceDemand<T>(work: () => Promise<CbDemandResult<T>>): CbDemand<T> {
  // Individual viewport unsubscription detaches its result; destroying the source
  // cancels its whole history lane, including HTTP and further pagination.
  return new Observable((subscriber) => {
    void work()
      .catch((error): CbDemandResult<T> => ({ kind: 'error', error }))
      .then((result) => {
        if (subscriber.closed) return;
        subscriber.next(result);
        subscriber.complete();
      });
  });
}
