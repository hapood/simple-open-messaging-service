import { Injectable, inject, effect } from '@angular/core';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MsgService } from './message.service';
import { UserService } from './user.service';
import {
  Message,
  QueryMessageLogParams,
  MEDIA_STATUS,
  MediaStatus,
} from './model';
import { ThreadDeletionLockService } from './thread-deletion-lock.service';

/** The read query shape — mirrors `MsgService.queryMessageLog` params (so the source swaps over 1:1). */
export type MessageQuery = Pick<
  QueryMessageLogParams,
  'skip' | 'take' | 'lastSeq' | 'orderBy'
>;

/** The client's stored media-status state for one message: its current status + the monotonic version of
 *  the event that last set it. 'downloading' is a client-only optimistic state (set directly on a manual
 *  retry click); 'ready'/'failed' are backend terminals (stored in IDB + pushed via MEDIA_STATUS). */
export interface StoredMediaStatus {
  status: MediaStatus;
  sv: number;
}

/**
 * Pure reducer — the single decision point every mediaStatus terminal ('ready'|'failed') update flows
 * through (SSE MEDIA_STATUS, the scroll probe, the manual-retry ack). Given the current stored state and
 * a backend terminal event, returns the next state or null to reject (no write, no signal):
 *  - Anti-regression: an event with sv ≤ the applied sv is dropped — a stale out-of-order frame (a
 *    reconnect replay, or a probe racing a newer SSE). Backend terminals always carry a strictly greater
 *    sv (its Date.now), so once 'ready' a stale 'failed' cannot un-ready it; a retry's fresh 'ready'
 *    (greater sv) still wins over an older 'failed'.
 *  - Idempotent: the same {status, sv} already applied is a no-op.
 * 'downloading' is never produced here — it is a client optimistic state set directly by
 * {@link MessageRepository.setMediaDownloading} (which keeps sv), so any later backend terminal (greater
 * sv) overrides it.
 */
export function reduceMediaStatus(
  cur: StoredMediaStatus | undefined,
  ev: { status: 'ready' | 'failed'; sv: number },
): StoredMediaStatus | null {
  if (cur && ev.sv <= cur.sv) return null; // stale / out-of-order → drop
  if (cur && cur.status === ev.status && cur.sv === ev.sv) return null; // idempotent
  return { status: ev.status, sv: ev.sv };
}

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
 * **Boot/init freshness:** `init` (`skip:0`) is stale-while-revalidate: a contiguous latest page already
 * held in IDB is returned immediately, while a backend probe refreshes the page in the background. If that
 * probe discovers a newer seq it emits the normal live signal, so the priming kernel replays/pulls the delta.
 * A cold/fragmented cache still awaits the backend. `getOlder`/`getNewer` (`skip:1`) remain cache-first with
 * gap-fill.
 *
 * **NEW_MESSAGE → cache → signal (in that order):** the body is `await`-cached in IDB BEFORE the
 * {@link liveSignal$} fires, so the kernel's subsequent `getNewer` pull (triggered by the signal) is a
 * cache hit, not a backend round-trip.
 */
@Injectable({ providedIn: 'root' })
export class MessageRepository {
  private readonly deletionLock = inject(ThreadDeletionLockService);
  private readonly webdb = inject(WebdbService);
  private readonly ws = inject(WebsocketService);
  private readonly msg = inject(MsgService);
  private readonly userService = inject(UserService);

  /**
   * Fires `{threadId, seq}` AFTER a NEW_MESSAGE body has been cached for that thread. The per-thread
   * {@link HttpItemSource} filters to its `threadId` and treats it as "newer data exists, go pull" — the
   * kernel then reads the just-cached body from IDB via `queryMessages` (a cache hit).
   */
  private readonly signal$ = new Subject<{ threadId: number; seq: number }>();
  readonly liveSignal$ = this.signal$.asObservable();

  /**
   * Fires `{threadId, seq}` after a message's mediaStatus changed in IDB (a MEDIA_STATUS terminal, a
   * scroll-probe correction, or a manual-retry optimistic 'downloading'). The per-thread HttpItemSource
   * filters to its threadId and calls `kernel.updateItemData(seq)` to re-render that one card in place
   * (zero height change — the status overlay/meta slot never alter the cell's measured height).
   */
  private readonly mediaStatusSignal$ = new Subject<{
    threadId: number;
    seq: number;
    status: MediaStatus;
  }>();
  readonly mediaStatusLive$ = this.mediaStatusSignal$.asObservable();

  /** Per-thread highest seq observed (via NEW_MESSAGE or a backend response body). In-memory only —
   *  re-established by the init backend-probe each session. Drives the getNewer cache-hit ceiling test. */
  private readonly maxSeenSeq = new Map<number, number>();

