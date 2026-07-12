import { Injectable, inject } from '@angular/core';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MsgService } from './message.service';
import { Message, QueryMessageLogParams } from './model';

/** The read query shape — mirrors `MsgService.queryMessageLog` params (so the source swaps over 1:1). */
export type MessageQuery = Pick<QueryMessageLogParams, 'skip' | 'take' | 'lastSeq' | 'orderBy'>;

/**
 * The DB-layer repository for message bodies — the read + SSE half of the strict 3-tier
 * (UI ↔ repositories ↔ backend) for the message domain. It is the ONLY service that issues message
 * READs (`/query-messages`) and the ONLY consumer of the `NEW_MESSAGE` body cache. UI-facing sources
 * ({@link HttpItemSource}) read through here; they never fetch messages or cache SSE bodies themselves.
 *
 * NO writes live here — sending is a direct UI → backend POST (bypasses the DB layer); the sent row
 * lands in IDB via the `NEW_MESSAGE` SSE echo, which this repository caches.
 *
 * **Persistence model:** messages are mirrored to IDB (`messages` store, composite key `[threadId, seq]`,
 * one record per message). Reads are **cache-first + gap-fill**: a held range is served from IDB with no
 * network; only a range the cache genuinely lacks is backfilled from the API (no duplicate pulls of held
 * data). Writes dedup by key (idempotent `put`). Add-only PER MESSAGE — there is no server-side delete
 * command, so individual messages are never removed; the ONE exception is whole-thread cache GC when a
 * thread leaves the user's roster (see {@link deleteByThread}).
 *
 * **Boot/init freshness:** `init` (`skip:0`) always backend-probes + writes through — the SSE stream does
 * NOT replay messages received while the app was closed, so the latest page must be re-read to stay fresh
 * (mirrors the conversation-list snapshot-on-boot). The cache value is in `getOlder`/`getNewer` (`skip:1`):
 * scrolling through already-cached history + live arrivals are cache hits.
 *
 * **NEW_MESSAGE → cache → signal (in that order):** the body is `await`-cached in IDB BEFORE the
 * {@link liveSignal$} fires, so the kernel's subsequent `getNewer` pull (triggered by the signal) is a
 * cache hit, not a backend round-trip.
 */
@Injectable({ providedIn: 'root' })
export class MessageRepository {
  private readonly webdb = inject(WebdbService);
  private readonly ws = inject(WebsocketService);
  private readonly msg = inject(MsgService);

  /**
   * Fires `{threadId, seq}` AFTER a NEW_MESSAGE body has been cached for that thread. The per-thread
   * {@link HttpItemSource} filters to its `threadId` and treats it as "newer data exists, go pull" — the
   * kernel then reads the just-cached body from IDB via `queryMessages` (a cache hit).
   */
  private readonly signal$ = new Subject<{ threadId: number; seq: number }>();
  readonly liveSignal$ = this.signal$.asObservable();

  /** Per-thread highest seq observed (via NEW_MESSAGE or a backend response body). In-memory only —
   *  re-established by the init backend-probe each session. Drives the getNewer cache-hit ceiling test. */
  private readonly maxSeenSeq = new Map<number, number>();

  constructor() {
    // Own the NEW_MESSAGE SSE: cache the body, update the ceiling, THEN emit the live signal. The body
    // is the full Message (serializeBody of the committed row, id-stripped) — the same shape as the
    // /query-messages response, so it caches verbatim.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE' && m.status === 0 && m.data !== undefined))
      .subscribe((m) => void this.onNewMessage(m.data as unknown as Message));
  }

  /**
   * Read a message page — cache-first + gap-fill (mirrors `queryMessageLog` semantics so the source swaps
   * over unchanged). `data` is returned in `orderBy` order (desc = newest-first, asc = oldest-first), just
   * like the backend. Errors degrade to `{ data: [], hasMore: false }` (the source treats an empty page as
   * a boundary) — the cache survives a transient outage.
   *
   * - `skip: 0` (init): backend-probe + write-through (freshness; SSE does not replay offline messages).
   * - `skip: 1` (getOlder/getNewer): cache-first when the held range is contiguous + the far boundary is
   *   known (floor = seq 0 present; ceiling = maxSeenSeq); gap-fill from the API otherwise.
   */
  async queryMessages(
    threadId: number,
    q: MessageQuery,
  ): Promise<{ data: Message[]; hasMore: boolean }> {
    if (q.skip === 0) return this.backend(threadId, q);
    // skip === 1 → getOlder (desc, below lastSeq) / getNewer (asc, above lastSeq): cache-first.
    const anchor = q.lastSeq;
    if (anchor === undefined) return this.backend(threadId, q); // no cursor → can't range the cache
    const cached =
      q.orderBy === 'desc'
        ? await this.rangeDesc(threadId, anchor, q.take)
        : await this.rangeAsc(threadId, anchor, q.take);
    const verdict = this.cacheVerdict(cached, anchor, q.take, q.orderBy, threadId);
    if (verdict.hit) return { data: cached, hasMore: verdict.hasMore };
    return this.backend(threadId, q); // gap-fill: the cache lacks a contiguous held range here
  }

