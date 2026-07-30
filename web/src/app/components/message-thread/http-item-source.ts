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
 *  queryMessages. This source therefore does not suppress queried ids. Cursor paging keeps pages disjoint,
 *  while the kernel rejects overlap with rows that are currently mounted.
 * [SSE] onSseEvent receives NEW_MESSAGE and fires onSignal — SIGNAL-ONLY (the body is not shaped/cached
 *  here; the conversation-list preview reads the body in its own subscriber). The component's onSignal calls
 *  kernel.onMessageSignal, which pulls from the DB via getNewer / init(-1).
 */
import { firstValueFrom, filter, type Subscription } from 'rxjs';
import dayjs from 'dayjs';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';
import type { Message, ConversationItem } from '../../services/model';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { CbSource, CbSourceInitOpts } from '../../lib/chat-box/cb-source';
import type {
  AlbumImage,
  ChatItemData,
  ChatMsgData,
  FileInfo,
  MediaStatus,
} from '../message-cards/chat-item';
import { VOICE_BAR_W, VOICE_BAR_H } from '../message-cards/media-row/layout';

/**
 * Backend QueryMessagesDto enforces @Max(50) per request — the source owns this ceiling so the kernel's
 * batch tuning (initBatch etc.) can stay a pure UI concern and never produce a "take must be at most 50"
 * rejection. When the kernel asks for more than MAX_PAGE (e.g. initBatch), the source returns one page
 * and the kernel's normal top-up (balance/getOlder) fetches the rest on demand.
 */
const MAX_PAGE = 50;

export interface HttpItemSourceLiveOpts {
  /** Live-arrival signal: a NEW_MESSAGE SSE frame landed for this thread (or a reconnect backfill is due).
   *  Signal-only — the SSE body is NOT shaped/cached here. The conversation-list preview lives in a separate
   *  subscriber (ConversationListService.onNewMessage reads the body); the chatbox treats the frame purely as
   *  "newer data exists, go pull it" and lets the kernel fetch from the DB via getNewer / init(-1) on the next
   *  onMessageSignal. Shaping happens only at pull time, so a self-send echo / incoming reply on an empty
   *  (just-added-friend) thread reconciles correctly. */
  onSignal: (seq: number) => void;
  /** A mediaStatus change landed for this thread (MEDIA_STATUS SSE / scroll probe / retry ack) — the
   *  kernel re-renders that one card in place via updateItemData (height-neutral). */
  onMediaStatus?: (seq: number, status: MediaStatus) => void;
  /** Background profile enrichment landed for a message already shaped from the local cache. The component
   *  patches mounted rows in place; unmounted rows pick the profile up from this source on their next shape. */
  onProfile?: (
    seq: number,
    profile: {
      name: string;
      avatar: string;
      avatarIdentityId: number;
      isSelf: boolean;
    },
  ) => void;
}

export class HttpItemSource implements CbSource<ChatItemData> {
  /** DB cursors (oldest/newest loaded msgId). */
  private oldestMsgId: number | null = null;
  private newestMsgId: number | null = null;
  private noOlder = false;
  private noNewer = true; // anchor is the latest; always true (SSE pushes one way only)

  private readonly profiles = new Map<
    number,
    { name: string; avatar: string; isSelf: boolean }
  >();
  /** In-flight optimistic sends, held separately from the reloadable sequence (mirrors MockItemSource.pending).
   *  Each entry's id === its clientMessageId. On confirm (a real whose clientMessageId matches) the entry is
   *  dropped by reconcilePending inside init/getNewer, and the kernel's reconcileOptimistic removes the mounted
   *  optimistic bubble. The array is owned by the application-scoped ThreadSendOutbox, so failed/in-flight
   *  entries survive destruction and recreation of this thread source. */
  private readonly pending: CbItem<ChatItemData>[];
  private sseSub?: Subscription;
  private reconnectSub?: Subscription;
  private mediaStatusSub?: Subscription;
  private readonly onMediaStatus: (seq: number, status: MediaStatus) => void;
  private readonly onProfile: (
    seq: number,
    profile: {
      name: string;
      avatar: string;
      avatarIdentityId: number;
      isSelf: boolean;
    },
  ) => void;
  private readonly onSignal: (seq: number) => void;
  private readonly seqsByCreator = new Map<number, Set<number>>();
  private readonly profilesInFlight = new Set<number>();
  private readonly profileBacklog: Message[] = [];
  private initializingDb = true;
  private loadedSeq = -1;

