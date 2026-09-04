/**
 * HttpItemSource — production data source implementing CbSource<ChatItemData> (absorbs the old
 * ChatThreadController).
 *
 * Owns DB cursor pagination (oldestMsgId/newestMsgId) + SSE. **Returns raw messages only** (no album
 * merging, no display-time sequential abstract ids) — album merging is a presentation decision done by
 * the kernel's `mergeItems` hook (per batch, before createItem). Date separators are likewise derived by
 * the createItem render layer based on adjacent messages crossing a day boundary (see
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
  filter,
  Observable,
  type Subscriber,
  type Subscription,
} from 'rxjs';
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
import { ProfileResolutionService } from '../../services/profile-resolution.service';
import { MemberProfileRepository } from '../../services/member-profile-store.service';
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
  AlbumImage,
  ChatItemData,
  ChatMsgData,
  FileInfo,
  MediaStatus,
} from '../message-cards/chat-item';
import {
  parseAudioContent,
  parseFileContent,
  parseGalleryContent,
  parseImageContent,
  parseVideoContent,
} from '../message-cards/media-content';
import {
  toDisplayText,
  toRenderMessageEntities,
} from '../../lib/message-entity';
import { requireTextMessageContent } from '../../../../../shared/text-message-content';
import {
  parseCallMessageContent,
  type CallMessageContent,
} from '../../../../../shared/call-message-content';
import { isTauri } from '../../services/runtime';

/**
 * Backend QueryMessagesDto enforces @Max(50) per request — the source owns this ceiling so the kernel's
 * batch tuning (initBatch etc.) can stay a pure UI concern and never produce a "take must be at most 50"
 * rejection. When the kernel asks for more than MAX_PAGE (e.g. initBatch), the source returns one page
 * and the kernel's normal top-up (balance/getOlder) fetches the rest on demand.
 */
const MAX_PAGE = 50;

export class MessagePageLoadError extends Error {
  constructor() {
    super('message page load failed; edge remains retryable');
    this.name = 'MessagePageLoadError';
  }
}

export interface HttpItemSourceLiveOpts {
  /** Presentation-only notice for the unread/new-message badge. It never invokes a kernel load or retry. */
  onNewerAvailable?: (seq: number) => void;
  /** A mediaStatus change landed for this thread through the shared availability service — the
   *  kernel re-renders that one card in place via updateItemData (height-neutral). */
  onMediaStatus?: (seq: number, status: MediaStatus) => void;
  /** Background profile enrichment landed for a message already shaped from the local cache. The component
   *  patches mounted rows in place; unmounted rows pick the profile up from this source on their next shape. */
  onProfile?: (
    seq: number,
    profile: {
      name: string;
      avatar: string;
      avatarIdentityId: string;
      avatarAccount: string;
      avatarDomain: string;
      isSelf: boolean;
    },
  ) => void;
}

export class HttpItemSource implements CbSource<ChatItemData> {
  private noOlder = false;
  private noNewer = true; // anchor is the latest; always true (SSE pushes one way only)