  /**
   * Purge ALL cached message bodies for a thread — the cache-GC counterpart to
   * {@link ThreadRepository.removeThread}. Called when a thread leaves the user's roster (unfriend /
   * self-leave / self-kick / a multi-device THREAD_REVISION DELETE).
   *
   * This is the ONE exception to the add-only rule above. It is NOT a per-message delete (the backend has no
   * such command); it is whole-thread cache garbage collection. The threadId is dead — the backend mints a
   * FRESH threadId on re-friend / re-join (a soft-leave retains the old row server-side only as history), so
   * these cached bytes will never be re-queried. Dropping them reclaims orphaned cache without diverging from
   * server state, exactly as {@link WebdbService.closeAndDelete} reclaims the whole DB on logout. The stale
   * {@link maxSeenSeq} ceiling is cleared too, so the (never-reused) threadId leaves no in-memory residue.
   *
   * Best-effort: IDB unavailable → graceful no-op (a transient miss just leaves the cache behind until the
   * next logout wipes the whole DB).
   */
  async deleteByThread(threadId: number): Promise<void> {
    this.maxSeenSeq.delete(threadId);
    try {
      const db = await this.webdb.db();
      const tx = db.transaction('messages', 'readwrite');
      // Composite-key range delete: every [threadId, *] row in one atomic op (seq is a non-negative int, so
      // the -Infinity..Infinity span is the same idiom the range reads use).
      await tx.store.delete(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
      await tx.done;
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
  }

  /** Backend read + write-through cache. Returns the page in `orderBy` order + the authoritative hasMore. */
  private async backend(
    threadId: number,
    q: MessageQuery,
  ): Promise<{ data: Message[]; hasMore: boolean }> {
    try {
      const res = await firstValueFrom(this.msg.queryMessageLog({ threadId, ...q }));
      const data = res.code === 0 ? (res.data ?? []) : [];
      if (data.length > 0) {
        await this.putMany(data);
        const max = data.reduce((mx, m) => (m.seq > mx ? m.seq : mx), -1);
        const cur = this.maxSeenSeq.get(threadId) ?? -1;
        if (max > cur) this.maxSeenSeq.set(threadId, max);
      }
      return { data, hasMore: res.hasMore ?? data.length >= q.take };
    } catch {
      return { data: [], hasMore: false };
    }
  }

  /** Cache a NEW_MESSAGE body, advance the ceiling, then emit the live signal (cache BEFORE signal). */
  private async onNewMessage(m: Message): Promise<void> {
    if (typeof m?.seq !== 'number' || typeof m?.threadId !== 'number') return;
    await this.put(m);
    const cur = this.maxSeenSeq.get(m.threadId) ?? -1;
    if (m.seq > cur) this.maxSeenSeq.set(m.threadId, m.seq);
    this.signal$.next({ threadId: m.threadId, seq: m.seq });
  }

  /**
   * Decide whether `cached` is a complete, contiguous held range for the query (→ cache hit) or whether
   * the cache lacks data here (→ gap-fill). `cached` is in `orderBy` order (desc: highest-first below the
   * anchor; asc: lowest-first above it). Contiguity is required because multiple jump-to-message windows
   * can fragment the cached set; a gapped range must be backfilled from the API (the contiguous truth).
   */
  private cacheVerdict(
    cached: Message[],
    anchor: number,
    take: number,
    orderBy: 'desc' | 'asc',
    threadId: number,
  ): { hit: boolean; hasMore: boolean } {
    if (cached.length === 0) return { hit: false, hasMore: true };
    const step = orderBy === 'desc' ? -1 : 1;
    for (let i = 0; i < cached.length; i++) {
      if (cached[i].seq !== anchor + step * (i + 1)) return { hit: false, hasMore: true }; // gap
    }
    const lastSeq = cached[cached.length - 1].seq;
    if (orderBy === 'desc') {
      // getOlder: the floor is seq 0 (per-thread seq is 0-indexed + monotonic, no deletion → no holes).
      const reachedFloor = lastSeq === 0;
      const hit = cached.length === take || reachedFloor;
      return { hit, hasMore: hit ? lastSeq > 0 : true };
    }
    // getNewer: the ceiling is maxSeenSeq (the newest seq observed via NEW_MESSAGE / a backend page).
    const ceiling = this.maxSeenSeq.get(threadId);
    const reachedCeiling = ceiling !== undefined && lastSeq >= ceiling;
    const hit = cached.length === take || reachedCeiling;
    return { hit, hasMore: hit ? ceiling !== undefined && lastSeq < ceiling : true };
  }

  // ── IDB range helpers (best-effort; IDB unavailable → empty → gap-fill) ─────────────────────

  /** The `take` messages with seq < `belowSeq`, highest-first (desc). */
  private async rangeDesc(threadId: number, belowSeq: number, take: number): Promise<Message[]> {
    try {
      const db = await this.webdb.db();
      const range = IDBKeyRange.bound([threadId, -Infinity], [threadId, belowSeq], false, true);
      return await this.collect(db, range, 'prev', take);
    } catch {
      return [];
    }
  }

  /** The `take` messages with seq > `aboveSeq`, lowest-first (asc). */
  private async rangeAsc(threadId: number, aboveSeq: number, take: number): Promise<Message[]> {
    try {
      const db = await this.webdb.db();
      const range = IDBKeyRange.bound([threadId, aboveSeq], [threadId, Infinity], true, false);
      return await this.collect(db, range, 'next', take);
    } catch {
      return [];
    }
  }

  private async collect(
    db: Awaited<ReturnType<WebdbService['db']>>,
    range: IDBKeyRange,
    direction: 'next' | 'prev',
    take: number,
  ): Promise<Message[]> {
    const out: Message[] = [];
    let cursor = await db.transaction('messages').store.openCursor(range, direction);
    while (cursor && out.length < take) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  /** Idempotent put by `[threadId, seq]` (the keyPath) — writing the same key twice just overwrites. */
  private async put(m: Message): Promise<void> {
    try {
      await (await this.webdb.db()).put('messages', m);
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
  }

  private async putMany(msgs: Message[]): Promise<void> {
    try {
      const db = await this.webdb.db();
      const tx = db.transaction('messages', 'readwrite');
      for (const m of msgs) await tx.store.put(m);
      await tx.done;
    } catch {
      /* best-effort */
    }
  }
}
