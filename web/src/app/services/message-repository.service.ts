import { Injectable, inject, effect } from '@angular/core';
import { Subject, firstValueFrom } from 'rxjs';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import {
  MsgService,
  type MessageHistoryBackendRequest,
  type MessageQueryCursorData,
  type MessageQueryPage,
} from './message.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { Message, MediaStatus, type MessageQueryRow } from './model';
import { isTauri, tauriInvoke } from './runtime';
import { historyAnchorRequest, type HistoryAnchor } from './history-anchor';

export interface MessageHistoryTarget {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
}

export type NativeMessageHistoryDemand =
  | {
      kind: 'latest';
      count: number;
      knownNewestSeq?: number;
      target?: MessageHistoryTarget;
    }
  | {
      kind: 'around';
      anchor: number;
      olderCount: number;
      newerCount: number;
      knownNewestSeq?: number;
      target?: MessageHistoryTarget;
    }
  | {
      kind: 'older';
      before: number;
      count: number;
      target?: MessageHistoryTarget;
    }
  | {
      kind: 'newer';
      after: number;
      count: number;
      target?: MessageHistoryTarget;
    };

export type MessageHistorySourceItem =
  | { kind: 'message'; message: MessageQueryRow }
  | {
      kind: 'serverGap';
      left: number;
      right: number;
      state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    };

export interface NativeMessageHistoryResult {
  items: MessageHistorySourceItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  failed: boolean;
}

type HistoryDirection = 'older' | 'newer';

interface DirectionalHistoryWalk {
  items: MessageHistorySourceItem[];
  hasMore: boolean;
}

/**
 * The DB-layer repository for message bodies — the read + realtime half of the strict 3-tier
 * (UI ↔ repositories ↔ backend) for the message domain. It is the ONLY service that issues message
 * READs (`/query-messages`). UI-facing sources ({@link HttpItemSource}) read through here; they never
 * fetch messages themselves.
 *
 * NO writes live here — sending is a direct UI → backend POST (bypasses the DB layer); the sent row
 * lands in IDB through the same pull path as remote messages.
 *
 * **Persistence model:** messages and explicit left-open/right-closed range records are mirrored to the
 * local database. The source-level walker reads classified local intervals, fills only their complement,
 * and commits message/range changes atomically. Writes deduplicate by `[threadId, seq]`. Add-only PER
 * MESSAGE — there is no server-side delete
 * command, so individual messages are never removed; the ONE exception is whole-thread cache GC when a
 * thread leaves the user's roster (see {@link deleteByThread}).
 *
 * A committed unified thread snapshot advances the bounded newer walk and emits {@link liveSignal$}; the
 * mounted source then pulls the body through the canonical message query.
 */
@Injectable({ providedIn: 'root' })
export class MessageRepository {
  private readonly sessionLifecycle = inject(SessionLifecycleService);
  private readonly webdb = inject(WebdbService);
  private readonly ws = inject(WebsocketService);
  private readonly msg = inject(MsgService);
  private readonly userService = inject(UserService);

  /**
   * Fires `{threadId, seq}` after a durable thread content head advances. Each {@link HttpItemSource}
   * filters to its `threadId` and treats it as "newer data exists, go pull".
   * Multiple chatboxes therefore share one cutoff/fill lane but retain independent viewport demands.
   */
  private readonly signal$ = new Subject<{ threadId: number; seq: number }>();
  readonly liveSignal$ = this.signal$.asObservable();
  private readonly deletedSignal$ = new Subject<{
    threadId: number;
    deletions: Array<{
      seq: number;
      type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    }>;
  }>();
  readonly deletedLive$ = this.deletedSignal$.asObservable();
  private readonly slotsChanged = new Subject<number>();
  readonly slotsChanged$ = this.slotsChanged.asObservable();

  /** Successful transport reconnect. The repository clears the finite HTTP cutoff before waking views. */
  private readonly reconnectSignal = new Subject<void>();
  readonly reconnectSignal$ = this.reconnectSignal.asObservable();

