import { Injectable, inject, effect } from '@angular/core';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { MessageCoverageState, WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MsgService } from './message.service';
import { UserService } from './user.service';
import {
  Message,
  QueryMessageLogParams,
  MEDIA_STATUS,
  MediaStatus,
  StandardResponse,
} from './model';
import { ThreadDeletionLockService } from './thread-deletion-lock.service';
import { SingleFlight } from '../lib/single-flight';

/** The read query shape — mirrors `MsgService.queryMessageLog` params (so the source swaps over 1:1). */
export type MessageQuery = Pick<
  QueryMessageLogParams,
  'skip' | 'take' | 'lastSeq' | 'orderBy' | 'truncate' | 'truncateSeq'
>;

export interface MessagePage {
  data: Message[];
  hasMore: boolean;
  truncated?: boolean;
  /** Transport/business failure: never interpret an empty data array as a confirmed edge. */
  failed?: boolean;
}

interface CommittedFill extends MessagePage {
  confirmedEndSeq?: number;
}

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
 * data). Server-confirmed complete blocks are persisted as sparse `sectionLeft` / `sectionRight` markers
 * on their endpoint messages, so legitimate seq gaps remain reusable after a restart. Writes dedup by key
 * (idempotent `put`). Add-only PER MESSAGE — there is no server-side delete
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
   * Each {@link HttpItemSource} filters to its `threadId` and treats it as "newer data exists, go pull".
   * Multiple chatboxes therefore share one cutoff/fill lane but retain independent viewport demands.
   */
  private readonly signal$ = new Subject<{ threadId: number; seq: number }>();
  readonly liveSignal$ = this.signal$.asObservable();
  private readonly deletedSignal$ = new Subject<{
    threadId: number;
    seqs: number[];
  }>();
  readonly deletedLive$ = this.deletedSignal$.asObservable();
  private readonly deletedSyncs = new Map<number, Promise<void>>();

  /** Successful transport reconnect. The repository clears the finite HTTP cutoff before waking views. */
  private readonly reconnectSignal = new Subject<void>();
  readonly reconnectSignal$ = this.reconnectSignal.asObservable();

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
  /** Shared finite upper bound for a newer walk. Reconnect clears it because frames may be missing. */
  private readonly newerTruncateSeq = new Map<number, number>();
  /** Coverage summaries exist in memory only while at least one chatbox source retains the thread. */
  private readonly activeCoverage = new Map<
    number,
    { refs: number; state?: MessageCoverageState; loading: Promise<void> }
  >();
  /** Same-start HTTP fills share one request regardless of count/cutoff. The promise resolves only after
   *  its response has committed to DB; every waiter then reloads its own rows from DB. */
  private readonly inflightFills = new SingleFlight<string, CommittedFill>();

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

    this.ws.eventSubject
      .pipe(
        filter(
          (m) =>
            m.event === 'DELETED_MESSAGE_UPDATED' &&
            m.status === 0 &&
            m.data !== undefined,
        ),
      )
      .subscribe((m) => {
        const d = m.data as { threadId: number };
        if (typeof d.threadId === 'number') void this.syncDeleted(d.threadId);
      });

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

    this.ws.reconnect$.subscribe(() => {
      this.newerTruncateSeq.clear();
      this.reconnectSignal.next();
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
    this.newerTruncateSeq.clear();
    this.activeCoverage.clear();
    // Requests already on the wire are not cancelled, but a new session must never subscribe to them.
    // Their captured cache lifetime prevents their eventual response from writing the recreated DB.
    this.inflightFills.clear();
  }

  /** Shared finite cutoff for all chatboxes mounted on the same thread. */
  getNewerTruncateSeq(threadId: number): number | undefined {
    return this.newerTruncateSeq.get(threadId);
  }

  /** Reconcile conversation metadata/live init state into the shared per-thread ceiling. */
  retainNewestSeq(threadId: number, seq: number): void {
    if (Number.isSafeInteger(seq) && seq >= 0)
      this.advanceCeiling(threadId, seq, false);
  }

  /** Open-chat lifecycle hook: hydrate the durable O(1) tail summary once for this mounted thread. */
  retainCoverage(threadId: number, knownNewestSeq?: number): void {
    void this.syncDeleted(threadId);
    const active = this.activeCoverage.get(threadId);
    if (active) {
      active.refs++;
      if (knownNewestSeq !== undefined)
        this.advanceCeiling(threadId, knownNewestSeq);
      return;
    }
    const entry: {
      refs: number;
      state?: MessageCoverageState;
      loading: Promise<void>;
    } = {
      refs: 1,
      loading: Promise.resolve(),
    };
    this.activeCoverage.set(threadId, entry);
    entry.loading = this.webdb
      .getMessageCoverage(threadId)
      .then(async (stored) => {
        if (this.activeCoverage.get(threadId) !== entry) return;
        const newestSeq = Math.max(
          stored?.knownNewestSeq ?? -1,
          knownNewestSeq ?? -1,
          this.maxSeenSeq.get(threadId) ?? -1,
        );
        if (newestSeq < 0) return;
        this.maxSeenSeq.set(threadId, newestSeq);
        entry.state =
          stored?.knownNewestSeq === newestSeq
            ? stored
            : {
                threadId,
                knownNewestSeq: newestSeq,
                coveredTail: stored?.coveredTail ?? null,
              };
        if (stored?.knownNewestSeq !== newestSeq) {
          const coverage = await this.webdb.putMessages([], undefined, {
            threadId,
            seq: newestSeq,
          });
          if (this.activeCoverage.get(threadId) === entry && coverage)
            entry.state = coverage;
        }
      });
  }

  syncDeleted(threadId: number): Promise<void> {
    const existing = this.deletedSyncs.get(threadId);
    if (existing) return existing;
    const run = this.syncDeletedInternal(threadId).finally(() => {
      if (this.deletedSyncs.get(threadId) === run)
        this.deletedSyncs.delete(threadId);
    });
    this.deletedSyncs.set(threadId, run);
    return run;
  }

  private async syncDeletedInternal(threadId: number): Promise<void> {
    let hwm = await this.webdb.getDeletedHwm(threadId);
    for (;;) {
      const res = await firstValueFrom(
        this.msg.queryDeletedMessages({ threadId, afterId: hwm, take: 100 }),
      );
      if (res.code !== 0 || !res.data) return;
      const items = res.data;
      const next = items.at(-1)?.id ?? hwm;
      await this.webdb.applyDeletedMessages(threadId, items, next);
      if (items.length) {
        this.deletedSignal$.next({
          threadId,
          seqs: items.map((item) => item.seq),
        });
      }
      hwm = next;
      if (!res.hasMore || items.length === 0) return;
    }
  }

  /** Close-chat lifecycle hook: the durable summary remains, only its memory acceleration is released. */
  releaseCoverage(threadId: number): void {
    const active = this.activeCoverage.get(threadId);
    if (!active) return;
    if (--active.refs === 0) this.activeCoverage.delete(threadId);
  }

  /**
   * Read a message page — cache-first + gap-fill (mirrors `queryMessageLog` semantics so the source swaps
   * over unchanged). `data` is returned in `orderBy` order (desc = newest-first, asc = oldest-first), just
   * like the backend. Transport/business failures carry `failed:true`; callers must not interpret their
   * empty data as a confirmed boundary.
   *
   * - latest `skip: 0` (init): always return after the local IDB read, including a valid empty result;
   *   backend revalidation is background-only and wakes the mounted kernel when it discovers data.
   * - `skip: 1` (getOlder/getNewer): cache-first when the held range is contiguous + the far boundary is
   *   known (floor = seq 1 present; ceiling = maxSeenSeq); gap-fill from the API otherwise. A server may
   *   start above 1, so only observing seq 1 proves the lower boundary locally.
   */
  async queryMessages(
    threadId: number,
    q: MessageQuery,
    clearedThroughSeq?: number | null,
    localOnly = false,
  ): Promise<MessagePage> {
    if (localOnly)
      return this.queryMessagesInternal(threadId, q, clearedThroughSeq, true);
    return this.queryMessagesInternal(threadId, q, clearedThroughSeq, false);
  }

  private async queryMessagesInternal(
    threadId: number,
    q: MessageQuery,
    clearedThroughSeq?: number | null,
    localOnly = false,
  ): Promise<MessagePage> {
    if (q.skip === 0 && q.orderBy === 'desc' && q.lastSeq === undefined) {
      const cached = await this.latestPage(threadId, q.take, clearedThroughSeq);
      if (cached.length > 0) {
        if (!localOnly)
          void this.refreshLatest(
            threadId,
            q,
            cached[0]?.seq,
            cached[cached.length - 1]?.seq,
          );
        const oldestSeq = cached[cached.length - 1].seq;
        return {
          data: cached,
          hasMore: oldestSeq > 1,
        };
      }
      if (localOnly) return { data: [], hasMore: false };
    }
    if (q.skip === 0) {
      const anchor = q.lastSeq;
      if (anchor === undefined) return this.backend(threadId, q);
      if (localOnly) {
        const anchorRow = await this.getOne(threadId, anchor);
        if (!anchorRow) return { data: [], hasMore: false };
        const tail =
          q.orderBy === 'desc'
            ? await this.rangeDesc(
                threadId,
                anchor,
                Math.max(0, q.take - 1),
                clearedThroughSeq,
              )
            : await this.rangeAsc(
                threadId,
                anchor,
                Math.max(0, q.take - 1),
                clearedThroughSeq,
              );
        const last = tail[tail.length - 1] ?? anchorRow;
        const hasMore =
          q.orderBy === 'desc'
            ? last.seq > 1
            : this.maxSeenSeq.get(threadId) === undefined ||
              last.seq < this.maxSeenSeq.get(threadId)!;
        return { data: [anchorRow, ...tail], hasMore };
      }
      return this.queryAnchoredHybrid(threadId, q, anchor, clearedThroughSeq);
    }
    // skip === 1 → getOlder (desc, below lastSeq) / getNewer (asc, above lastSeq): cache-first.
    const anchor = q.lastSeq;
    if (anchor === undefined) return this.backend(threadId, q); // no cursor → can't range the cache
    if (!localOnly)
      return this.queryHybrid(threadId, q, anchor, clearedThroughSeq);
    const cached =
      q.orderBy === 'desc'
        ? await this.rangeDesc(threadId, anchor, q.take, clearedThroughSeq)
        : await this.rangeAsc(threadId, anchor, q.take, clearedThroughSeq);
    const verdict = await this.cacheVerdict(
      cached,
      anchor,
      q.take,
      q.orderBy,
      threadId,
    );
    if (verdict.hit) return { data: cached, hasMore: verdict.hasMore };
    return { data: [], hasMore: false };
  }

  /** Include the middle anchor exactly once, then use the normal exclusive-cursor hybrid walker. */
  private async queryAnchoredHybrid(
    threadId: number,
    q: MessageQuery,
    anchor: number,
    clearedThroughSeq?: number | null,
  ): Promise<MessagePage> {
    const localAnchor = await this.getOne(threadId, anchor);
    if (
      localAnchor &&
      (clearedThroughSeq == null || localAnchor.seq > clearedThroughSeq)
    ) {
      if (q.take === 1) return { data: [localAnchor], hasMore: true };
      const tail = await this.queryHybrid(
        threadId,
        { ...q, skip: 1, take: q.take - 1 },
        anchor,
        clearedThroughSeq,
      );
      return {
        data: [localAnchor, ...tail.data],
        hasMore: tail.hasMore,
        truncated: tail.truncated,
        failed: tail.failed,
      };
    }

    const cached =
      q.orderBy === 'desc'
        ? await this.rangeDesc(threadId, anchor, q.take, clearedThroughSeq)
        : await this.rangeAsc(threadId, anchor, q.take, clearedThroughSeq);
    const boundary = this.nearestBoundary(anchor, cached[0]?.seq, q);
    const first = await this.backend(threadId, {
      ...q,
      truncate: boundary !== undefined,
      truncateSeq: boundary,
    });
    if (first.failed) return first;
    if (
      !first.truncated ||
      first.data.length >= q.take ||
      boundary === q.truncateSeq
    )
      return first;

    const step = q.orderBy === 'desc' ? -1 : 1;
    const tail = await this.queryHybrid(
      threadId,
      { ...q, skip: 1, take: q.take - first.data.length },
      boundary! - step,
      clearedThroughSeq,
    );
    return {
      data: [...first.data, ...tail.data],
      hasMore: tail.hasMore,
      truncated: tail.truncated,
    };
  }

  /**
   * Assemble one requested page from alternating local and remote contiguous segments. A remote segment
   * is bounded at the nearest cached row in its direction, so it never re-downloads the cached tail. Once
   * the backend reports that boundary reached (`truncated`), the next loop consumes local rows immediately;
   * if those still do not fill `take`, the following gap is fetched with only the remaining count.
   */
  private async queryHybrid(
    threadId: number,
    q: MessageQuery,
    anchor: number,
    clearedThroughSeq?: number | null,
  ): Promise<MessagePage> {
    const out: Message[] = [];
    let cursor = anchor;
    let remaining = q.take;
    let hasMore = true;
    let reachedRequestedTruncate = false;
    const step = q.orderBy === 'desc' ? -1 : 1;

    while (remaining > 0 && hasMore) {
      const cached =
        q.orderBy === 'desc'
          ? await this.rangeDesc(threadId, cursor, remaining, clearedThroughSeq)
          : await this.rangeAsc(threadId, cursor, remaining, clearedThroughSeq);

      // Consume the longest locally contiguous prefix adjacent to the current cursor.
      let localCount = 0;
      let localCursor = cursor;
      while (
        localCount < cached.length &&
        (await this.isCompleteRange(
          threadId,
          localCursor,
          cached[localCount].seq,
        )) &&
        this.withinRequestedTruncate(cached[localCount].seq, q)
      ) {
        localCursor = cached[localCount].seq;
        localCount++;
      }
      if (localCount > 0) {
        const local = cached.slice(0, localCount);
        out.push(...local);
        remaining -= local.length;
        cursor = local[local.length - 1].seq;
        if (q.truncate && cursor === q.truncateSeq) {
          reachedRequestedTruncate = true;
          hasMore = false;
        } else if (q.orderBy === 'desc' && cursor === 1) {
          hasMore = false;
        } else if (
          q.orderBy === 'asc' &&
          this.maxSeenSeq.get(threadId) !== undefined &&
          cursor >= this.maxSeenSeq.get(threadId)!
        ) {
          hasMore = false;
        }
        continue;
      }

      // The closest cached row marks the end of this remote gap. If the caller supplied a stricter
      // boundary (post-init frozen newest seq), use whichever endpoint comes first in this direction.
      const cachedBoundary = cached[0]?.seq;
      const remoteBoundary = this.nearestBoundary(cursor, cachedBoundary, q);
      const remote = await this.backend(threadId, {
        ...q,
        skip: 1,
        take: remaining,
        lastSeq: cursor,
        truncate: remoteBoundary !== undefined,
        truncateSeq: remoteBoundary,
      });
      if (remote.failed) {
        return {
          data: out,
          hasMore: true,
          failed: true,
        };
      }
      const remoteData = remote.data.slice(0, remaining);
      if (remoteData.length === 0) {
        if (remote.truncated && remoteBoundary !== q.truncateSeq) {
          // The empty remote gap ended immediately before an existing cached row. Rebase the synthetic
          // cursor one step before that row so the next pass consumes the row locally.
          cursor = remoteBoundary! - step;
          hasMore = true;
          continue;
        }
        hasMore = false;
        reachedRequestedTruncate = remote.truncated === true;
        break;
      }
      out.push(...remoteData);
      remaining -= remoteData.length;
      cursor = remoteData[remoteData.length - 1].seq;
      hasMore = remote.hasMore;
      if (remote.truncated) {
        // Clear the just-hit local cutoff by continuing from its row. If it was the caller's ultimate
        // cutoff, this whole request is complete instead.
        if (remoteBoundary === q.truncateSeq) {
          reachedRequestedTruncate = true;
          hasMore = false;
        } else {
          cursor = remoteBoundary! - step;
          hasMore = true;
        }
      }
    }

    const result = {
      data: out,
      hasMore: remaining === 0 ? hasMore : false,
      truncated: reachedRequestedTruncate,
    };
    return result;
  }

  private withinRequestedTruncate(seq: number, q: MessageQuery): boolean {
    if (!q.truncate || q.truncateSeq === undefined) return true;
    return q.orderBy === 'asc' ? seq < q.truncateSeq : seq > q.truncateSeq;
  }

  private nearestBoundary(
    cursor: number,
    cachedBoundary: number | undefined,
    q: MessageQuery,
  ): number | undefined {
    const requested = q.truncate ? q.truncateSeq : undefined;
    const candidates = [cachedBoundary, requested].filter(
      (seq): seq is number =>
        seq !== undefined &&
        (q.orderBy === 'asc' ? seq > cursor : seq < cursor),
    );
    if (candidates.length === 0) return undefined;
    return q.orderBy === 'asc'
      ? Math.min(...candidates)
      : Math.max(...candidates);
  }

  private async isCompleteRange(
    threadId: number,
    a: number,
    b: number,
  ): Promise<boolean> {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    // There is no integer seq between adjacent rows, so this hop is intrinsically complete even for
    // pre-v3 cached messages that have not acquired persisted section markers yet.
    if (to - from === 1) return true;
    const active = this.activeCoverage.get(threadId);
    if (active) {
      await active.loading;
      const tail = active.state;
      if (
        tail?.coveredTail != null &&
        from >= tail.coveredTail.left &&
        to <= tail.coveredTail.right
      )
        return true;
    }
    const section = await this.webdb.getMessageSection(threadId, a);
    return section !== undefined && from >= section.left && to <= section.right;
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
    this.activeCoverage.delete(threadId);
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
  ): Promise<MessagePage> {
    const waiterLifetime = this.webdb.captureMessageLifetime();
    const key =
      q.lastSeq === undefined
        ? undefined
        : `${threadId}:${q.lastSeq}:${q.orderBy}`;
    const fill =
      key === undefined
        ? this.fetchAndCommit(threadId, q)
        : this.inflightFills.run(key, () => this.fetchAndCommit(threadId, q));
    const committed = await fill;
    if (waiterLifetime.aborted) {
      return { data: [], hasMore: true, failed: true };
    }
    if (committed.failed) return committed;

    const data: Message[] = [];
    for (const row of committed.data) {
      const stored = await this.getOne(threadId, row.seq);
      if (!stored) throw new Error('committed HTTP message is missing from DB');
      if (this.withinRequestedTruncate(stored.seq, q)) data.push(stored);
    }
    const reachedOwnBoundary =
      q.truncate === true &&
      q.truncateSeq !== undefined &&
      committed.confirmedEndSeq !== undefined &&
      (q.orderBy === 'asc'
        ? committed.confirmedEndSeq >= q.truncateSeq
        : committed.confirmedEndSeq <= q.truncateSeq);
    return {
      data: data.slice(0, q.take),
      hasMore: reachedOwnBoundary
        ? false
        : committed.truncated
          ? true
          : committed.hasMore,
      truncated: reachedOwnBoundary,
    };
  }

  private async fetchAndCommit(
    threadId: number,
    q: MessageQuery,
  ): Promise<CommittedFill> {
    const cacheLifetime = this.webdb.captureMessageLifetime();
    let res: StandardResponse<Message[]>;
    try {
      res = await firstValueFrom(this.msg.queryMessageLog({ threadId, ...q }));
    } catch {
      return { data: [], hasMore: true, failed: true };
    }
    // A clear-cache operation may have completed while this request was in flight. Its response belongs
    // to the old cache lifetime: do not mutate repository ceilings, return rows to a closing chatbox, or
    // write them into the freshly-created database.
    if (cacheLifetime.aborted) {
      return { data: [], hasMore: true, failed: true };
    }
    if (res.code !== 0) {
      return { data: [], hasMore: true, failed: true };
    }
    const data = res.data ?? [];
    if (data.length === 0) {
      if (res.truncated && q.truncateSeq === undefined)
        throw new Error('message response truncated without a boundary');
      if (!res.truncated && res.hasMore !== false)
        throw new Error('empty message response has no confirmed endpoint');
    }
    let newest = this.maxSeenSeq.get(threadId);
    if (data.length > 0) {
      // A local-gap cutoff is not a server ceiling. Only an unbounded response, or a newest-page
      // revalidation (desc/no cursor, whose first row is globally newest), may advance maxSeenSeq.
      if (
        !q.truncate ||
        (q.skip === 0 && q.orderBy === 'desc' && q.lastSeq === undefined)
      ) {
        const max = data.reduce((mx, m) => (m.seq > mx ? m.seq : mx), -1);
        newest = Math.max(newest ?? -1, max);
      }
    }
    const confirmedEndSeq =
      res.truncated && q.truncateSeq !== undefined
        ? q.truncateSeq
        : data[data.length - 1]?.seq;
    // `truncateSeq` is an exclusive wire cutoff. It may be a synthetic sentinel (for example,
    // knownNewestSeq + 1), so it is not necessarily the seq of a row that can anchor a persisted
    // section. A real cached cutoff is safe to use; otherwise end the section at the last returned
    // row. Empty responses at a synthetic cutoff confirm the request endpoint but create no section.
    const persistedCutoff =
      res.truncated && q.truncateSeq !== undefined
        ? await this.getOne(threadId, q.truncateSeq)
        : undefined;
    const sectionEndpoint = persistedCutoff?.seq ?? data[data.length - 1]?.seq;
    let confirmedSection:
      | { threadId: number; left: number; right: number }
      | undefined;
    if (q.lastSeq !== undefined && sectionEndpoint !== undefined) {
      confirmedSection = {
        threadId,
        left: Math.min(q.lastSeq, sectionEndpoint),
        right: Math.max(q.lastSeq, sectionEndpoint),
      };
    } else if (data.length > 0) {
      const seqs = data.map((m) => m.seq);
      const endpoints = [
        ...seqs,
        ...(res.truncated && q.truncateSeq !== undefined
          ? [q.truncateSeq]
          : []),
      ];
      confirmedSection = {
        threadId,
        left: Math.min(...endpoints),
        right: Math.max(...endpoints),
      };
    }
    if (data.length > 0 || confirmedSection) {
      let coverage: MessageCoverageState | undefined;
      try {
        coverage = await this.putMany(
          data,
          confirmedSection,
          newest === undefined ? undefined : { threadId, seq: newest },
          cacheLifetime,
        );
      } catch (error) {
        if (cacheLifetime.aborted) {
          return { data: [], hasMore: true, failed: true };
        }
        throw error;
      }
      // Recreation waits for the admitted write, but may begin immediately after it commits. Do not publish
      // old-lifetime memory state or rows to the caller once that lifetime has been aborted.
      if (cacheLifetime.aborted) {
        return { data: [], hasMore: true, failed: true };
      }
      if (newest !== undefined) this.advanceCeiling(threadId, newest, false);
      const active = this.activeCoverage.get(threadId);
      if (active && coverage) active.state = coverage;
    }
    return {
      data,
      hasMore: res.hasMore ?? data.length >= q.take,
      truncated: res.truncated,
      confirmedEndSeq,
    };
  }

  /** Refresh a locally completed latest page and wake the open kernel when the server has any data beyond
   *  the local tail. `cachedNewestSeq === undefined` is the valid empty-cache case. */
  async refreshLatest(
    threadId: number,
    q: MessageQuery,
    cachedNewestSeq: number | undefined,
    cachedOldestSeq?: number,
  ): Promise<void> {
    return this.refreshLatestInternal(
      threadId,
      q,
      cachedNewestSeq,
      cachedOldestSeq,
    );
  }

  private async refreshLatestInternal(
    threadId: number,
    q: MessageQuery,
    cachedNewestSeq: number | undefined,
    cachedOldestSeq?: number,
  ): Promise<void> {
    const fresh = await this.backend(threadId, {
      ...q,
      truncate: cachedOldestSeq !== undefined,
      truncateSeq: cachedOldestSeq,
    });
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

  /** Advance the per-thread seq ceiling (drives the getNewer cache-hit test) if `seq` is newer. */
  private advanceCeiling(threadId: number, seq: number, persist = true): void {
    const truncateSeq = this.newerTruncateSeq.get(threadId) ?? -1;
    if (seq > truncateSeq) this.newerTruncateSeq.set(threadId, seq);
    const cur = this.maxSeenSeq.get(threadId) ?? -1;
    if (seq <= cur) return;
    this.maxSeenSeq.set(threadId, seq);
    const active = this.activeCoverage.get(threadId);
    if (active?.state && seq > active.state.knownNewestSeq)
      active.state = { ...active.state, knownNewestSeq: seq };
    if (persist)
      void this.webdb
        .putMessages([], undefined, { threadId, seq })
        .then((coverage) => {
          const current = this.activeCoverage.get(threadId);
          if (
            current &&
            coverage &&
            coverage.knownNewestSeq >= (current.state?.knownNewestSeq ?? -1)
          )
            current.state = coverage;
        });
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
   * Decide whether `cached` is inside a server-confirmed complete range (→ cache hit) or whether
   * the cache lacks data here (→ gap-fill). `cached` is in `orderBy` order (desc: highest-first below the
   * anchor; asc: lowest-first above it). A numeric seq gap may be legitimate under viewer filtering, so
   * completeness comes from successful server pages rather than arithmetic adjacency alone.
   */
  private async cacheVerdict(
    cached: Message[],
    anchor: number,
    take: number,
    orderBy: 'desc' | 'asc',
    threadId: number,
  ): Promise<{ hit: boolean; hasMore: boolean }> {
    if (cached.length === 0) return { hit: false, hasMore: true };
    let cursor = anchor;
    for (let i = 0; i < cached.length; i++) {
      if (!(await this.isCompleteRange(threadId, cursor, cached[i].seq)))
        return { hit: false, hasMore: true }; // gap
      cursor = cached[i].seq;
    }
    const lastSeq = cached[cached.length - 1].seq;
    if (orderBy === 'desc') {
      // getOlder: seq 1 is the protocol minimum. A server may start above 1 or leave gaps, so a larger
      // value never proves that the cache has reached the lower boundary.
      const reachedFloor = lastSeq === 1;
      const hit = cached.length === take || reachedFloor;
      return { hit, hasMore: hit ? lastSeq > 1 : true };
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
    clearedThroughSeq?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'desc', take)
      ).filter((m) => clearedThroughSeq == null || m.seq > clearedThroughSeq);
    } catch {
      return [];
    }
  }

  /** The `take` messages with seq < `belowSeq`, highest-first (desc). */
  private async rangeDesc(
    threadId: number,
    belowSeq: number,
    take: number,
    clearedThroughSeq?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'desc', take, belowSeq)
      ).filter((m) => clearedThroughSeq == null || m.seq > clearedThroughSeq);
    } catch {
      return [];
    }
  }

  /** The `take` messages with seq > `aboveSeq`, lowest-first (asc). */
  private async rangeAsc(
    threadId: number,
    aboveSeq: number,
    take: number,
    clearedThroughSeq?: number | null,
  ): Promise<Message[]> {
    try {
      return (
        await this.webdb.queryCachedMessages(threadId, 'asc', take, aboveSeq)
      ).filter((m) => clearedThroughSeq == null || m.seq > clearedThroughSeq);
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

  private async putMany(
    msgs: Message[],
    confirmedSection?: { threadId: number; left: number; right: number },
    knownNewest?: { threadId: number; seq: number },
    lifetime?: AbortSignal,
  ): Promise<MessageCoverageState | undefined> {
    return this.webdb.putMessages(
      msgs,
      confirmedSection,
      knownNewest,
      lifetime,
    );
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