  /** Previous sessionProfile id seen by the session-end effect (null = no logged-in user). */
  private prevSessionId: number | null = null;

  constructor() {
    // Own the NEW_MESSAGE SSE: identity-only {threadId, seq, ts} (no body — single data source = pull).
    // Advance the per-thread ceiling + emit the live signal so the open chat-box pulls the body via
    // getNewer; nothing is cached here (the body arrives via the missed-summary pull / query-messages).
    this.ws.eventSubject
      .pipe(
        filter(
          (m) =>
            m.event === 'NEW_MESSAGE' &&
            m.status === 0 &&
            m.data !== undefined &&
            !this.deletionLock.has((m.data as { threadId: number }).threadId),
        ),
      )
      .subscribe((m) =>
        this.onNewMessage(
          m.data as { threadId: number; seq: number; ts: number },
        ),
      );

    // Own the MEDIA_STATUS SSE: a federated media message finished localizing ('ready') or failed
    // ('failed'). Flow it through the reducer (anti-regression by sv) + IDB write + the mediaStatus signal
    // so the card flips off its optimistic 'downloading'. The frame is {threadId, seq, status, v}.
    this.ws.eventSubject
      .pipe(
        filter(
          (m) =>
            m.event === 'MEDIA_STATUS' &&
            m.status === 0 &&
            m.data !== undefined,
        ),
      )
      .subscribe((m) => {
        const d = m.data as unknown as {
          threadId: number;
          seq: number;
          status: 'ready' | 'failed';
          v: number;
        };
        if (this.deletionLock.has(d.threadId)) return;
        if (
          typeof d?.threadId === 'number' &&
          typeof d?.seq === 'number' &&
          (d.status === 'ready' || d.status === 'failed')
        ) {
          void this.applyMediaStatus(d.threadId, d.seq, d.status, d.v, 'sse');
        }
      });

    // Session-end reset: maxSeenSeq is documented "in-memory only — re-established by the init
    // backend-probe each session", so it must not survive an account switch (a stale ceiling from the
    // previous user could make getNewer falsely report the cache reached its ceiling). The IDB messages
    // store is per-user and wiped by WebdbService; this clears the in-memory ceiling. Driven by the same
    // sessionProfile signal the other session-scoped caches watch.
    effect(() => {
      const id = this.userService.sessionProfile()?.id ?? null;
      if (id === this.prevSessionId) return;
      this.prevSessionId = id;
      if (id === null) this.reset();
    });
  }

  /** Drop in-memory session state (logout / account switch). IDB is wiped per-user by WebdbService. */
  private reset(): void {
    this.maxSeenSeq.clear();
  }