  /**
   * Fires `{threadId, seq}` after a message's mediaStatus changed in IDB (an SSE transition, a
   * mount/reconnect snapshot, or a manual-retry response). The per-thread HttpItemSource
   * filters to its threadId and calls `kernel.updateItemData(seq)` to re-render that one card in place
   * (zero height change — the status overlay/meta slot never alter the cell's measured height).
   */
  private readonly mediaStatusSignal$ = new Subject<{
    threadId: number;
    seq: number;
    status: MediaStatus;
  }>();
  readonly mediaStatusLive$ = this.mediaStatusSignal$.asObservable();

  /** Per-thread highest seq observed (via State Feed or a backend response body). In-memory only —
   *  re-established by the init backend-probe each session. Drives the getNewer cache-hit ceiling test. */
  private readonly maxSeenSeq = new Map<number, number>();
  /** Shared finite upper bound for a newer walk. Reconnect clears it because frames may be missing. */
  private readonly newerTruncateSeq = new Map<number, number>();
  /** Previous sessionProfile id seen by the session-end effect (null = no logged-in user). */
  private prevSessionId: number | null = null;

  /**
   * Native history is a source-level operation. Rust owns the complete SQLite/HTTP/range-reducer walk
   * and returns the final chronological projection in one IPC call; renderer code must not reproduce
   * its recursion with page-level native database commands.
   */
  async queryNativeMessageHistory(
    threadId: number,
    demand: NativeMessageHistoryDemand,
  ): Promise<NativeMessageHistoryResult> {
    const epoch = this.sessionLifecycle.accountEpoch;
    if (!isTauri())
      throw new Error('native message history requested outside Tauri');
    const userId = this.userService.sessionUserId();
    if (userId === null)
      throw new Error('native message history requested without a session');
    const result = await tauriInvoke<NativeMessageHistoryResult>(
      'native_message_history_get',
      {
        userId,
        threadId,
        demand,
      },
    );
    if (!this.sessionLifecycle.isCurrent(epoch))
      throw new Error('account session expired during native history query');
    if (this.userService.sessionUserId() === userId)
      this.slotsChanged.next(threadId);
    return result;
  }

  /** Browser equivalent of the native source walker. It owns every IDB read, HTTP fill, transactional
   * reduction, and recursive continuation required by one source demand. */
  async queryBrowserMessageHistory(
    threadId: number,
    demand: NativeMessageHistoryDemand,
  ): Promise<NativeMessageHistoryResult> {
    if (isTauri())
      throw new Error('browser message history requested inside Tauri');
    const lowerHint = 0;
    const lifetime = this.webdb.captureMessageLifetime();
    try {
      switch (demand.kind) {
        case 'latest': {
          const upperHint = this.knownNewestSeqHint(demand.knownNewestSeq);
          const [serverLower, upper] =
            upperHint === null
              ? await this.bootstrapMessageBounds(threadId)
              : [lowerHint, upperHint];
          const lower = serverLower;
          const page = await this.walkBrowserMessageHistory(
            threadId,
            'older',
            upper + 1,
            demand.count,
            lower,
            upper,
            upper,
            lifetime,
          );
          return {
            items: page.items.reverse(),
            hasOlder: page.hasMore,
            hasNewer: false,
            failed: false,
          };
        }
        case 'around': {
          const upperHint = this.knownNewestSeqHint(demand.knownNewestSeq);
          const [serverLower, upper] =
            upperHint === null
              ? await this.bootstrapMessageBounds(threadId)
              : [lowerHint, upperHint];
          const lower = serverLower;
          const older = await this.walkBrowserMessageHistory(
            threadId,
            'older',
            demand.anchor + 1,
            demand.olderCount,
            lower,
            upper,
            upper,
            lifetime,
          );
          const newer = await this.walkBrowserMessageHistory(
            threadId,
            'newer',
            demand.anchor,
            demand.newerCount,
            lower,
            upper,
            upper,
            lifetime,
          );
          return {
            items: [...older.items.reverse(), ...newer.items],
            hasOlder: older.hasMore,
            hasNewer: newer.hasMore,
            failed: false,
          };
        }
        case 'older': {
          const knownNewest = await this.webdb.getMessageHead(threadId);
          const upper = Math.max(
            lowerHint,
            knownNewest ?? 0,
            this.maxSeenSeq.get(threadId) ?? 0,
            demand.before - 1,
          );
          const page = await this.walkBrowserMessageHistory(
            threadId,
            'older',
            demand.before,
            demand.count,
            lowerHint,
            upper,
            knownNewest,
            lifetime,
          );
          return {
            items: page.items.reverse(),
            hasOlder: page.hasMore,
            hasNewer: demand.before <= upper,
            failed: false,
          };
        }
        case 'newer': {
          let lower = lowerHint;
          const persistedHead = await this.webdb.getMessageHead(threadId);
          const liveHead = Math.max(
            this.maxSeenSeq.get(threadId) ?? -1,
            this.newerTruncateSeq.get(threadId) ?? -1,
          );
          let upper = Math.max(persistedHead ?? -1, liveHead);
          if (upper < 0) {
            const bounds = await this.bootstrapMessageBounds(threadId);
            lower = Math.max(lower, bounds[0]);
            upper = bounds[1];
          }
          const page = await this.walkBrowserMessageHistory(
            threadId,
            'newer',
            demand.after,
            demand.count,
            lower,
            upper,
            upper,
            lifetime,
          );
          return {
            items: page.items,
            hasOlder: demand.after > lower,
            hasNewer: page.hasMore,
            failed: false,
          };
        }
      }
    } catch {
      return { items: [], hasOlder: true, hasNewer: true, failed: true };
    }
  }

