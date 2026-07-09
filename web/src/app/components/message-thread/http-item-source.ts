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
 * [Dedup] knownMsgIds prevents pagination duplicates (IO layer, kept in the source). Registered ONCE, at
 *  pull time inside rawToItems (init / getNewer) — never at SSE receive time.
 * [SSE] onSseEvent receives NEW_MESSAGE and fires onSignal — SIGNAL-ONLY (the body is not shaped/cached
 *  here; the conversation-list preview reads the body in its own subscriber). The component's onSignal calls
 *  kernel.onMessageSignal, which pulls from the DB via getNewer / init(-1). rawToItems runs at pull time, so
 *  an id is registered exactly once — a self-send echo / incoming reply on an empty (just-added-friend) thread
 *  reconciles correctly instead of being deduped away.
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

export interface HttpItemSourceLiveOpts {
  /** Live-arrival signal: a NEW_MESSAGE SSE frame landed for this thread (or a reconnect backfill is due).
   *  Signal-only — the SSE body is NOT shaped/cached here. The conversation-list preview lives in a separate
   *  subscriber (ConversationListService.onNewMessage reads the body); the chatbox treats the frame purely as
   *  "newer data exists, go pull it" and lets the kernel fetch from the DB via getNewer / init(-1) on the next
   *  onMessageSignal. The body's ids are registered in knownMsgIds ONCE, at pull time inside rawToItems — so a
   *  self-send echo / incoming reply on an empty (just-added-friend) thread reconciles correctly instead of
   *  being deduped away. */
  onSignal: () => void;
}

export class HttpItemSource implements CbSource<ChatItemData> {
  /** DB cursors (oldest/newest loaded msgId). */
  private oldestMsgId: number | null = null;
  private newestMsgId: number | null = null;
  private noOlder = false;
  private noNewer = true; // anchor is the latest; always true (SSE pushes one way only)

  private readonly profiles = new Map<number, { name: string; isSelf: boolean }>();
  private readonly knownMsgIds = new Set<number>();
  /** In-flight optimistic sends, held separately from the reloadable sequence (mirrors MockItemSource.pending).
   *  Each entry's id === its clientMessageId. On confirm (a real whose clientMessageId matches) the entry is
   *  dropped by reconcilePending inside init/getNewer, and the kernel's reconcileOptimistic removes the mounted
   *  optimistic bubble. Failed entries STAY here (status:'failed') so the failure survives a remount and retry works. */
  private readonly pending: CbItem<ChatItemData>[] = [];
  private sseSub?: Subscription;
  private reconnectSub?: Subscription;
  private readonly onSignal: () => void;