  constructor(
    private readonly conv: ConversationItem,
    private readonly repo: MessageRepository,
    private readonly userService: UserService,
    wsService: WebsocketService,
    private readonly outbox: ThreadSendOutbox,
    live: HttpItemSourceLiveOpts,
    private readonly profileRepo?: ProfileRepository,
  ) {
    const self = userService.sessionProfile?.();
    if (self)
      this.profiles.set(self.id, {
        name: self.name,
        avatar: self.avatar,
        isSelf: true,
      });
    if (conv.type === 'P2P' && conv.peerUser)
      this.profiles.set(conv.peerUser.id, {
        name: conv.peerUser.name,
        avatar: conv.peerUser.avatar,
        isSelf: conv.peerUser.id === this.selfUserId,
      });
    this.pending = outbox.forThread(conv.threadId);
    this.onSignal = live.onSignal;
    this.onMediaStatus = live.onMediaStatus ?? (() => {});
    this.onProfile = live.onProfile ?? (() => {});
    // The DB-layer MessageRepository owns the identity-only NEW_MESSAGE SSE and emits liveSignal$.
    // The kernel's subsequent getNewer is the single message-body path (IDB cache hit or backend gap-fill).
    // Filter to THIS thread (one source per open thread).
    this.sseSub = repo.liveSignal$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => {
        if (this.initializingDb || s.seq <= this.loadedSeq) return;
        this.onSignal(s.seq);
      });
    // mediaStatus changes (MEDIA_STATUS SSE / scroll probe / manual-retry ack) → re-render that one card
    // in place via updateItemData. Height-neutral (the overlay/meta slot never change the cell height).
    this.mediaStatusSub = repo.mediaStatusLive$
      .pipe(filter((s) => s.threadId === this.conv.threadId))
      .subscribe((s) => this.onMediaStatus(s.seq, s.status));
    // On a successful SSE reconnect, signal the kernel to pull — the SSE stream does not replay frames missed
    // while disconnected, so the kernel re-reads newer-than-its-cursor from the DB (source of truth).
    this.reconnectSub = wsService.reconnect$.subscribe(() =>
      this.onSignal(Number.MAX_SAFE_INTEGER),
    );
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
    if (anchorId === -1) {
      // Cap at MAX_PAGE (backend @Max(50)); the kernel top-ups the rest via getOlder. hasMore is
      // authoritative (backend take+1 method), so it alone drives noOlder — the old `list.length < olderCount`
      // heuristic would falsely signal exhaustion now that take is clamped below olderCount. init (skip:0)
      // returns a contiguous IDB page immediately when warm; the repo revalidates it in the background.
      const take = Math.min(olderCount, MAX_PAGE);
      const { data, hasMore } = await this.repo.queryMessages(
        this.conv.threadId,
        { skip: 0, take, orderBy: 'desc' },
        this.conv.clearedAt,
        this.initializingDb,
      );
      if (!data || data.length === 0) return [];
      const list = [...data].reverse(); // desc → ascending (old → new)
      this.noOlder = !hasMore;
      this.noNewer = true; // anchor is the latest
      this.profileBacklog.push(...list);
      const items = this.rawToItems(list);
      if (items.length > 0) {
        // anchor=-1 → the last item is always the global newest; noOlder means it also reached the oldest. A length-1
        // batch spanning both edges is a sole item → 'both' (the boundary field is single-valued; otherwise items[0]='oldest'
        // and items[last]='newest' collide on it and noOlder is lost → a permanent top ghost on a single-message thread).
        if (this.noOlder && items.length === 1)
          items[0] = { ...items[0], boundary: 'both' };
        else {
          if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
          items[items.length - 1] = {
            ...items[items.length - 1],
            boundary: 'newest',
          };
        }
        this.oldestMsgId = firstMsgId(items);
        this.newestMsgId = lastMsgId(items);
      }
      this.reconcilePending(items); // a returned real confirms its optimistic counterpart → drop it from pending
      return items;
    }
    // Real msgId: fetch both directions (jump to a specific message / open conversation from a
    // notification). take is capped at MAX_PAGE (backend @Max(50)). The older leg (skip:0) backend-probes
    // for the anchor; the newer leg (skip:1) is cache-first via the repo.
    const olderTake = Math.min(olderCount, MAX_PAGE);
    const newerTake = Math.min(newerCount, MAX_PAGE);
    const [olderPage, newerPage] = await Promise.all([
      this.repo.queryMessages(
        this.conv.threadId,
        { skip: 0, take: olderTake, lastSeq: anchorId, orderBy: 'desc' },
        this.conv.clearedAt,
        this.initializingDb,
      ),
      this.repo.queryMessages(
        this.conv.threadId,
        { skip: 1, take: newerTake, lastSeq: anchorId, orderBy: 'asc' },
        this.conv.clearedAt,
        this.initializingDb,
      ),
    ]);
    if (!olderPage.data || olderPage.data.length === 0) return []; // target msgId not found
    const older = [...olderPage.data].reverse(); // desc → ascending: [older..anchorId] (includes anchorId)
    const newer = newerPage.data ?? []; // already ascending: (anchorId..newer]
    const list = [...older, ...newer];
    this.noOlder = !olderPage.hasMore;
    this.noNewer = !newerPage.hasMore;
    this.profileBacklog.push(...list);
    const items = this.rawToItems(list);
    if (items.length > 0) {
      // Bidirectional fetch: noOlder/noNewer reflect each direction's hasMore. A length-1 batch spanning both edges → 'both'.
      if (this.noOlder && this.noNewer && items.length === 1)
        items[0] = { ...items[0], boundary: 'both' };
      else {
        if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
        if (this.noNewer)
          items[items.length - 1] = {
            ...items[items.length - 1],
            boundary: 'newest',
          };
      }
      this.oldestMsgId = firstMsgId(items);
      this.newestMsgId = lastMsgId(items);
    }
    this.reconcilePending(items); // a returned real confirms its optimistic counterpart → drop it from pending
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
    const { data, hasMore } = await this.repo.queryMessages(
      this.conv.threadId,
      { skip: 1, take, lastSeq: cursorId, orderBy: 'desc' },
      this.conv.clearedAt,
      this.initializingDb,
    );
    if (!data || data.length === 0) {
      this.noOlder = true;
      return [];
    }
    const list = [...data].reverse(); // desc → ascending
    if (!hasMore) this.noOlder = true; // hasMore is authoritative (backend take+1 method, or the cache reached seq 0)
    this.profileBacklog.push(...list);
    const items = this.rawToItems(list);
    if (items.length === 0) return [];
    if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
    this.oldestMsgId = firstMsgId(items) ?? this.oldestMsgId;
    return items;
  }

  /** Fetch `count` messages newer than cursorId (already ascending). out[last] is tagged 'newest'
   *  when the DB ceiling is reached. Called by the kernel's loadNewer — for scroll-driven loads (balance /
   *  followToNewest) AND for the forced pull triggered by an SSE live-arrival signal (onMessageSignal). The
   *  kernel's loadNewer already guards `if (!force && this.noNewer) return 0` before calling, so no noNewer
   *  guard is needed here — and none COULD be, since a signal must be able to pull past "at newest" (that is
   *  the whole point: a NEW_MESSAGE arrived, so there IS newer data even though noNewer was true). */
  async getNewer(
    cursorId: number,
    count: number,
  ): Promise<CbItem<ChatItemData>[]> {
    console.info('[album-debug] getNewer:start', {
      threadId: this.conv.threadId,
      cursorId,
      count,
    });
    const take = Math.min(count, MAX_PAGE);
    const { data, hasMore } = await this.repo.queryMessages(
      this.conv.threadId,
      { skip: 1, take, lastSeq: cursorId, orderBy: 'asc' },
      this.conv.clearedAt,
      this.initializingDb,
    );
    if (!data || data.length === 0) {
      console.info('[album-debug] getNewer:empty', {
        threadId: this.conv.threadId,
        cursorId,
      });
      this.noNewer = true;
      return [];
    }
    const list = [...data]; // already ascending (old → new)
    if (!hasMore) this.noNewer = true; // hasMore is authoritative (backend take+1 method, or the cache reached maxSeenSeq)
    this.profileBacklog.push(...list);
    const items = this.rawToItems(list);
    console.info('[album-debug] getNewer:result', {
      threadId: this.conv.threadId,
      cursorId,
      hasMore,
      items: items.map((item) => ({
        id: item.id,
        contentType: item.data.contentType,
        creator: item.data.creator,
        clientMessageId: item.clientMessageId,
        images: item.data.images?.length ?? 0,
      })),
    });
    if (items.length === 0) return [];
    if (this.noNewer)
      items[items.length - 1] = {
        ...items[items.length - 1],
        boundary: 'newest',
      };
    this.newestMsgId = lastMsgId(items) ?? this.newestMsgId;
    return items;
  }

  /** No-op. Live arrivals are signal-only: the DB-layer {@link MessageRepository} caches the NEW_MESSAGE body
   *  and emits `liveSignal$`, which the constructor pipes to {@link onSignal}; the kernel then pulls the cached
   *  body via getNewer / init(-1). Kept to satisfy the CbSource interface (the kernel's appendLive calls it;
   *  production never routes live arrivals through appendLive — only through the signal path — so this is never
   *  reached in production). The playground's MockItemSource implements a real pushLive for its cursor model. */
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
    this.pending.push(item);
  }

  /** Look up an outbox entry even when it is intentionally omitted from getPending() presentation. */
  pendingByClientMessageId(
    clientMessageId: string,
  ): CbItem<ChatItemData> | undefined {
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
    const failed: CbItem<ChatItemData> = {
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
  retryPending(clientMessageId: string): CbItem<ChatItemData> | undefined {
    const i = this.pending.findIndex(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (i < 0) return undefined;
    const retrying: CbItem<ChatItemData> = {
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

  /**
   * Mark an in-flight optimistic send SENT (the HTTP-200 / upload-success milestone) — flips the pending entry's
   * status 'sending'→'sent' IN PLACE at its CURRENT tail position (unlike failPending, which sinks a failed send to
   * the end). Stable identity + a fresh data ref let the kernel's confirmPending morph the bubble in place
   * (sending→sent) and tag it cb-confirmed so the spinner→check→fade choreography plays WITHOUT a mount/unmount or
   * reorder — decoupling the delivery-confirm visual from the later SSE-echo reconcile (which still owns the real's
   * mount + the cb-move FLIP). The entry STAYS in `pending` until the SSE echo's real fulfills it (reconcilePending
   * drops it) so a remount before the echo still reads 'sent'. Returns false if no pending entry matches (the echo
   * already confirmed+dropped it → the real owns the choreography, the rare SSE-beats-HTTP race).
   */
  markPendingSent(clientMessageId: string): boolean {
    const i = this.pending.findIndex(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (i < 0) return false;
    const entry = this.pending[i];
    this.pending[i] = {
      ...entry,
      data: { ...entry.data, status: 'sent', kind: undefined },
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
  }

  /**
   * Leave the DB-only phase after the scroller has initialized, then reconcile the durable conversation
   * metadata and the live-session HWM against the newest message actually loaded from the local DB.
   *
   * `persistedLatestSeq` is the server-authored `ConversationItem.lastMessageSeq` stored with the thread
   * row. It is deliberately independent from the messages cache: after a fresh install, storage migration,
   * or cache eviction the thread can truthfully say "latest = 258" while the local messages table is empty.
   * `liveLatestSeq` covers a newer NEW_MESSAGE observed after that thread snapshot. Whichever is greater is
   * the remote target; if it leads `loadedSeq`, signal the kernel to perform its forced newest-page pull.
   */
  finishLocalInit(
    liveLatestSeq: number | undefined,
    persistedLatestSeq?: number | null,
  ): void {
    this.initializingDb = false;
    this.hydrateProfiles(this.profileBacklog.splice(0));
    const targetSeq = Math.max(liveLatestSeq ?? -1, persistedLatestSeq ?? -1);
    if (targetSeq > this.loadedSeq) this.onSignal(targetSeq);
  }

  // ---------- rawToItems (shape every queried message + per-msg parsing; no album merging — that is the kernel's mergeItems job) ----------

  private rawToItems(msgs: Message[]): CbItem<ChatItemData>[] {
    const out: CbItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = m.seq;
      if (id > this.loadedSeq) this.loadedSeq = id;
      let creatorSeqs = this.seqsByCreator.get(m.creator);
      if (!creatorSeqs) {
        creatorSeqs = new Set<number>();
        this.seqsByCreator.set(m.creator, creatorSeqs);
      }
      creatorSeqs.add(id);
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
      }
      // FILE message → the attachment metadata parsed from content JSON (url/name/size/mimeType).
      const file: FileInfo | null =
        m.contentType === 'FILE' ? parseFileContent(m.content) : null;
      // Surface the clientMessageId so the kernel can pair this server-confirmed real with the optimistic
      // bubble that shares it (mountNewerReals flags resortTarget by clientMessageId; reconcileOptimistic then
      // removes the optimistic duplicate). Without this the optimistic would never be reconciled away → two
      // bubbles. Backend serializeBody ships clientMessageId on the wire (no DTO whitelisting).
      const item: CbItem<ChatItemData> = {
        id,
        data: this.toMsgData(m, images, file),
      };
      if (m.clientMessageId) {
        item.clientMessageId = m.clientMessageId;
        // Single-trigger "lock" on the real side: the spinner→check→fade choreography plays on THIS real only when
        // the send-success milestone (HTTP 200 / upload done) has NOT already played it on the optimistic bubble —
        // i.e. the pending entry is still 'sending' (SSE echo won the race). When 200 already fired, the pending
        // entry is 'sent' and the optimistic already carried the choreography, so the real mounts SILENT (no status)
        // and the cb-confirmed the kernel tags on it is inert (no .msg-status--sent to animate) → the animation fires
        // exactly once. History / incoming (no pending match) never carry a tick. `this.pending` still holds the entry
        // here: the source reconcilePending that drops fulfilled cids runs AFTER rawToItems (see getNewer / init).
        const pending = this.pending.find(
          (p) => p.clientMessageId === m.clientMessageId,
        );
        if (pending && pending.data.status === 'sending')
          item.data = { ...item.data, status: 'sent' };
      }
      if (m.contentType === 'IMAGE' || m.contentType === 'VIDEO') {
        console.info('[album-debug] rawToItems:media', {
          threadId: this.conv.threadId,
          id,
          contentType: m.contentType,
          creator: m.creator,
          clientMessageId: m.clientMessageId,
          images: images?.length ?? 0,
        });
      }
      out.push(item);
    }
    return out;
  }

  /** The authenticated user's id, resolved LIVE at message-shape time — NOT snapshotted at construction.
   *  `establishSession` sets `sessionUserId` synchronously on the HELLO handshake (BEFORE the async self-
   *  profile fetch), so reading it here yields the correct id the instant HELLO lands. Snapshotting the id
   *  at construction instead froze a pre-HELLO `0`, which made `creator === 0` false for EVERY message and
   *  rendered both sides' messages on the peer's side (the "reconnect attribution" bug). Falls back to the
   *  profile id, then `0` only when the session is genuinely unknown (shaped before any HELLO). */
  private get selfUserId(): number {
    return (
      this.userService.sessionUserId() ??
      this.userService.sessionProfile()?.id ??
      0
    );
  }

  private toMsgData(
    m: Message,
    images: AlbumImage[] | null,
    file: FileInfo | null,
  ): ChatMsgData {
    const p = this.profiles.get(m.creator);
    return {
      type: 'msg',
      msgId: m.seq,
      creator: m.creator,
      isSelf: p?.isSelf ?? m.creator === this.selfUserId,
      name: p?.name ?? '',
      avatar: p?.avatar ?? '',
      avatarIdentityId: m.creator,
      text: m.content,
      time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType,
      images,
      file,
      createdAtMs: m.createdAt,
      mediaStatus: m.mediaStatus,
    };
  }

  /** Start profile hydration without joining the message-page critical path. Message bodies can therefore
   *  mount and emit `ready` even when the network is offline, half-open, retrying, or simply slow. */
  private hydrateProfiles(msgs: Message[]): void {
    const missing = new Set<number>();
    for (const m of msgs)
      if (
        !this.profiles.has(m.creator) &&
        !this.profilesInFlight.has(m.creator)
      )
        missing.add(m.creator);
    if (missing.size === 0) return;
    for (const id of missing) this.profilesInFlight.add(id);
    void (async () => {
      try {
        if (this.profileRepo) {
          for (const id of [...missing]) {
            const cached = await this.profileRepo.getProfile(`u${id}`);
            if (!cached) continue;
            const profile = {
              name: cached.name,
              avatar: cached.avatar,
              avatarIdentityId: id,
              isSelf: id === this.selfUserId,
            };
            this.profiles.set(id, profile);
            missing.delete(id);
            for (const seq of this.seqsByCreator.get(id) ?? [])
              this.onProfile(seq, profile);
          }
        }
        if (
          missing.size === 0 ||
          (typeof navigator !== 'undefined' && !navigator.onLine)
        )
          return;
        const res = await firstValueFrom(
          this.userService.queryUserInfo({ userIds: [...missing] }),
        );
        if (res.code === 0 && res.data) {
          for (const u of res.data) {
            const profile = {
              name: u.name,
              avatar: u.avatar ?? '',
              avatarIdentityId: u.id,
              isSelf: u.id === this.selfUserId,
            };
            this.profiles.set(u.id, profile);
            void this.profileRepo?.putProfile(`u${u.id}`, 'user', {
              id: u.id,
              name: u.name,
              avatar: u.avatar ?? '',
              bio: u.bio,
              domain: u.domain,
              profileRev: u.profileRev ?? 0,
            });
            for (const seq of this.seqsByCreator.get(u.id) ?? [])
              this.onProfile(seq, profile);
          }
        }
      } catch {
        // Profile metadata is enrichment, not a prerequisite for rendering cached message bodies.
      } finally {
        for (const id of missing) this.profilesInFlight.delete(id);
      }
    })();
  }
}

// ---------- helpers ----------

function parseImageContent(content: string): AlbumImage {
  // IMAGE content = JSON {url,w,h,size}. w/h come from the composer's createImageBitmap; size from the
  // upload response (drives the meta bar). layoutAlbum's ratio() tolerates NaN/0 with a 4:3 fallback.
  try {
    const o = JSON.parse(content);
    return {
      kind: 'image',
      src: String(o.url ?? ''),
      w: Number(o.w),
      h: Number(o.h),
      size: Number(o.size) || 0,
    };
  } catch {
    // Isolate malformed JSON (a single bad message must not crash all of rawToItems).
    return { kind: 'image', src: '', w: 0, h: 0 };
  }
}

/** Parse a VIDEO message's content ({url,name,size,mimeType,w,h,duration}) into a media cell. w/h come
 *  from the composer's <video> loadedmetadata probe (server-untrusted); duration likewise. Lenient on
 *  malformed JSON (returns null → no cell) so one bad row can't crash rawToItems. */
function parseVideoContent(content: string): AlbumImage | null {
  try {
    const o = JSON.parse(content);
    if (typeof o !== 'object' || o === null) return null;
    const src = String(o.url ?? '');
    if (!src) return null;
    return {
      kind: 'video',
      src,
      w: Number(o.w) || 0,
      h: Number(o.h) || 0,
      size: Number(o.size) || 0,
      duration: Number(o.duration) || 0,
      name: typeof o.name === 'string' ? o.name : '',
    };
  } catch {
    return null;
  }
}

/** Parse an AUDIO message's content ({url,name,size,mimeType,duration}). Audio has no intrinsic w/h; the
 *  220×52 dims match layoutAlbum's audio branch (a fixed slim voice bar) and the optimistic sendVoice cell,
 *  so optimistic ↔ real swap without a height jump. layoutAlbum special-cases audio and ignores these w/h
 *  for the rect, but they stay semantically consistent for any non-audio-aware reader. */
function parseAudioContent(content: string): AlbumImage | null {
  try {
    const o = JSON.parse(content);
    if (typeof o !== 'object' || o === null) return null;
    const src = String(o.url ?? '');
    if (!src) return null;
    return {
      kind: 'audio',
      src,
      w: VOICE_BAR_W,
      h: VOICE_BAR_H, // slim voice bar (single source of truth with layoutAlbum's audio branch + sendVoice)
      size: Number(o.size) || 0,
      duration: Number(o.duration) || 0,
      name: typeof o.name === 'string' ? o.name : '',
    };
  } catch {
    return null;
  }
}

/** Parse a FILE message's content JSON ({url,name,size,mimeType}) into render metadata. The backend already
 *  validated this shape on send (parseFileContent in upload/file-content.ts); this is a lenient display-side
 *  parse — malformed JSON is isolated (returns null → the row renders a fallback name) so one bad row can't
 *  crash rawToItems. */
function parseFileContent(content: string): FileInfo | null {
  try {
    const o = JSON.parse(content);
    if (typeof o !== 'object' || o === null) return null;
    const url = String(o.url ?? '');
    if (!url) return null;
    return {
      url,
      name: String(o.name ?? 'file'),
      size: Number(o.size) || 0,
      mimeType: String(o.mimeType ?? ''),
    };
  } catch {
    return null;
  }
}

/** id of the first message in the range (the source returns only messages, so the head is the first
 *  message; the guard is defensive and for TS narrowing). */
function firstMsgId(items: CbItem<ChatItemData>[]): number | null {
  const first = items[0];
  return first && first.data.type === 'msg' ? first.data.msgId : null;
}
/** id of the last message in the range. */
function lastMsgId(items: CbItem<ChatItemData>[]): number | null {
  const last = items[items.length - 1];
  return last && last.data.type === 'msg' ? last.data.msgId : null;
}