  private knownNewestSeqHint(seq: number | undefined): number | null {
    return seq !== undefined && Number.isSafeInteger(seq) && seq >= 0
      ? seq
      : null;
  }

  private async bootstrapMessageBounds(
    threadId: number,
  ): Promise<[number, number]> {
    const response = await firstValueFrom(
      this.msg.queryMessageHistoryPage({ threadId }),
    );
    if (response.code !== 30006 || !this.isHistoryCursor(response.data))
      throw new Error('message bootstrap did not return cursor bounds');
    if (
      response.data.resumeAfter < 0 ||
      response.data.resumeBefore <= response.data.resumeAfter
    )
      throw new Error('message bootstrap returned invalid cursor bounds');
    return [response.data.resumeAfter, response.data.resumeBefore - 1];
  }

  private async walkBrowserMessageHistory(
    threadId: number,
    direction: HistoryDirection,
    initialCursor: number,
    count: number,
    initialLower: number,
    initialUpper: number,
    knownNewestSeq: number | undefined,
    lifetime: AbortSignal,
  ): Promise<DirectionalHistoryWalk> {
    if (!Number.isSafeInteger(count) || count < 0 || count > 200)
      throw new Error('message history item count is outside 0..200');
    let cursor = initialCursor;
    let lower = initialLower;
    let upper = initialUpper;
    const ownershipSeam = cursor;
    let ranges = await this.webdb.getMessageRanges(threadId);
    const items: MessageHistorySourceItem[] = [];
    let remaining = count;

    for (let step = 0; step < 1024; step++) {
      const atBoundary =
        direction === 'older' ? cursor <= lower + 1 : cursor >= upper;
      if (atBoundary || remaining === 0) return { items, hasMore: !atBoundary };

      const coordinate = direction === 'older' ? cursor - 1 : cursor + 1;
      const range = ranges.find(
        (candidate) =>
          coordinate > candidate.left && coordinate <= candidate.right,
      );
      if (range) {
        if (range.state === 'LOCAL_COVERED') {
          const boundary = direction === 'older' ? range.left : range.right;
          const cached = await this.queryBrowserMessages(
            threadId,
            direction,
            cursor,
            boundary,
            remaining,
          );
          for (const message of cached) {
            cursor = message.seq;
            items.push({ kind: 'message', message });
            remaining--;
            if (remaining === 0)
              return {
                items,
                hasMore:
                  direction === 'older' ? cursor > lower + 1 : cursor < upper,
              };
          }
          cursor = direction === 'older' ? range.left + 1 : range.right;
          continue;
        }

        const ownsGap =
          direction === 'older'
            ? range.right < ownershipSeam
            : range.right > ownershipSeam;
        if (ownsGap) {
          items.push({
            kind: 'serverGap',
            left: range.left,
            right: range.right,
            state: range.state,
          });
          remaining--;
        }
        cursor = direction === 'older' ? range.left + 1 : range.right;
        continue;
      }

      const optimisticBoundary = direction === 'older' ? lower : upper;
      const optimistic = await this.queryBrowserMessages(
        threadId,
        direction,
        cursor,
        optimisticBoundary,
        remaining,
      );
      const provisional =
        optimistic.length === remaining
          ? (optimistic.at(-1)?.seq ?? optimisticBoundary)
          : optimisticBoundary;
      const intersecting = ranges.filter((candidate) =>
        direction === 'older'
          ? candidate.left < cursor - 1 && candidate.right > provisional
          : candidate.right > cursor && candidate.left < provisional,
      );
      const classifiedBoundary =
        direction === 'older'
          ? intersecting.sort((a, b) => b.right - a.right)[0]?.right
          : intersecting.sort((a, b) => a.left - b.left)[0]?.left;
      const through =
        classifiedBoundary === undefined
          ? provisional
          : direction === 'older'
            ? classifiedBoundary + 1
            : classifiedBoundary;
      if (
        (direction === 'older' && through >= cursor) ||
        (direction === 'newer' && through <= cursor)
      )
        throw new Error('browser history walker made no coordinate progress');

      const request: MessageHistoryBackendRequest = {
        threadId,
        take: Math.min(remaining, 50),
        through,
        ...(direction === 'older' ? { before: cursor } : { after: cursor }),
      };
      const response = await firstValueFrom(
        this.msg.queryMessageHistoryPage(request),
      );
      if (lifetime.aborted)
        throw new Error('message cache lifetime expired during history fill');
      if (response.code === 30006 && this.isHistoryCursor(response.data)) {
        if (
          response.data.resumeAfter < 0 ||
          response.data.resumeBefore <= response.data.resumeAfter
        )
          throw new Error('message query returned invalid recovery bounds');
        const previousBounds = [lower, upper, cursor];
        lower = Math.max(lower, response.data.resumeAfter);
        upper = Math.min(upper, response.data.resumeBefore - 1);
        cursor =
          direction === 'older'
            ? Math.min(cursor, response.data.resumeBefore)
            : Math.max(cursor, response.data.resumeAfter);
        if (
          lower === previousBounds[0] &&
          upper === previousBounds[1] &&
          cursor === previousBounds[2]
        )
          throw new Error('message cursor recovery made no progress');
        continue;
      }
      if (response.code !== 0 || !this.isHistoryPage(response.data))
        throw new Error('message history page request failed');
      const page = response.data;
      const scan = this.historyScan(direction, cursor, page.scannedThrough);
      const gaps = page.gaps.map((gap) => ({
        left: gap.startSeq - 1,
        right: gap.endSeq,
        state: gap.recoverable
          ? ('SERVER_PENDING' as const)
          : ('SERVER_UNAVAILABLE' as const),
      }));
      const committed = await this.webdb.commitBrowserMessagePage(
        {
          threadId,
          scan,
          messages: page.messages,
          gaps,
          knownNewestSeq,
        },
        lifetime,
      );
      ranges = committed.ranges;
      this.slotsChanged.next(threadId);
      if (!scan) return { items, hasMore: false };
      const direct = this.projectCommittedHistoryPage(
        direction,
        scan,
        committed.messages,
        gaps,
      );
      if (direct.length >= remaining) {
        for (const item of direct.slice(0, remaining)) {
          cursor = this.historyCursorAfter(direction, item);
          items.push(item);
        }
        return {
          items,
          hasMore: direction === 'older' ? cursor > lower + 1 : cursor < upper,
        };
      }
      remaining -= direct.length;
      items.push(...direct);
      cursor = page.scannedThrough;
    }
    throw new Error('browser history walker exceeded its progress limit');
  }