  constructor(
    private readonly conv: ConversationItem,
    private readonly myUserId: number,
    private readonly msgService: MsgService,
    private readonly userService: UserService,
    wsService: WebsocketService,
    live: HttpItemSourceLiveOpts,
  ) {
    this.onSignal = live.onSignal;
    this.sseSub = wsService.eventSubject.subscribe((msg) => this.onSseEvent(msg));
    // On a successful SSE reconnect, signal the kernel to pull — the SSE stream does not replay frames missed
    // while disconnected, so the kernel re-reads newer-than-its-cursor from the DB (source of truth).
    this.reconnectSub = wsService.reconnect$.subscribe(() => this.onSignal());
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
  async init(anchorId: number, olderCount: number, newerCount: number, _opts?: CbSourceInitOpts): Promise<CbItem<ChatItemData>[]> {
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
      firstValueFrom(this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 0, take: olderTake, lastSeq: anchorId, orderBy: 'desc' })),
      firstValueFrom(this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take: newerTake, lastSeq: anchorId, orderBy: 'asc' })),
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
  async getOlder(cursorId: number, count: number): Promise<CbItem<ChatItemData>[]> {
    if (this.noOlder) return [];
    const take = Math.min(count, MAX_PAGE);
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take, lastSeq: cursorId, orderBy: 'desc' }),
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
   *  when the DB ceiling is reached. Called by the kernel's loadNewer — for scroll-driven loads (balance /
   *  followToNewest) AND for the forced pull triggered by an SSE live-arrival signal (onMessageSignal). The
   *  kernel's loadNewer already guards `if (!force && this.noNewer) return 0` before calling, so no noNewer
   *  guard is needed here — and none COULD be, since a signal must be able to pull past "at newest" (that is
   *  the whole point: a NEW_MESSAGE arrived, so there IS newer data even though noNewer was true). */
  async getNewer(cursorId: number, count: number): Promise<CbItem<ChatItemData>[]> {
    const take = Math.min(count, MAX_PAGE);
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ threadId: this.conv.threadId, skip: 1, take, lastSeq: cursorId, orderBy: 'asc' }),
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

  /** Inbound SSE NEW_MESSAGE. Signal-only: the body is NOT shaped or cached here. The conversation-list preview
   *  reads the body in its OWN subscriber (ConversationListService.onNewMessage); the chatbox treats the frame
   *  purely as "newer data exists for this thread" and fires onSignal — the kernel then pulls from the DB
   *  (source of truth) via getNewer / init(-1) on the next onMessageSignal. rawToItems runs ONCE, at pull time,
   *  so the id is registered in knownMsgIds only there — this is what keeps a self-send echo / incoming reply on
   *  an empty (just-added-friend) thread from being deduped away (the old shape-at-SSE-time pre-registered the
   *  id, then init(-1)'s rawToItems dropped it → bubble stuck "sending", replies never mounted). */
  private onSseEvent(msg: StandardMessage): void {
    if (msg.event !== 'NEW_MESSAGE' || msg.status !== 0 || !msg.data) return;
    const data = msg.data as Message & { threadId: number };
    if (data.threadId !== this.conv.threadId) return;
    this.onSignal();
  }

  /** No-op. The signal-only SSE path caches nothing; live data is pulled from the DB on demand. Kept to satisfy
   *  the CbSource interface (the kernel's appendLive calls it; production never routes live arrivals through
   *  appendLive — only through the signal → onMessageSignal → getNewer path — so this is never reached in
   *  production). The playground's MockItemSource implements a real pushLive for its cursor model. */
  pushLive(_rawItems: CbItem<ChatItemData>[]): void { /* signal-only: no cache */ }

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
    this.sseSub?.unsubscribe();
    this.sseSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
  }

  // ---------- rawToItems (shape raw messages: dedup + per-msg parsing; no album merging — that is the kernel's mergeItems job) ----------

  private rawToItems(msgs: Message[]): CbItem<ChatItemData>[] {
    const out: CbItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = m.seq;
      if (this.knownMsgIds.has(id)) continue; // IO dedup (guard against SSE/pagination duplicates)
      this.knownMsgIds.add(id);
      // Each IMAGE/VIDEO/AUDIO message → a single-element media array (carrying its own msgId); consecutive
      // same-creator IMAGE/VIDEO are merged into an album by the kernel's mergeItems (AUDIO stays standalone).
      let images: AlbumImage[] | null = null;
      if (m.contentType === 'IMAGE') {
        images = [{ ...parseImageContent(m.content), msgId: id }];
      } else if (m.contentType === 'VIDEO') {
        const v = parseVideoContent(m.content);
        if (v) images = [{ ...v, msgId: id }];
      } else if (m.contentType === 'AUDIO') {
        const a = parseAudioContent(m.content);
        if (a) images = [{ ...a, msgId: id }];
      }
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
      type: 'msg', msgId: m.seq, creator: m.creator,
      isSelf: p?.isSelf ?? m.creator === this.myUserId,
      name: p?.name ?? '', text: m.content, time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType, images, file, createdAtMs: m.createdAt,
    };
  }

  private async ensureProfiles(msgs: Message[]): Promise<void> {
    const missing = new Set<number>();
    for (const m of msgs) if (!this.profiles.has(m.creator)) missing.add(m.creator);
    if (missing.size === 0) return;
    const res = await firstValueFrom(this.userService.queryUserInfo({ userIds: [...missing] }));
    if (res.code === 0 && res.data) {
      for (const u of res.data) this.profiles.set(u.id, { name: u.name, isSelf: u.id === this.myUserId });
    }
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

/** Parse an AUDIO message's content ({url,name,size,mimeType,duration}). Audio has no intrinsic w/h, so a
 *  placeholder landscape aspect is used to give layoutAlbum a compact card (it renders a gray cell + ▶). */
function parseAudioContent(content: string): AlbumImage | null {
  try {
    const o = JSON.parse(content);
    if (typeof o !== 'object' || o === null) return null;
    const src = String(o.url ?? '');
    if (!src) return null;
    return {
      kind: 'audio',
      src,
      w: 280,
      h: 120, // placeholder aspect (audio is a gray cell + ▶; no real dimensions)
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
