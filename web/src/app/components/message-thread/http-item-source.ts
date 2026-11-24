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
  concatMap,
  combineLatest,
  startWith,
  fromEvent,
  takeUntil,
  defer,
  EMPTY,
  map,
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
import { failedMatchingIntentIds, ThreadSendOutbox } from '../../services/thread-send-outbox.service';
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
  CbSourceWindowContext,
  CbSourceWindowRequest,
} from '../../lib/chat-box/cb-source';
import type {
  ChatItemData,
  ChatMsgData,
  MediaStatus,
} from '../message-cards/chat-item';
import {
  contextualLinkContent,
  contextualMediaUrl,
  projectMessageContent,
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
import type { PreparedMessageEntry } from './message-entry';

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
  onNewerAvailable?: (seq: number, previousLatestSeq?: number) => void;
  /** A mediaStatus change landed for this thread through the shared availability service — the
   *  kernel re-renders that one card in place via updateItemData (height-neutral). */
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
  private sseSub?: Subscription;
  private reconnectSub?: Subscription;
  private livePaused = false;
  private readonly onNewerAvailable: (seq: number, previousLatestSeq?: number) => void;
  private previousHeadSeq: number;
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
  private entryPreparation?: Promise<PreparedMessageEntry>;
  private entryKnownEndSeq = 0;
  private entrySeed?: NativeMessageHistoryResult;
  private loadedSeq = -1;
  private notifiedNewestSeq = -1;
  /** Newer-edge demands are long-lived: at the current newest they remain pending until a real item exists. */
  private readonly newerWaiters = new Set<{
    cursorId: number;
    count: number;
    scope: CancellationScope;
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
    private readonly entryReadSeq: number,
    private readonly repo: MessageRepository,
    private readonly userService: UserService,
    private readonly outbox: ThreadSendOutbox,
    live: HttpItemSourceLiveOpts,
    private readonly messages: MsgService,
    private readonly profileRepo: ProfileRepository,
  ) {
    this.previousHeadSeq = conv.messageEndSeq;
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
        }
      });
    this.onNewerAvailable = live.onNewerAvailable ?? (() => {});
    // MessageRepository turns committed content heads into per-thread live signals.
    // The kernel's subsequent getNewer is the single message-body path (IDB cache hit or backend gap-fill).
    // Filter to THIS thread. Multiple mounted sources share the repository's thread state while keeping
    // their viewport demand/cancellation lifecycle independent.
    this.resumeLiveUpdates();
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
    const previousLatestSeq = this.previousHeadSeq;
    this.previousHeadSeq = Math.max(previousLatestSeq, seq);
    if (
      this.initializingDb ||
      this.livePaused ||
      seq <= Math.max(0, this.loadedSeq, this.notifiedNewestSeq)
    )
      return;
    // Retaining a ceiling can synchronously emit historyHead$. Repeated entry and
    // resume must wake demand, but must not count the same head as another arrival.
    this.notifiedNewestSeq = seq;
    this.onNewerAvailable(seq, previousLatestSeq);
  }

  /** Keep a mounted reply's quote synchronized with durable updates. */
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

  /** Read only the local seed. A failed read is retryable, never an empty-cache decision. */
  prepareEntry(): Promise<PreparedMessageEntry> {
    this.lifetime.signal.throwIfAborted();
    if (this.entryPreparation) return this.entryPreparation;
    const knownEndSeq = Math.max(
      this.conv.messageEndSeq,
      this.repo.newestKnownSeq(this.conv.threadId),
    );
    this.entryKnownEndSeq = knownEndSeq;
    this.entryPreparation = this.queryHistory({
      kind: 'localAround',
      anchor: this.entryReadSeq,
      olderCount: this.entryReadSeq > 0 ? MAX_PAGE : 0,
      newerCount: MAX_PAGE,
    })
      .then((result) => {
        if (result.failed) throw new MessagePageLoadError();
        this.lifetime.signal.throwIfAborted();
        this.entrySeed = result;
        return Object.freeze({
          lastReadSeq: this.entryReadSeq,
          hasCachedMessages: result.items.some(
            (item) => item.kind === 'message',
          ),
          hasCachedHead: result.items.some(
            (item) =>
              item.kind === 'message' && item.message.seq === knownEndSeq,
          ),
        });
      })
      .catch((error: unknown) => {
        this.entryPreparation = undefined;
        throw error;
      });
    return this.entryPreparation;
  }

  async loadWindow(
    request: CbSourceWindowRequest,
    context?: CbSourceWindowContext,
  ): Promise<CbItem<ChatItemData>[]> {
    if (context?.signal && this.bindingSignal !== context.signal) {
      this.detachBindingAbort?.();
      const signal = context.signal;
      this.bindingSignal = signal;
      const abort = () => this.destroy();
      signal.addEventListener('abort', abort, { once: true });
      this.detachBindingAbort = () =>
        signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
    this.lifetime.signal.throwIfAborted();
    if (this.entryPreparation) await this.wait(this.entryPreparation);
    let result: NativeMessageHistoryResult;
    switch (request.kind) {
      case 'cached': {
        const count = Math.min(request.count, MAX_PAGE);
        const seed = this.entrySeed;
        result = seed
          ? {
              ...seed,
              items: count > 0 ? seed.items.slice(-count) : [],
              hasOlder: seed.hasOlder || seed.items.length > count,
            }
          : await this.queryHistory({ kind: 'localLatest', count });
        const entry = this.entryPreparation
          ? await this.wait(this.entryPreparation)
          : undefined;
        if (
          entry?.hasCachedHead &&
          this.repo.newestKnownSeq(this.conv.threadId) <=
            this.entryKnownEndSeq &&
          result.items.some(
            (item) =>
              item.kind === 'message' &&
              item.message.seq === this.entryKnownEndSeq,
          )
        )
          result = { ...result, hasNewer: false };
        break;
      }
      case 'latest':
        result = await this.queryHistory({
          kind: 'latest',
          count: Math.min(request.count, MAX_PAGE),
        });
        break;
      case 'start':
        result = this.entryReadSeq === 0 && this.entrySeed?.items.length
          ? { ...this.entrySeed, items: this.entrySeed.items.slice(0, request.count) }
          : await this.queryHistory({
              kind: 'newer',
              after: 0,
              count: Math.min(request.count, MAX_PAGE),
            });
        break;
      case 'around': {
        const seed = request.messageId === this.entryReadSeq ? this.entrySeed : undefined;
        result = seed?.items.length
          ? seed
          : await this.queryHistory({
              kind: 'around',
              anchor: request.messageId,
              olderCount: Math.min(request.olderCount, MAX_PAGE),
              newerCount: Math.min(request.newerCount, MAX_PAGE),
            });
        break;
      }
    }
    this.entrySeed = undefined;
    if (result.failed) throw new MessagePageLoadError();
    let items = await this.wait(this.historyItemsToCb(result.items));
    if (!items.some((item) => !item.displayInterval)) {
      const pending = items.filter((item) => item.data.serverGap?.state === 'SERVER_PENDING');
      if (pending.length) {
        // Cold entry is a spinner, not a whole-thread gap. Subscribe before waiting
        // so the first committed reverse page can establish a real local window.
        items = await firstValueFromAbortable(
          combineLatest(
            items.map((gap) => this.watchInterval(gap).pipe(startWith([gap]))),
          ).pipe(
            map((pages) => pages.flat()),
            map((page) => {
              if (
                page.length &&
                page.every((item) => item.data.serverGap?.state === 'SERVER_UNAVAILABLE')
              )
                throw new MessagePageLoadError();
              return page;
            }),
            filter((page) =>
              page.length === 0 || page.some((item) => !item.displayInterval),
            ),
            take(1),
          ),
          this.lifetime.signal,
        );
      } else if (items.length) throw new MessagePageLoadError();
    }
    this.noOlder = !result.hasOlder;
    this.noNewer = !result.hasNewer;
    this.applyBoundaries(items);
    await this.confirmSendingTasks(items);
    // Ordinary edge demand may start before the component receives window completion.
    this.initializingDb = false;
    this.requestNewerPump();
    return items;
  }

  /** A loaded message can retire only a failed leftover. An in-flight send is removed by its own response. */
  private async confirmSendingTasks(reals: CbItem<ChatItemData>[]): Promise<void> {
    const failed = failedMatchingIntentIds(this.outbox.forThread(this.conv.threadId), reals.flatMap(item => [
      ...(item.clientMessageId ? [item.clientMessageId] : []),
      ...(item.clientMessageIds ?? []),
    ]));
    if (failed.length > 0) await this.outbox.confirm(this.conv.threadId, failed);
  }

  /** Fetch `count` messages older than cursorId (desc, then reversed to ascending). out[0] is tagged
   *  'oldest' when the DB floor is reached. */
  async getOlder(
    cursorId: number,
    count: number,
    signal: AbortSignal = this.lifetime.signal,
  ): Promise<CbItem<ChatItemData>[]> {
    signal.throwIfAborted();
    const take = Math.min(count, MAX_PAGE);
    const result = await this.queryHistory(
      {
        kind: 'older',
        before: (this.gapById.get(cursorId)?.left ?? cursorId - 1) + 1,
        count: take,
      },
      signal,
    );
    if (result.failed) throw new MessagePageLoadError();
    const items = await awaitAbortable(this.historyItemsToCb(result.items), signal);
    signal.throwIfAborted();
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
    signal: AbortSignal = this.lifetime.signal,
  ): Promise<CbItem<ChatItemData>[]> {
    signal.throwIfAborted();
    const take = Math.min(count, MAX_PAGE);
    const result = await this.queryHistory({
      kind: 'newer',
      after: this.gapById.get(cursorId)?.right ?? cursorId,
      count: take,
    }, signal);
    if (result.failed) throw new MessagePageLoadError();
    const items = await awaitAbortable(this.historyItemsToCb(result.items), signal);
    signal.throwIfAborted();
    this.noNewer = !result.hasNewer;
    if (!result.hasOlder && items.length > 0) {
      this.noOlder = true;
      items[0] = { ...items[0], boundary: 'oldest' };
    }
    if (this.noNewer && items.length > 0) {
      const last = items.length - 1;
      items[last] = {
        ...items[last],
        boundary: items[last].boundary === 'oldest' ? 'both' : 'newest',
      };
    }
    await this.confirmSendingTasks(items);
    return items;
  }

  requestOlder(cursorId: number, count: number): CbDemand<ChatItemData> {
    return sourceDemand(this.lifetime.signal, async (signal) => {
      const items = await this.getOlder(cursorId, count, signal);
      return items.length > 0 ? { kind: 'items', items } : { kind: 'boundary' };
    });
  }

  /** A renderer's interval owns the transport consumer. A page only replaces its
   * committed scan; the unscanned part keeps its original server-gap identity. */
  watchInterval(item: CbItem<ChatItemData>): Observable<CbItem<ChatItemData>[]> {
    const gap = item.data.serverGap;
    if (!gap) throw new Error('interval subscription requires a server gap');
    return defer(() => {
      if (this.lifetime.signal.aborted) return EMPTY;
      let projection: MessageHistorySourceItem[] = [{ kind: 'serverGap', ...gap }];
      return this.repo
        .watchHistoryInterval(this.conv.threadId, gap.left, gap.right)
        .pipe(
          takeUntil(fromEvent(this.lifetime.signal, 'abort')),
          concatMap(async (page) => {
            this.lifetime.signal.throwIfAborted();
            const left = Math.max(gap.left, page.left);
            const right = Math.min(gap.right, page.right);
            if (left >= right) return this.historyItemsToCb(projection);
            const items: MessageHistorySourceItem[] = [];
            // Cold entry can consume several deleted-only scans before it mounts
            // a real page. Preserve prior scan evidence, not the original gap.
            for (const candidate of projection) {
              if (candidate.kind === 'message') {
                if (candidate.message.seq <= left) items.push(candidate);
              } else if (candidate.left < left) {
                items.push({ ...candidate, right: Math.min(candidate.right, left) });
              }
            }
            for (const candidate of page.items) {
              if (candidate.kind === 'message') {
                if (candidate.message.seq > left && candidate.message.seq <= right)
                  items.push(candidate);
              } else {
                const clipped = {
                  ...candidate,
                  left: Math.max(left, candidate.left),
                  right: Math.min(right, candidate.right),
                };
                if (clipped.left < clipped.right) items.push(clipped);
              }
            }
            for (const candidate of projection) {
              if (candidate.kind === 'message') {
                if (candidate.message.seq > right) items.push(candidate);
              } else if (candidate.right > right) {
                items.push({ ...candidate, left: Math.max(candidate.left, right) });
              }
            }
            const canonical: MessageHistorySourceItem[] = [];
            for (const candidate of items) {
              const previous = canonical[canonical.length - 1];
              if (
                previous?.kind === 'serverGap' &&
                candidate.kind === 'serverGap' &&
                previous.right === candidate.left &&
                previous.state === candidate.state
              )
                previous.right = candidate.right;
              else canonical.push({ ...candidate });
            }
            projection = canonical;
            const replacements = await this.historyItemsToCb(canonical);
            // Thread boundary evidence survives replacement of an edge display row.
            if (
              replacements.length &&
              (item.boundary === 'oldest' || item.boundary === 'both')
            )
              replacements[0].boundary = 'oldest';
            if (
              replacements.length &&
              (item.boundary === 'newest' || item.boundary === 'both')
            ) {
              const last = replacements[replacements.length - 1];
              last.boundary = last.boundary === 'oldest' ? 'both' : 'newest';
            }
            return replacements;
          }),
          takeUntil(fromEvent(this.lifetime.signal, 'abort')),
        );
    });
  }

  requestMessagesForEmptyWindow(count: number): CbDemand<ChatItemData> {
    return this.requestNewer(this.entryReadSeq, count);
  }

  requestNewer(cursorId: number, count: number): CbDemand<ChatItemData> {
    return new Observable((subscriber) => {
      if (this.lifetime.signal.aborted) {
        subscriber.complete();
        return;
      }
      const scope = new CancellationScope(this.lifetime.signal);
      const waiter = { cursorId, count, subscriber, scope };
      this.newerWaiters.add(waiter);
      this.requestNewerPump();
      return () => {
        this.newerWaiters.delete(waiter);
        scope.cancel();
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
          const items = await this.getNewer(waiter.cursorId, waiter.count, waiter.scope.signal);
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
   * Reconcile durable conversation metadata and the live-session HWM after the
   * component has presented the window. loadWindow already releases the local-read
   * gate so centered fill does not depend on this presentation callback.
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
      // Surface the clientMessageId so the kernel can pair this server-confirmed real with the optimistic
      // bubble that shares it (mountNewerReals flags resortTarget by clientMessageId; reconcileOptimistic then
      // removes the optimistic duplicate). Without this the optimistic would never be reconciled away → two
      // bubbles. Backend serializeBody ships clientMessageId on the wire (no DTO whitelisting).
      const item: CbItem<ChatMsgData> = {
        id,
        data: { ...this.toMsgData(m), quote: quotes.get(m.seq) },
      };
      if (
        item.data.quote?.seq !== undefined &&
        this.deletedQuoteSeqs.has(item.data.quote.seq)
      ) {
        item.data.quote = { seq: item.data.quote.seq };
      }
      if (m.clientMessageId) {
        item.clientMessageId = m.clientMessageId;
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
        displayInterval: { left: item.left, right: item.right },
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
    signal: AbortSignal = this.lifetime.signal,
  ): Promise<NativeMessageHistoryResult> {
    signal.throwIfAborted();
    return awaitAbortable(
      isTauri()
        ? this.repo.queryNativeMessageHistory(
            this.conv.threadId,
            demand,
            signal,
          )
        : this.repo.queryBrowserMessageHistory(
            this.conv.threadId,
            demand,
            signal,
          ),
      signal,
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

  private toMsgData(m: Message): ChatMsgData {
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
      ...projectMessageContent(m.contentType, m.content, {
        msgId: m.seq, senderName: p.name, sentAt: m.createdAt,
      }, item => contextualMediaUrl(item, m.threadId, m.seq)),
      createdAtMs: m.createdAt,
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
        const cached = await (demand
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

function sourceDemand<T>(
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<CbDemandResult<T>>,
): CbDemand<T> {
  return new Observable((subscriber) => {
    // Retiring one edge/gap cancels only its query consumer, not the source,
    // sibling demands, or repository-owned cache transactions.
    const request = new CancellationScope(parent);
    void work(request.signal)
      .catch((error): CbDemandResult<T> => ({ kind: 'error', error }))
      .then((result) => {
        if (subscriber.closed) return;
        subscriber.next(result);
        subscriber.complete();
      });
    return () => request.cancel();
  });
}