  private async queryBrowserMessages(
    threadId: number,
    direction: HistoryDirection,
    cursor: number,
    boundary: number,
    take: number,
  ): Promise<MessageQueryRow[]> {
    const messages = await this.webdb.queryCachedMessages(
      threadId,
      direction === 'older' ? 'desc' : 'asc',
      take,
      cursor,
    );
    return messages.filter((message) =>
      direction === 'older'
        ? message.seq > boundary && message.seq < cursor
        : message.seq > cursor && message.seq <= boundary,
    );
  }

  private historyScan(
    direction: HistoryDirection,
    cursor: number,
    scannedThrough: number,
  ): { left: number; right: number } | null {
    if (direction === 'older' && scannedThrough < cursor)
      return { left: scannedThrough - 1, right: cursor - 1 };
    if (direction === 'newer' && scannedThrough > cursor)
      return { left: cursor, right: scannedThrough };
    if (scannedThrough === cursor) return null;
    throw new Error('message scan cursor moved in the wrong direction');
  }

  private projectCommittedHistoryPage(
    direction: HistoryDirection,
    scan: { left: number; right: number },
    messages: MessageQueryRow[],
    gaps: Array<{
      left: number;
      right: number;
      state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    }>,
  ): MessageHistorySourceItem[] {
    const positioned: Array<{
      coordinate: number;
      item: MessageHistorySourceItem;
    }> = messages.map((message) => ({
      coordinate: message.seq,
      item: { kind: 'message', message },
    }));
    for (const gap of gaps) {
      if (gap.right > scan.left && gap.right <= scan.right)
        positioned.push({
          coordinate: gap.right,
          item: { kind: 'serverGap', ...gap },
        });
    }
    positioned.sort((a, b) =>
      direction === 'older'
        ? b.coordinate - a.coordinate
        : a.coordinate - b.coordinate,
    );
    return positioned.map(({ item }) => item);
  }

