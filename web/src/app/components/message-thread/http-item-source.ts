/**
 * HttpItemSource — production data source implementing CbSource<ChatItemData> (absorbs the old
 * ChatThreadController).
 *
 * Owns DB cursor pagination (oldestMsgId/newestMsgId) + WS. **Returns raw messages only** (no album
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
 * [Dedup] knownMsgIds prevents WS/pagination duplicates (IO layer, kept in the source).
 * [WS] onWsEvent receives NEW_MESSAGE → rawToItems → onLive callback → the component calls
 *  kernel.appendLive (→ source.pushLive caches; the kernel mounts the items directly).
 */
import { firstValueFrom, type Subscription } from 'rxjs';
import dayjs from 'dayjs';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { StandardMessage } from '../../services/websocket.service';
import type { Message, ConversationItem } from '../../services/model';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { CbSource, CbSourceInitOpts } from '../../lib/chat-box/cb-source';
import type { AlbumImage, ChatItemData, ChatMsgData, FileInfo } from '../message-cards/chat-item';

/**
 * Backend QueryMessagesDto enforces @Max(50) per request — the source owns this ceiling so the kernel's
 * batch tuning (initBatch etc.) can stay a pure UI concern and never produce a "take must be at most 50"
 * rejection. When the kernel asks for more than MAX_PAGE (e.g. initBatch), the source returns one page
 * and the kernel's normal top-up (balance/getOlder) fetches the rest on demand.
 */
const MAX_PAGE = 50;
/** Max pages fetched per SSE-reconnect refill (each MAX_PAGE). Missed messages are paged in until the DB
 *  latest is reached or this cap is hit; beyond the cap the user scrolls to load more (rare: requires
 *  missing more than REFILL_HARD_CAP * MAX_PAGE messages while disconnected). */
const REFILL_HARD_CAP = 10;

export interface HttpItemSourceLiveOpts {
  /** WS new-message callback (the component calls kernel.appendLive from it). */
  onLive: (items: CbItem<ChatItemData>[]) => void;
}

export class HttpItemSource implements CbSource<ChatItemData> {
  /** DB cursors (oldest/newest loaded msgId). */
  private oldestMsgId: string | null = null;
  private newestMsgId: string | null = null;
  private noOlder = false;
  private noNewer = true; // anchor is the latest; always true (WS pushes one way only)

  private readonly profiles = new Map<number, { name: string; isSelf: boolean }>();
  private readonly knownMsgIds = new Set<string>();
  /** In-flight optimistic sends, held separately from the reloadable sequence (mirrors MockItemSource.pending).
   *  Each entry's id === its clientMessageId. On confirm (a real whose clientMessageId matches) the entry is
   *  dropped by getNewer's live-cache drain, and the kernel's reconcileOptimistic removes the mounted optimistic
   *  bubble. Failed entries STAY here (status:'failed') so the failure survives a remount and retry works. */
  private readonly pending: CbItem<ChatItemData>[] = [];
  /** WS-pushed / refill reals awaiting the kernel's onMessageSignal to drain them via getNewer. The kernel calls
   *  getNewer (forced) once per signal; we drain the whole cache in one batch so a backlog mounts atomically. */
  private readonly liveCache: CbItem<ChatItemData>[] = [];
  private wsSub?: Subscription;
  private reconnectSub?: Subscription;
  private readonly onLive: (items: CbItem<ChatItemData>[]) => void;

  constructor(
    private readonly conv: ConversationItem,
    private readonly myUserId: number,
    private readonly msgService: MsgService,
    private readonly userService: UserService,
    wsService: WebsocketService,
    live: HttpItemSourceLiveOpts,
  ) {
    this.onLive = live.onLive;
    this.wsSub = wsService.eventSubject.subscribe((msg) => this.onWsEvent(msg));
    // On a successful SSE reconnect, backfill messages missed while disconnected using the newestMsgId
    // cursor (the SSE stream itself does not replay history).
    this.reconnectSub = wsService.reconnect$.subscribe(() => { void this.refillNewer(); });
  }