  /**
   * Read a message page — cache-first + gap-fill (mirrors `queryMessageLog` semantics so the source swaps
   * over unchanged). `data` is returned in `orderBy` order (desc = newest-first, asc = oldest-first), just
   * like the backend. Errors degrade to `{ data: [], hasMore: false }` (the source treats an empty page as
   * a boundary) — the cache survives a transient outage.
   *
   * - latest `skip: 0` (init): always return after the local IDB read, including a valid empty result;
   *   backend revalidation is background-only and wakes the mounted kernel when it discovers data.
   * - `skip: 1` (getOlder/getNewer): cache-first when the held range is contiguous + the far boundary is
   *   known (floor = seq 0 present; ceiling = maxSeenSeq); gap-fill from the API otherwise.
   */
  async queryMessages(
    threadId: number,
    q: MessageQuery,
    clearedAfter?: number | null,
    localOnly = false,
  ): Promise<{ data: Message[]; hasMore: boolean }> {
    if (q.skip === 0 && q.orderBy === 'desc' && q.lastSeq === undefined) {
      const cached = await this.latestPage(threadId, q.take, clearedAfter);
      if (cached.length > 0) {
        if (!localOnly) void this.refreshLatest(threadId, q, cached[0]?.seq);
        const oldestSeq = cached[cached.length - 1].seq;
        return {
          data: cached,
          hasMore: oldestSeq > 0,
        };
      }
      if (localOnly) return { data: [], hasMore: false };
    }
    if (q.skip === 0) return this.backend(threadId, q);
    // skip === 1 → getOlder (desc, below lastSeq) / getNewer (asc, above lastSeq): cache-first.
    const anchor = q.lastSeq;
    if (anchor === undefined) return this.backend(threadId, q); // no cursor → can't range the cache
    const cached =
      q.orderBy === 'desc'
        ? await this.rangeDesc(threadId, anchor, q.take, clearedAfter)
        : await this.rangeAsc(threadId, anchor, q.take, clearedAfter);
    const verdict = this.cacheVerdict(
      cached,
      anchor,
      q.take,
      q.orderBy,
      threadId,
    );
    if (verdict.hit) return { data: cached, hasMore: verdict.hasMore };
    if (localOnly) return { data: [], hasMore: false };
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
      await this.webdb.deleteMessagesByThread(threadId);
    } catch {
      /* local store unavailable / closed — cache is best-effort */
    }
  }

  /** Backend read + write-through cache. Returns the page in `orderBy` order + the authoritative hasMore. */
  private async backend(
    threadId: number,
    q: MessageQuery,
  ): Promise<{ data: Message[]; hasMore: boolean }> {
    try {
      const res = await firstValueFrom(
        this.msg.queryMessageLog({ threadId, ...q }),
      );
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

  /** Refresh a locally completed latest page and wake the open kernel when the server has any data beyond
   *  the local tail. `cachedNewestSeq === undefined` is the valid empty-cache case. */
  async refreshLatest(
    threadId: number,
    q: MessageQuery,
    cachedNewestSeq: number | undefined,
  ): Promise<void> {
    const fresh = await this.backend(threadId, q);
    const freshNewestSeq = fresh.data[0]?.seq;
    if (
      freshNewestSeq !== undefined &&
      (cachedNewestSeq === undefined || freshNewestSeq > cachedNewestSeq)
    ) {
      this.signal$.next({ threadId, seq: freshNewestSeq });
    }
  }

  /** Identity-only NEW_MESSAGE — the SSE frame carries only {threadId, seq, ts} (no body). Advance the
   *  per-thread ceiling + emit the live signal so the open chat-box pulls the body via getNewer; the body
   *  is never carried on the realtime stream (single data source = pull). */
  private onNewMessage(d: { threadId: number; seq: number; ts: number }): void {
    if (typeof d?.seq !== 'number' || typeof d?.threadId !== 'number') return;
    this.advanceCeiling(d.threadId, d.seq);
    this.signal$.next({ threadId: d.threadId, seq: d.seq });
  }

  /** Cache a batch of missed messages (the latest-message-per-thread from the `POST /notifications/missed`
   *  summary), advancing the per-thread ceiling and emitting ONE live signal per affected thread (its
   *  highest seq in the batch) so each open {@link HttpItemSource} pulls once. Idempotent via the
   *  `[threadId, seq]` keyPath — a re-put of the same message is a no-op overwrite. (The missed endpoint's
   *  strict-total-order `id > cursor` cursor never re-fetches a row across pages, so this idempotency is
   *  no longer load-bearing for pagination dedup — it remains a safety net for the SSE-echo-vs-missed
   *  overlap: a message you sent is cached via the NEW_MESSAGE echo, and may ALSO appear in a missed pull.)
   *
   *  This is the SAME apply path a live SSE NEW_MESSAGE's pull takes, so realtime + catch-up populate the
   *  store identically. It does NOT touch `eventSubject`, so {@link UnreadAttentionService} (subscribed to
   *  NEW_MESSAGE there) is NOT triggered — the threadlist snapshot owns unread; this only hydrates message
   *  bodies (so opening a thread is instant + recent history survives offline). */
  async applyMissed(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await this.putMany(messages);
    const topSeqByThread = new Map<number, number>();
    for (const m of messages) {
      if (typeof m?.seq !== 'number' || typeof m?.threadId !== 'number')
        continue;
      this.advanceCeiling(m.threadId, m.seq);
      const prev = topSeqByThread.get(m.threadId) ?? -1;
      if (m.seq > prev) topSeqByThread.set(m.threadId, m.seq);
    }
    for (const [threadId, seq] of topSeqByThread)
      this.signal$.next({ threadId, seq });
  }

  /** Advance the per-thread seq ceiling (drives the getNewer cache-hit test) if `seq` is newer. */
  private advanceCeiling(threadId: number, seq: number): void {
    const cur = this.maxSeenSeq.get(threadId) ?? -1;
    if (seq > cur) this.maxSeenSeq.set(threadId, seq);
  }

  /** The newest cached message (highest seq) for EACH threadId, fetched in ONE read transaction: one reverse
   *  cursor per thread on a shared transaction (the first entry in `[threadId, *]` desc is that thread's
   *  highest seq). The local-first source {@link ThreadRepository.hydratePreviews} derives every list preview
   *  from in a single pass — O(threadIds) first-entry reads on one transaction, never N independent lookups
   *  and never a full-table scan. Threads with no cached message are simply absent from the map. */
  async getNewestMessages(threadIds: number[]): Promise<Map<number, Message>> {
    const out = new Map<number, Message>();
    if (threadIds.length === 0) return out;
    try {
      const messages = await this.webdb.getNewestMessages(threadIds);
      for (const message of messages) out.set(message.threadId, message);
      return out;
    } catch {
      return out;
    }
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
      if (cached[i].seq !== anchor + step * (i + 1))
        return { hit: false, hasMore: true }; // gap
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
    return {
      hit,
      hasMore: hit ? ceiling !== undefined && lastSeq < ceiling : true,
    };
  }

  // ── IDB range helpers (best-effort; IDB unavailable → empty → gap-fill) ─────────────────────

  /** Latest cached page, newest-first. Message seq is monotonic but not required to be contiguous, so gaps
   *  are valid and must never be interpreted as cache corruption. */
  private async latestPage(
    threadId: number,
    take: number,
    clearedAfter?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'desc', take)
      ).filter((m) => clearedAfter == null || m.createdAt > clearedAfter);
    } catch {
      return [];
    }
  }

  /** The `take` messages with seq < `belowSeq`, highest-first (desc). */
  private async rangeDesc(
    threadId: number,
    belowSeq: number,
    take: number,
    clearedAfter?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'desc', take, belowSeq)
      ).filter((m) => clearedAfter == null || m.createdAt > clearedAfter);
    } catch {
      return [];
    }
  }

  /** The `take` messages with seq > `aboveSeq`, lowest-first (asc). */
  private async rangeAsc(
    threadId: number,
    aboveSeq: number,
    take: number,
    clearedAfter?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'asc', take, aboveSeq)
      ).filter((m) => clearedAfter == null || m.createdAt > clearedAfter);
    } catch {
      return [];
    }
  }

  /** Idempotent put by `[threadId, seq]` (the keyPath) — writing the same key twice just overwrites. */
  private async put(m: Message): Promise<void> {
    try {
      await this.webdb.putMessages([m]);
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
  }

  private async putMany(msgs: Message[]): Promise<void> {
    try {
      await this.webdb.putMessages(msgs);
    } catch {
      /* best-effort */
    }
  }

  /** Read one cached message by its composite key [threadId, seq] (best-effort; undefined when IDB is
   *  unavailable or the message was never cached). */
  private async getOne(
    threadId: number,
    seq: number,
  ): Promise<Message | undefined> {
    try {
      return await this.webdb.getMessage(threadId, seq);
    } catch {
      return undefined;
    }
  }

  /**
   * Apply a backend mediaStatus terminal ('ready'|'failed') through the pure {@link reduceMediaStatus}
   * (anti-regression by sv + idempotent). On accept: write IDB, then emit the mediaStatus signal so the
   * kernel re-renders the one card in place. THE single entry point for SSE MEDIA_STATUS, the scroll
   * probe, and the manual-retry ack — three sources, one truth. Returns true iff the state changed.
   * Best-effort: a not-cached message (never pulled) is a no-op (the next query-messages carries the
   * authoritative status from the backend).
   */
  async applyMediaStatus(
    threadId: number,
    seq: number,
    status: 'ready' | 'failed',
    sv: number,
    _source: 'sse' | 'probe' | 'retry' = 'sse',
  ): Promise<boolean> {
    const cur = await this.getOne(threadId, seq);
    if (!cur) return false;
    const curState: StoredMediaStatus | undefined =
      cur.mediaStatus !== undefined
        ? { status: cur.mediaStatus, sv: cur.sv ?? 0 }
        : undefined;
    const next = reduceMediaStatus(curState, { status, sv });
    if (!next) return false;
    await this.put({ ...cur, mediaStatus: next.status, sv: next.sv });
    this.mediaStatusSignal$.next({ threadId, seq, status: next.status });
    return true;
  }

  /**
   * Optimistic 'downloading' flip on a manual retry click — bypasses the reducer ('downloading' is a
   * client-only transient, not a backend terminal) and KEEPS sv, so the eventual backend terminal (a
   * strictly greater sv) always wins via {@link applyMediaStatus}. Emits the signal for an immediate
   * spinner. Best-effort (IDB unavailable → no-op; the SSE terminal still lands and corrects it).
   */
  async setMediaDownloading(threadId: number, seq: number): Promise<void> {
    const cur = await this.getOne(threadId, seq);
    if (!cur || cur.mediaStatus === MEDIA_STATUS.DOWNLOADING) return;
    await this.put({ ...cur, mediaStatus: MEDIA_STATUS.DOWNLOADING });
    this.mediaStatusSignal$.next({
      threadId,
      seq,
      status: MEDIA_STATUS.DOWNLOADING,
    });
  }

  /**
   * Bulk-apply a scroll-probe result: each entry flows through {@link applyMediaStatus} (per-row reduce),
   * emitting a signal per changed row so each card flips as its row resolves (no batch latency). The
   * scroll probe is the SSE backstop — it corrects statuses the client missed while disconnected.
   */
  async markMediaStatusBatch(
    threadId: number,
    entries: Array<{ seq: number; status: 'ready' | 'failed'; sv: number }>,
  ): Promise<void> {
    for (const e of entries) {
      await this.applyMediaStatus(threadId, e.seq, e.status, e.sv, 'probe');
    }
  }
}