  private historyCursorAfter(
    direction: HistoryDirection,
    item: MessageHistorySourceItem,
  ): number {
    if (item.kind === 'message') return item.message.seq;
    return direction === 'older' ? item.left + 1 : item.right;
  }

  private isHistoryCursor(value: unknown): value is MessageQueryCursorData {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Partial<MessageQueryCursorData>;
    return (
      Number.isSafeInteger(cursor.resumeAfter) &&
      Number.isSafeInteger(cursor.resumeBefore)
    );
  }

  private isHistoryPage(value: unknown): value is MessageQueryPage {
    if (!value || typeof value !== 'object') return false;
    const page = value as Partial<MessageQueryPage>;
    return (
      Array.isArray(page.messages) &&
      Array.isArray(page.gaps) &&
      Number.isSafeInteger(page.scannedThrough) &&
      typeof page.hasMore === 'boolean'
    );
  }

  constructor() {
    this.webdb.messageDbCommitted$.subscribe(({ threadId }) =>
      this.slotsChanged.next(threadId),
    );
    this.ws.reconnect$.subscribe(() => {
      this.newerTruncateSeq.clear();
      this.reconnectSignal.next();
    });

    // The database worker commits tombstone pages and reports them here; project
    // them into mounted sources the same way the old main-thread drain did.
    this.webdb.tombstoneCommitted$.subscribe(({ threadId, deletions }) => {
      this.slotsChanged.next(threadId);
      if (deletions.length) this.deletedSignal$.next({ threadId, deletions });
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
  }

  /** Reconcile conversation metadata/live init state into the shared per-thread ceiling. */
  retainNewestSeq(threadId: number, seq: number): void {
    if (Number.isSafeInteger(seq) && seq >= 0)
      this.advanceCeiling(threadId, seq, false);
  }

  /** Apply a committed client State Feed content head and optionally wake mounted message sources. */
  applyThreadContentHead(
    threadId: number,
    messageEndSeq: number,
    emitLiveSignal: boolean,
  ): void {
    if (
      !Number.isSafeInteger(threadId) ||
      threadId <= 0 ||
      !Number.isSafeInteger(messageEndSeq) ||
      messageEndSeq < 0
    )
      return;
    if (!this.advanceCeiling(threadId, messageEndSeq)) return;
    if (emitLiveSignal) this.signal$.next({ threadId, seq: messageEndSeq });
  }

  /** Purge all cached history state for a thread when it leaves the user's roster. */
  async deleteByThread(threadId: number): Promise<void> {
    this.maxSeenSeq.delete(threadId);
    this.newerTruncateSeq.delete(threadId);
    try {
      await this.webdb.deleteMessagesByThread(threadId);
    } catch {
      /* local cache is best-effort */
    }
  }
  /** Advance the per-thread seq ceiling (drives the getNewer cache-hit test) if `seq` is newer. */
  private advanceCeiling(
    threadId: number,
    seq: number,
    persist = true,
  ): boolean {
    const truncateSeq = this.newerTruncateSeq.get(threadId) ?? -1;
    if (seq > truncateSeq) this.newerTruncateSeq.set(threadId, seq);
    const cur = this.maxSeenSeq.get(threadId) ?? -1;
    if (seq <= cur) return false;
    this.maxSeenSeq.set(threadId, seq);
    if (persist) void this.webdb.putMessageHead(threadId, seq);
    return true;
  }

  /** Idempotent put by `[threadId, seq]` (the keyPath) — writing the same key twice just overwrites. */
  private async put(m: Message): Promise<void> {
    try {
      await this.webdb.putCachedMessages([m]);
      this.slotsChanged.next(m.threadId);
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
  }

  /** Resolve a navigation selector without adding it to any history scan's coverage. */
  async resolveHistoryAnchor(
    threadId: number,
    anchor: HistoryAnchor,
  ): Promise<number | null> {
    const epoch = this.sessionLifecycle.accountEpoch;
    const response = await firstValueFrom(
      this.msg.queryMessageHistoryPage({
        threadId,
        take: 1,
        ...historyAnchorRequest(anchor),
      }),
    );
    if (response.code !== 0 || !response.data || !('messages' in response.data))
      throw new Error('history anchor resolution failed');
    if (!this.sessionLifecycle.isCurrent(epoch))
      throw new Error('account session expired during anchor resolution');
    const page = response.data;
    const seq = page.resolvedAnchorSeq;
    if (seq === null) return null;
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new Error('history anchor returned an invalid local sequence');
    if (page.messages.some((row) => row.threadId !== threadId))
      throw new Error('history anchor returned a different thread');
    // These slots are opportunistic cache entries, not a directional scan. In
    // particular, never pass them to reduceMessageRanges or advance messageHead.
    await this.webdb.putCachedMessages(page.messages);
    if (!this.sessionLifecycle.isCurrent(epoch))
      throw new Error('account session expired during anchor commit');
    this.slotsChanged.next(threadId);
    return seq;
  }

  getMessageByOrigin(threadId: number, namespaceId: number, originSeq: number) {
    return this.webdb.getMessageByOrigin(threadId, namespaceId, originSeq);
  }

  getDeletedMessageSeqs(threadId: number, seqs: number[]): Promise<number[]> {
    return this.webdb.getDeletedMessageSeqs(threadId, seqs);
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

  /** Persist one authoritative media status, then wake mounted consumers. */
  async setMediaStatus(
    threadId: number,
    seq: number,
    status: MediaStatus,
  ): Promise<boolean> {
    const cur = await this.getOne(threadId, seq);
    if (!cur) return false;
    if (cur.mediaStatus === status) return false;
    await this.put({ ...cur, mediaStatus: status });
    this.mediaStatusSignal$.next({ threadId, seq, status });
    return true;
  }
}