  private readonly profiles = new Map<
    string,
    {
      name: string;
      account: string;
      avatar: string;
      domain: string;
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
  private mediaStatusSub?: Subscription;
  private readonly onMediaStatus: (seq: number, status: MediaStatus) => void;
  private readonly onProfile: (
    seq: number,
    profile: {
      name: string;
      avatar: string;
      avatarIdentityId: string;
      avatarAccount: string;
      avatarDomain: string;
      isSelf: boolean;
    },
  ) => void;
  private readonly onNewerAvailable: (seq: number) => void;
  private readonly seqsByCreator = new Map<string, Set<number>>();
  private readonly profilesInFlight = new Map<string, Promise<void>>();
  private readonly profilesBySeq = new Map<
    number,
    {
      name: string;
      account: string;
      avatar: string;
      domain: string;
      isSelf: boolean;
      avatarIdentityId: string;
    }
  >();
  private readonly profileRequests = new Set<number>();
  private readonly profileSubscriptions = new Set<Subscription>();
  private initializingDb = true;
  private loadedSeq = -1;
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
    private readonly profileRepo?: ProfileRepository,
    private readonly profileResolver?: ProfileResolutionService,
    private readonly memberProfiles?: MemberProfileRepository,
  ) {
    this.pending = outbox.forThread(conv.threadId);
    this.onMediaStatus = live.onMediaStatus ?? (() => {});
    this.onProfile = live.onProfile ?? (() => {});
    this.onNewerAvailable = live.onNewerAvailable ?? (() => {});
    // MessageRepository turns committed content heads into per-thread live signals.
    // The kernel's subsequent getNewer is the single message-body path (IDB cache hit or backend gap-fill).
    // Filter to THIS thread. Multiple mounted sources share the repository's thread state while keeping
    // their viewport demand/cancellation lifecycle independent.
    this.sseSub = repo.liveSignal$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => {
        if (!this.initializingDb && s.seq > this.loadedSeq)
          this.onNewerAvailable(s.seq);
        this.requestNewerPump();
      });
    // Shared mediaStatus changes → re-render that one card
    // in place via updateItemData. Height-neutral (the overlay/meta slot never change the cell height).
    this.mediaStatusSub = repo.mediaStatusLive$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => this.onMediaStatus(s.seq, s.status));
    // On a successful SSE reconnect, signal the kernel to pull — the SSE stream does not replay frames missed
    // while disconnected, so the kernel re-reads newer-than-its-cursor from the DB (source of truth).
    this.reconnectSub = repo.reconnectSignal$.subscribe(() => {
      this.requestNewerPump();
    });
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
  async init(
    anchorId: number,
    olderCount: number,
    newerCount: number,
    _opts?: CbSourceInitOpts,
  ): Promise<CbItem<ChatItemData>[]> {
    const result = await this.queryHistory(
      anchorId === -1
        ? { kind: 'latest', count: Math.min(olderCount, MAX_PAGE) }
        : {
            kind: 'around',
            anchor: anchorId,
            olderCount: Math.min(olderCount, MAX_PAGE),
            newerCount: Math.min(newerCount, MAX_PAGE),
          },
    );
    if (result.failed) throw new MessagePageLoadError();
    const items = await this.historyItemsToCb(result.items);
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
    if (this.noOlder) return [];
    const take = Math.min(count, MAX_PAGE);
    const result = await this.queryHistory({
      kind: 'older',
      before: (this.gapById.get(cursorId)?.left ?? cursorId - 1) + 1,
      count: take,
    });
    if (result.failed) throw new MessagePageLoadError();
    const items = await this.historyItemsToCb(result.items);
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
    const items = await this.historyItemsToCb(result.items);
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
      this.pumpingNewer ||
      this.initializingDb ||
      this.newerWaiters.size === 0
    )
      return;
    this.pumpingNewer = true;
    const pumpVersion = this.newerPumpVersion;
    try {
      // The viewport owns at most one newer demand. Keep the loop general so a future second consumer
      // shares the same source contract without changing the completion semantics.
      for (const waiter of [...this.newerWaiters]) {
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
      if (this.newerPumpVersion !== pumpVersion) void this.pumpNewerWaiters();
    }
  }

  private requestNewerPump(): void {
    this.newerPumpVersion++;
    if (!this.initializingDb) void this.pumpNewerWaiters();
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
      if (item.data.type !== 'msg') return true;
      return !(
        item.data.contentType === 'IMAGE' ||
        item.data.contentType === 'VIDEO' ||
        item.data.contentType === 'FILE'
      );
    });
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
    const i = this.pending.findIndex(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (i < 0) return false;
    const entry = this.pending.splice(i, 1)[0];
    const failed: CbItem<ChatMsgData> = {
      ...entry,
      data: { ...entry.data, status: 'failed', kind: undefined },
    };
    this.pending.push(failed); // sink to the end of the pending queue
    return true;
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
    const index = this.pending.findIndex(
      (item) => item.clientMessageId === clientMessageId,
    );
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.outbox.releaseResource(clientMessageId, true);
    this.outbox.releaseIfEmpty(this.conv.threadId);
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
    this.sseSub?.unsubscribe();
    this.sseSub = undefined;
    this.mediaStatusSub?.unsubscribe();
    this.mediaStatusSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
    for (const subscription of this.profileSubscriptions)
      subscription.unsubscribe();
    this.profileSubscriptions.clear();
    for (const waiter of this.newerWaiters) waiter.subscriber.complete();
    this.newerWaiters.clear();
    this.gapIdByKey.clear();
    this.gapById.clear();
  }

  /**
   * Leave the DB-only phase after the scroller has initialized, then reconcile the durable conversation
   * metadata and the live-session HWM against the newest message actually loaded from the local DB.
   *
   * `persistedLatestSeq` is the server-authored `ConversationItem.lastMessageSeq` stored with the thread
   * row. It is deliberately independent from the messages cache: after a fresh install, storage migration,
   * or cache eviction the thread can truthfully say "latest = 258" while the local messages table is empty.
   * `liveLatestSeq` covers a newer content head observed after that thread snapshot. Whichever is greater is
   * the remote target; if it leads `loadedSeq`, signal the kernel to perform its forced newest-page pull.
   */
  finishLocalInit(
    liveLatestSeq: number | undefined,
    persistedLatestSeq?: number | null,
  ): void {
    this.initializingDb = false;
    const targetSeq = Math.max(liveLatestSeq ?? -1, persistedLatestSeq ?? -1);
    if (targetSeq > this.loadedSeq) {
      this.repo.retainNewestSeq(this.conv.threadId, targetSeq);
      this.onNewerAvailable(targetSeq);
    }
    this.requestNewerPump();
  }

  // ---------- rawToItems (shape every queried message + per-msg parsing; no album merging — that is the kernel's mergeItems job) ----------

  private async rawToItems(msgs: Message[]): Promise<CbItem<ChatItemData>[]> {
    await this.ensureProfiles(msgs);
    const out: CbItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = m.seq;
      if (id > this.loadedSeq) this.loadedSeq = id;
      const callContent =
        m.contentType === 'CALL' ? parseCallMessageContent(m.content) : null;
      if (m.contentType === 'CALL' && !callContent) {
        console.error(
          `[message-content] skipped invalid CALL content (threadId=${this.conv.threadId}, seq=${m.seq})`,
        );
        continue;
      }
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
      let images: AlbumImage[] | null = null;
      if (m.contentType === 'IMAGE') {
        images = [
          { ...parseImageContent(m.content), msgId: id, status: m.mediaStatus },
        ];
      } else if (m.contentType === 'VIDEO') {
        const v = parseVideoContent(m.content);
        if (v) images = [{ ...v, msgId: id, status: m.mediaStatus }];
      } else if (m.contentType === 'AUDIO') {
        const a = parseAudioContent(m.content);
        if (a) images = [{ ...a, msgId: id, status: m.mediaStatus }];
      } else if (m.contentType === 'GALLERY') {
        images = parseGalleryContent(m.content).map((media) => ({
          ...media,
          msgId: id,
          status: m.mediaStatus,
        }));
      }
      // FILE message → the attachment metadata parsed from content JSON (url/name/size/mimeType).
      const file: FileInfo | null =
        m.contentType === 'FILE' ? parseFileContent(m.content) : null;
      // Surface the clientMessageId so the kernel can pair this server-confirmed real with the optimistic
      // bubble that shares it (mountNewerReals flags resortTarget by clientMessageId; reconcileOptimistic then
      // removes the optimistic duplicate). Without this the optimistic would never be reconciled away → two
      // bubbles. Backend serializeBody ships clientMessageId on the wire (no DTO whitelisting).
      const item: CbItem<ChatMsgData> = {
        id,
        data: this.toMsgData(m, images, file, callContent),
      };
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
    const messages = sourceItems
      .filter(
        (
          item,
        ): item is Extract<MessageHistorySourceItem, { kind: 'message' }> =>
          item.kind === 'message',
      )
      .map((item) => item.message);
    const shaped = new Map(
      (await this.rawToItems(messages)).map((item) => [item.id, item]),
    );
    const out: CbItem<ChatItemData>[] = [];
    for (const item of sourceItems) {
      if (item.kind === 'message') {
        const message = shaped.get(item.message.seq);
        if (message) out.push(message);
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

  private queryHistory(
    demand: NativeMessageHistoryDemand,
  ): Promise<NativeMessageHistoryResult> {
    return isTauri()
      ? this.repo.queryNativeMessageHistory(this.conv.threadId, demand)
      : this.repo.queryBrowserMessageHistory(this.conv.threadId, demand);
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

  private isSelfAddress(account: string, domain: string): boolean {
    const self = this.userService.sessionProfile();
    return self !== undefined && self.account === account && domain === 'local';
  }

  private creatorKey(creator: Message['creator']): string | null {
    if (creator === null) return null;
    return messageCreatorKey(creator);
  }

  private toMsgData(
    m: Message,
    images: AlbumImage[] | null,
    file: FileInfo | null,
    callContent: CallMessageContent | null,
  ): ChatMsgData {
    if (m.contentType === 'SYSTEM') {
      let systemActorIsSelf = false;
      try {
        const actor = (
          JSON.parse(m.content) as {
            actor?: { account?: string; domain?: string };
          }
        ).actor;
        const self = this.userService.sessionProfile();
        systemActorIsSelf =
          !!actor &&
          !!self &&
          actor.account === self.account &&
          actor.domain === self.domain;
      } catch {
        // The system row owns malformed-content fallback rendering.
      }
      return {
        type: 'system',
        msgId: m.seq,
        isSelf: systemActorIsSelf,
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
    if (m.creator === null) throw new Error('authored message has no creator');
    const creatorKey = this.creatorKey(m.creator)!;
    const p = this.profilesBySeq.get(m.seq) ?? this.profiles.get(creatorKey);
    if (!p) throw new Error('message User was not resolved');
    const textContent =
      m.contentType === 'PURE_TEXT'
        ? requireTextMessageContent(m.content)
        : null;
    const renderedText = textContent
      ? toRenderMessageEntities(
          textContent.text,
          this.userService.sessionProfile()?.account,
        )
      : null;
    return {
      type: 'msg',
      msgId: m.seq,
      creator: creatorKey,
      isSelf: p.isSelf,
      isGroupConversation: this.conv.type === 'GROUP',
      name: p.name,
      avatar: p.avatar,
      ...(p.avatarIdentityId === undefined
        ? {}
        : { avatarIdentityId: p.avatarIdentityId }),
      avatarAccount: p.account,
      avatarDomain: p.domain,
      // Non-text cards keep their wire content in `text` as well. In particular, FORWARD content is
      // the JSON card descriptor consumed by parseForwardCard; dropping it here makes every valid
      // forwarded bundle render as "unavailable".
      text: textContent ? toDisplayText(textContent.text) : m.content,
      ...(callContent ? { callContent } : {}),
      textSegments: renderedText?.segments,
      mentionState: renderedText?.mentionState,
      time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType,
      images,
      file,
      createdAtMs: m.createdAt,
      mediaStatus: m.mediaStatus,
      quote: textContent?.quote
        ? {
            seq: textContent.quote.seq,
            ...(textContent.quote.author !== undefined
              ? { author: textContent.quote.author }
              : {}),
            ...(textContent.quote.body !== undefined
              ? { body: textContent.quote.body }
              : {}),
            ...(textContent.quote.contentType !== undefined
              ? {
                  contentType: textContent.quote
                    .contentType as ChatMsgData['contentType'],
                }
              : {}),
            ...(textContent.quote.image !== undefined
              ? { image: textContent.quote.image }
              : {}),
            ...(textContent.quote.imageLabel !== undefined
              ? { imageLabel: textContent.quote.imageLabel }
              : {}),
            ...(textContent.quote.imageIdentity !== undefined
              ? { imageIdentity: textContent.quote.imageIdentity }
              : {}),
            ...(textContent.quote.imageSize !== undefined
              ? { imageSize: textContent.quote.imageSize }
              : {}),
            ...(textContent.quote.imageShape !== undefined
              ? { imageShape: textContent.quote.imageShape }
              : {}),
          }
        : undefined,
    };
  }

  /** Resolve every authored row from the local source-scoped User table before constructing UI items. */
  private async ensureProfiles(msgs: Message[]): Promise<void> {
    if (this.conv.type === 'GROUP' && this.memberProfiles) {
      await Promise.all(
        msgs.flatMap((message) => {
          if (message.creator === null) return [];
          const identity = parseUserIdentityKey(
            this.creatorKey(message.creator)!,
          );
          return identity
            ? [
                this.memberProfiles!.recordMessageProfile(
                  this.conv.threadId,
                  identity,
                  message.profileRev,
                  message.seq,
                ),
              ]
            : [];
        }),
      );
    }
    const missing = new Set<string>();
    for (const m of msgs) {
      if (m.creator === null) continue;
      const key = this.creatorKey(m.creator)!;
      if (!this.profiles.has(key)) missing.add(key);
    }
    if (missing.size === 0) return;
    if (!this.profileRepo)
      throw new Error('source-scoped User repository is unavailable');
    await Promise.all(
      [...missing].map((key) => {
        const active = this.profilesInFlight.get(key);
        if (active) return active;
        const load = (async () => {
          const identity = parseUserIdentityKey(key);
          if (!identity) throw new Error('invalid User identity key');
          const cached = await this.profileRepo!.getUser(
            identity.account,
            identity.domain,
            identity.namespaceId,
          );
          if (!cached)
            throw new Error(
              `User is missing: ${identity.account}@${identity.domain} in namespace ${identity.namespaceId}`,
            );
          this.profiles.set(key, {
            name: cached.name,
            account: cached.account,
            avatar: cached.avatar,
            avatarIdentityId: key,
            domain: cached.domain,
            isSelf: this.isSelfAddress(cached.account, cached.domain),
          });
        })().finally(() => this.profilesInFlight.delete(key));
        this.profilesInFlight.set(key, load);
        return load;
      }),
    );
    if (!this.profileResolver) return;
    for (const message of msgs) {
      if (
        message.creator === null ||
        this.profileRequests.has(message.seq) ||
        this.profilesBySeq.has(message.seq)
      )
        continue;
      this.profileRequests.add(message.seq);
      const creatorKey = this.creatorKey(message.creator)!;
      let subscription!: Subscription;
      subscription = this.profileResolver
        .resolve({ threadId: this.conv.threadId, messageSeq: message.seq })
        .subscribe({
          next: (resolved) => {
            const profile = {
              name: resolved.name,
              account: resolved.account,
              avatar: resolved.avatarBase64
                ? `data:image/webp;base64,${resolved.avatarBase64}`
                : '',
              avatarIdentityId: JSON.stringify([
                creatorKey,
                'profile',
                resolved.rev,
              ]),
              domain: resolved.domain,
              isSelf: this.isSelfAddress(
                message.creator!.account,
                message.creator!.domain,
              ),
            };
            this.profilesBySeq.set(message.seq, profile);
            if (this.conv.type === 'GROUP' && this.memberProfiles) {
              const identity = parseUserIdentityKey(creatorKey);
              if (identity)
                void this.memberProfiles.storeResolvedProfile(
                  this.conv.threadId,
                  identity,
                  {
                    rev: resolved.rev,
                    name: resolved.name,
                    avatar: profile.avatar,
                    bio: resolved.bio,
                  },
                );
            }
            this.onProfile(message.seq, {
              name: profile.name,
              avatar: profile.avatar,
              avatarIdentityId: profile.avatarIdentityId,
              avatarAccount: profile.account,
              avatarDomain: profile.domain,
              isSelf: profile.isSelf,
            });
          },
          error: () => {
            this.profileRequests.delete(message.seq);
          },
          complete: () => this.profileSubscriptions.delete(subscription),
        });
      this.profileSubscriptions.add(subscription);
      if (subscription.closed) this.profileSubscriptions.delete(subscription);
    }
  }
}

function sourceDemand<T>(work: () => Promise<CbDemandResult<T>>): CbDemand<T> {
  // Unsubscribe detaches the viewport observer; it deliberately does not abort the shared cache-fill HTTP operation.
  // A later demand may reuse the repository result. Introduce AbortSignal only if repository requests become
  // per-consumer rather than cache-populating work.
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