  /**
   * Initialize / re-anchor:
   *  - anchorId === -1: take the latest `olderCount` messages (desc, reversed to ascending); the anchor
   *    is the newest (noNewer=true; WS pushes one way only).
   *  - otherwise (a real msgId): fetch both directions — older (desc, skip:0, includes anchorId) +
   *    newer (asc, skip:1, excludes anchorId), merged into ascending order; noOlder/noNewer are set from
   *    each direction's hasMore (a middle window leaves both false → scrolling up/down can still reach the
   *    global edges).
   * Returns ascending raw messages; the global oldest/newest carry a boundary flag.
   */
  async init(anchorId: string | number, olderCount: number, newerCount: number, _opts?: CbSourceInitOpts): Promise<CbItem<ChatItemData>[]> {
    if (anchorId === -1) {
      // Cap at MAX_PAGE (backend @Max(50)); the kernel top-ups the rest via getOlder. hasMore is
      // authoritative (backend take+1 method), so it alone drives noOlder — the old `list.length < olderCount`
      // heuristic would falsely signal exhaustion now that take is clamped below olderCount.
      const take = Math.min(olderCount, MAX_PAGE);
      const res = await firstValueFrom(
        this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 0, take, orderBy: 'desc' }),
      );
      if (res.code !== 0 || !res.data) return [];
      const list = [...res.data].reverse(); // desc → ascending (old → new)
      this.noOlder = !res.hasMore;
      this.noNewer = true; // anchor is the latest
      await this.ensureProfiles(list);
      const items = this.rawToItems(list);
      if (items.length > 0) {
        // anchor=-1 → the last item is always the global newest; noOlder means it also reached the oldest. A length-1
        // batch spanning both edges is a sole item → 'both' (the boundary field is single-valued; otherwise items[0]='oldest'
        // and items[last]='newest' collide on it and noOlder is lost → a permanent top ghost on a single-message thread).
        if (this.noOlder && items.length === 1) items[0] = { ...items[0], boundary: 'both' };
        else {
          if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
          items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
        }
        this.oldestMsgId = firstMsgId(items);
        this.newestMsgId = lastMsgId(items);
      }
      this.reconcilePending(items); // a returned real confirms its optimistic counterpart → drop it from pending
      return items;
    }
    // Real msgId: fetch both directions (jump to a specific message / open conversation from a
    // notification). take is capped at MAX_PAGE (backend @Max(50)).
    const olderTake = Math.min(olderCount, MAX_PAGE);
    const newerTake = Math.min(newerCount, MAX_PAGE);
    const [olderRes, newerRes] = await Promise.all([
      firstValueFrom(this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 0, take: olderTake, lastId: String(anchorId), orderBy: 'desc' })),
      firstValueFrom(this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take: newerTake, lastId: String(anchorId), orderBy: 'asc' })),
    ]);
    if (olderRes.code !== 0 || !olderRes.data || olderRes.data.length === 0) return []; // target msgId not found
    const older = [...olderRes.data].reverse(); // desc → ascending: [older..anchorId] (includes anchorId)
    const newer = newerRes.code === 0 && newerRes.data ? newerRes.data : []; // already ascending: (anchorId..newer]
    const list = [...older, ...newer];
    this.noOlder = !olderRes.hasMore;
    this.noNewer = !newerRes.hasMore;
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length > 0) {
      // Bidirectional fetch: noOlder/noNewer reflect each direction's hasMore. A length-1 batch spanning both edges → 'both'.
      if (this.noOlder && this.noNewer && items.length === 1) items[0] = { ...items[0], boundary: 'both' };
      else {
        if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
        if (this.noNewer) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
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
      const pi = this.pending.findIndex((p) => p.clientMessageId === r.clientMessageId);
      if (pi >= 0) this.pending.splice(pi, 1);
    }
  }

  /** Fetch `count` messages older than cursorId (desc, then reversed to ascending). out[0] is tagged
   *  'oldest' when the DB floor is reached. */
  async getOlder(cursorId: string | number, count: number): Promise<CbItem<ChatItemData>[]> {
    if (this.noOlder) return [];
    const take = Math.min(count, MAX_PAGE);
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take, lastId: String(cursorId), orderBy: 'desc' }),
    );
    if (res.code !== 0 || !res.data || res.data.length === 0) { this.noOlder = true; return []; }
    const list = [...res.data].reverse(); // desc → ascending
    if (!res.hasMore) this.noOlder = true; // hasMore is authoritative (backend take+1 method); the count heuristic is unsound once take is capped below `count`
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length === 0) return [];
    if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
    this.oldestMsgId = firstMsgId(items) ?? this.oldestMsgId;
    return items;
  }

  /** Fetch `count` messages newer than cursorId (already ascending). out[last] is tagged 'newest'
   *  when the DB ceiling is reached. In production the anchor is the latest message (noNewer=true) so
   *  the kernel never calls this; it exists for a future "load from the middle" mode. */
  async getNewer(cursorId: string | number, count: number): Promise<CbItem<ChatItemData>[]> {
    // Drain the live cache first: WS-pushed / refill reals are always newer than anything mounted (production
    // anchors at the global newest), so they live past any cursor. The kernel calls this (forced) from
    // onMessageSignal ONCE per signal — drain ALL cached items in one batch so a backlog mounts atomically (a
    // capped drain would strand the rest, since onMessageSignal does not loop). Reconcile pending: any pending
    // whose clientMessageId matches a drained real is dropped — its confirm arrived, the kernel's
    // reconcileOptimistic will remove the matching optimistic bubble and tag this real cb-confirmed.
    if (this.liveCache.length > 0) {
      const cached = this.liveCache.splice(0);
      this.reconcilePending(cached); // a drained real confirms its optimistic counterpart → drop it from pending
      this.noNewer = true; // live items are the global newest
      cached[cached.length - 1] = { ...cached[cached.length - 1], boundary: 'newest' };
      return cached;
    }
    if (this.noNewer) return [];
    const take = Math.min(count, MAX_PAGE);
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take, lastId: String(cursorId), orderBy: 'asc' }),
    );
    if (res.code !== 0 || !res.data || res.data.length === 0) { this.noNewer = true; return []; }
    const list = [...res.data]; // already ascending (old → new)
    if (!res.hasMore) this.noNewer = true; // hasMore is authoritative (backend take+1 method)
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length === 0) return [];
    if (this.noNewer) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
    this.newestMsgId = lastMsgId(items) ?? this.newestMsgId;
    return items;
  }

  /** Inbound WS message: shape via rawToItems, then notify the component via onLive (the component calls
   *  kernel.appendLive, which caches via source.pushLive and mounts the items directly). */
  private onWsEvent(msg: StandardMessage): void {
    if (msg.event !== 'NEW_MESSAGE' || msg.status !== 0 || !msg.data) return;
    const data = msg.data as Message & { threadId: number };
    if (data.threadId !== this.conv.threadId) return;
    const id = String(data.id);
    if (this.knownMsgIds.has(id)) return; // dedup
    data.id = id;
    this.ensureProfiles([data]).then(() => {
      const items = this.rawToItems([data]);
      if (items.length > 0) this.onLive(items);
    });
  }

  /** Cache live (WS-pushed / refill) reals for the kernel to drain via getNewer on the next onMessageSignal.
   *  Items are already CbItems (shaped by rawToItems, clientMessageId preserved) and already deduped; we append
   *  them to the live cache and track the newest id for the SSE-reconnect refill cursor. */
  pushLive(rawItems: CbItem<ChatItemData>[]): void {
    if (rawItems.length === 0) return;
    for (const it of rawItems) this.liveCache.push(it);
    const last = rawItems[rawItems.length - 1];
    this.newestMsgId = last.data.type === 'msg' ? last.data.msgId : String(last.id);
  }

  /** In-flight optimistic sends (defensive copy) — the kernel (re)mounts them at the global newest edge. */
  getPending(): CbItem<ChatItemData>[] { return this.pending.slice(); }

  /** Store an in-flight optimistic send (separate from the reloadable sequence). */
  addPending(item: CbItem<ChatItemData>): void { this.pending.push(item); }

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
    const i = this.pending.findIndex((p) => p.clientMessageId === clientMessageId);
    if (i < 0) return false;
    const entry = this.pending.splice(i, 1)[0];
    const failed: CbItem<ChatItemData> = { ...entry, data: { ...entry.data, status: 'failed', kind: undefined } };
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
    const i = this.pending.findIndex((p) => p.clientMessageId === clientMessageId);
    if (i < 0) return undefined;
    const retrying: CbItem<ChatItemData> = {
      ...this.pending[i],
      data: { ...this.pending[i].data, status: 'sending', kind: 'pending' },
    };
    this.pending[i] = retrying; // stay at the current position (the end)
    return retrying;
  }


  destroy(): void {
    this.wsSub?.unsubscribe();
    this.wsSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
  }

  /**
   * Refill after an SSE reconnect: page newer (asc) from the newestMsgId cursor to backfill messages
   * missed while disconnected, until the DB latest is reached or REFILL_HARD_CAP is hit. Queries directly
   * (bypassing getNewer's noNewer guard — that reflects scroll-cursor state, unrelated to a one-shot
   * refill) and reuses rawToItems dedup + ensureProfiles + onLive to stay on the same path as the WS
   * live stream. Each page's take is capped at MAX_PAGE (backend @Max(50)); the ascending tail of a page
   * is its newest message, which becomes the next page's cursor. Skipped when no initial messages are
   * loaded yet (newestMsgId == null).
   */
  private async refillNewer(): Promise<void> {
    if (this.newestMsgId == null) return;
    const collected: Message[] = [];
    let cursorId = this.newestMsgId;
    for (let page = 0; page < REFILL_HARD_CAP; page++) {
      const res = await firstValueFrom(
        this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take: MAX_PAGE, lastId: cursorId, orderBy: 'asc' }),
      );
      if (res.code !== 0 || !res.data) break; // network/server error → abort and let the next reconnect retry (leave noNewer unchanged)
      if (res.data.length === 0) { this.noNewer = true; break; } // nothing newer → already at latest
      collected.push(...res.data);
      if (!res.hasMore) { this.noNewer = true; break; } // this page reached the DB latest
      cursorId = String(res.data[res.data.length - 1].id); // ascending tail = newest → page further newer
    }
    if (collected.length === 0) return;
    await this.ensureProfiles(collected);
    const items = this.rawToItems(collected);
    if (items.length > 0) {
      this.newestMsgId = lastMsgId(items) ?? this.newestMsgId;
      this.onLive(items);
    }
  }

  // ---------- rawToItems (shape raw messages: dedup + per-msg parsing; no album merging — that is the kernel's mergeItems job) ----------

  private rawToItems(msgs: Message[]): CbItem<ChatItemData>[] {
    const out: CbItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = String(m.id);
      if (this.knownMsgIds.has(id)) continue; // IO dedup (guard against WS/pagination duplicates)
      this.knownMsgIds.add(id);
      // Each IMAGE message → a single-element images array (carrying its own msgId); consecutive same-creator
      // images are merged into an album by the kernel's mergeItems.
      const images: AlbumImage[] | null = m.contentType === 'IMAGE'
        ? [{ ...parseImageContent(m.content), msgId: id }]
        : null;
      // FILE message → the attachment metadata parsed from content JSON (url/name/size/mimeType).
      const file: FileInfo | null = m.contentType === 'FILE' ? parseFileContent(m.content) : null;
      // Surface the clientMessageId so the kernel can pair this server-confirmed real with the optimistic
      // bubble that shares it (mountNewerReals flags resortTarget by clientMessageId; reconcileOptimistic then
      // removes the optimistic duplicate). Without this the optimistic would never be reconciled away → two
      // bubbles. Backend serializeBody ships clientMessageId on the wire (no DTO whitelisting).
      const item: CbItem<ChatItemData> = { id, data: this.toMsgData(m, images, file) };
      if (m.clientMessageId) item.clientMessageId = m.clientMessageId;
      out.push(item);
    }
    return out;
  }

  private toMsgData(m: Message, images: AlbumImage[] | null, file: FileInfo | null): ChatMsgData {
    const p = this.profiles.get(m.creator);
    return {
      type: 'msg', msgId: String(m.id), creator: m.creator,
      isSelf: p?.isSelf ?? m.creator === this.myUserId,
      name: p?.name ?? 'Unknown', text: m.content, time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType, images, file, createdAtMs: m.createdAt,
    };
  }

  private async ensureProfiles(msgs: Message[]): Promise<void> {
    const missing = new Set<number>();
    for (const m of msgs) if (!this.profiles.has(m.creator)) missing.add(m.creator);
    if (missing.size === 0) return;
    const res = await firstValueFrom(this.userService.queryUserInfo({ userIds: [...missing] }));
    if (res.code === 0 && res.data) {
      for (const u of res.data) this.profiles.set(u.id, { name: u.uniqName, isSelf: u.id === this.myUserId });
    }
  }
}

// ---------- helpers ----------

function parseImageContent(content: string): AlbumImage {
  // w/h are read on the frontend via createImageBitmap and stored with the message in content
  // (the composer sends IMAGE content as JSON {url,w,h}; the backend writeMsgToThread stores it verbatim), so in
  // production this is always valid — the `|| 0` fallback was removed to surface contract violations.
  // layoutAlbum's ratio() still tolerates NaN/0 with a 4:3 fallback (so bad data can't poison totalH).
  try {
    const o = JSON.parse(content);
    return { src: String(o.url ?? ''), w: Number(o.w), h: Number(o.h) };
  } catch {
    // Isolate malformed JSON (a single bad message must not crash all of rawToItems); w/h=0 falls back to
    // layoutAlbum's 4:3.
    return { src: '', w: 0, h: 0 };
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
function firstMsgId(items: CbItem<ChatItemData>[]): string | null {
  const first = items[0];
  return first && first.data.type === 'msg' ? first.data.msgId : null;
}
/** id of the last message in the range. */
function lastMsgId(items: CbItem<ChatItemData>[]): string | null {
  const last = items[items.length - 1];
  return last && last.data.type === 'msg' ? last.data.msgId : null;
}
