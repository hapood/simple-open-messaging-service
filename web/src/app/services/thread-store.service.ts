import { Injectable, inject, signal, effect } from '@angular/core';
import { filter, firstValueFrom, map, Subject, Subscription } from 'rxjs';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ProfileRepository } from './profile-store.service';
import { MessageRepository } from './message-repository.service';
import { MissedSyncService, type MissedThreadItem } from './missed-sync.service';
import { isAndroidNative } from './runtime';
import type { MissedCursor } from './notification-descriptor.model';
import { ConversationItem, User } from './model';

/** Load status as a const object so it can be used as a VALUE in templates and as a TYPE. */
export const ConversationLoadStatus = {
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
export type ConversationLoadStatus =
  (typeof ConversationLoadStatus)[keyof typeof ConversationLoadStatus];

/**
 * The DB-layer repository for the conversation list — the read + SSE half of the strict 3-tier
 * (UI ↔ repositories ↔ backend) for the thread-list domain. It is the ONLY service that issues the
 * list READ (`/user/query-thread/delta`) and the ONLY consumer of the thread-list DATA SSE events
 * (`NEW_MESSAGE`, `THREAD_META`, `THREAD_REVISION_UPDATED`, `PEER_PROFILE_UPDATED`). UI-facing services
 * read its signals; they never fetch or mutate from SSE.
 *
 * NO write operations live here — `markRead` (a write) stays in the UI layer ({@link ConversationListService}
 * facade) and bypasses the DB layer, per the 3-tier contract. This repository only GETs (the delta) and
 * listens (SSE).
 *
 * Boot is split across an eager cache-paint + a HELLO-driven network refresh:
 *  - {@link load} eager-paints the IDB `threads` store INSTANTLY on mount — the per-user IDB is opened on
 *    the persisted lastUserId by AuthService.restoreSession (an APP_INITIALIZER, pre-router), so a returning
 *    user sees their list BEFORE the SSE/HELLO round-trip. A cold start (no cache) paints nothing until HELLO.
 *  - {@link onHello} (the SSE connect handshake) then delta-replays the list (full `(0, rev]` on first
 *    connect, incremental `(cursor, rev]` on reconnect) + walks the missed-summary range. The SSE stream
 *    does NOT replay events missed while offline, so this HELLO-driven delta + missed walk is the freshness
 *    backstop.
 *
 * Every conversation is mirrored to IDB (`threads` store, one record per `threadId`). Each data-SSE event
 * mutates exactly the affected record(s) in IDB + emits a fine-grained signal update — never a whole-list
 * re-fetch, never a component reload.
 */
@Injectable({ providedIn: 'root' })
export class ThreadRepository {
  private readonly webdb = inject(WebdbService);
  private readonly userService = inject(UserService);
  private readonly ws = inject(WebsocketService);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly messageRepo = inject(MessageRepository);
  private readonly missedSync = inject(MissedSyncService);

  private readonly _items = signal<ConversationItem[]>([]);
  readonly items = this._items.asReadonly();

  private readonly _status = signal<ConversationLoadStatus>('LOADING');
  readonly status = this._status.asReadonly();

  private readonly _error = signal('');
  readonly error = this._error.asReadonly();

  /** The thread currently being viewed — drives the active-row highlight AND the "don't badge the open
   *  thread" rule in {@link onNewMessage}. Set by the UI layer ({@link setOpenThread} on open/close);
   *  in-memory only (not persisted, not a list field). */
  private readonly _openThreadId = signal<number | undefined>(undefined);
  readonly openThreadId = this._openThreadId.asReadonly();

  /** Per-thread OPTIMISTIC read watermark — the seq the UI marked read locally (a markRead POST is in flight)
   *  ahead of the server's confirmation. {@link reconcileItem} treats this as a lower bound on lastReadSeq and
   *  masks the unread badge while the server catches up; it is pruned once the server's lastReadSeq reaches it
   *  (a missed-summary walk or snapshot refresh carries the authoritative value). In-memory only. */
  private readonly optimisticLastRead = new Map<number, number>();

  /** Emits `{threadId, seq}` when a NEW_MESSAGE lands for the currently-open thread — the signal the UI facade
   *  subscribes to so IT can fire the debounced `markRead` (B1). The repo owns the SSE timing; the facade owns
   *  the write ({@link ConversationListService}), per the 3-tier contract (this layer never POSTs). */
  private readonly _openThreadMessage = new Subject<{ threadId: number; seq: number }>();
  readonly openThreadMessage$ = this._openThreadMessage.asObservable();

  /** A thread promoted to index 0 on the most recent update (to be FLIP-animated by the list), or null.
   *  Set in {@link applyItems} / {@link upsertThread} when a top-insert was requested; the list clears it
   *  after animating ({@link clearTopInserted}). */
  private readonly _topInserted = signal<number | null>(null);
  readonly topInserted = this._topInserted.asReadonly();
  /** Explicit thread to force-top on the next applyItems (set by {@link markTopOnNextUpdate}). */
  private _pendingTopId: number | null = null;

  /** Single-flight + tail-coalesce for THREAD_REVISION_UPDATED (mirrors onmessagesignal-single-flight):
   *  while a delta pull is in-flight, the latest incoming revision is stashed as the tail; on completion
   *  the tail is pulled `(cursor, tail]`, collapsing a signal burst into ranged pulls. */
  private _deltaInFlight = false;
  private _pendingTailRev: number | undefined;

  /** Per-thread high-water-mark of the newest message seq applied via onNewMessage. Guards against SSE
   *  redelivery (e.g. a frame duplicated across a reconnect) double-bumping the unread badge: if an inbound
   *  event's seq isn't strictly newer than the last one applied for that thread, it's discarded before
   *  touching the list. Per-thread seq is a 0-indexed monotonic int (allocated by the backend), so a plain
   *  numeric compare is exact. Not seeded from the loaded list (items carry lastReadSeq, not the last message
   *  seq) — the first live event after a reload passes (it IS new to the in-memory state); only same/older
   *  duplicates are blocked. */
  private readonly lastSeenSeq = new Map<number, number>();

  /** Previous sessionUserId seen by the session-end effect (null = no logged-in user). */
  private prevSessionId: number | null = null;
  /** The high-water mark — the `(threadId, seq)` of the newest message the threadlist has accounted for (the
   *  last walked `to`). The backend resolves it to the internal message `id` it never exposes. The lower
   *  bound (`from`) of the missed-summary walk; persisted to IDB so it survives restarts. Null on first boot
   *  (allowed — the first walk is `(null, to]` = everything up to `to`). Also the away-notification `since`
   *  (the renderer reads it via {@link missedCursor}). */
  private readonly _missedCursor = signal<MissedCursor | null>(null);

  /** Per-thread dismiss-HWM map (threadId → seq) for the away-notification's per-thread grouping. A dismiss
   *  records the descriptor's `{threadId, seq}` so the next `/notifications/missed` pull counts THAT thread
   *  from it (resets its cumulative count to 0 until newer messages); the server drops threads whose
   *  post-dismiss count is 0. Persisted to IDB (survives a page reload mid-away-session) + cleared on
   *  focus-regain (the Android "foreground → all per-thread HWMs reset" model) and on logout (the per-user
   *  DB is deleted). Mirrors `SomsMessagingService.recordThreadDismiss` on Android. */
  private readonly _threadHwms = signal<Record<number, number>>({});

  /** The pinned UPPER bound of the current missed-summary walk — the newest message the client knows of: the
   *  HELLO connect handshake's `latestMessage`, advanced by each live NEW_MESSAGE signal. Ephemeral (NOT
   *  persisted — re-established on every connect via HELLO). Null until HELLO lands, so boot does NOT walk. */
  private _to: MissedCursor | null = null;

  private readonly sseSub: Subscription;

  constructor() {
    // ── thread-list DATA SSE events (the DB layer is the sole consumer) ──
    this.sseSub = this.ws.eventSubject.subscribe((m) => {
      switch (m.event) {
        case 'HELLO':
          void this.onHello(m.data as HelloPayload | undefined);
          break;
        case 'NEW_MESSAGE':
          if (m.data !== undefined) this.onNewMessage(m.data as { threadId: number; seq: number; ts: number });
          break;
        case 'THREAD_META':
          this.onThreadMeta(m.data as ThreadMetaPayload | undefined);
          break;
        case 'THREAD_REVISION_UPDATED':
          if (m.data !== undefined) this.onThreadRevisionUpdated((m.data as { threadRevision: number }).threadRevision);
          break;
        case 'PROFILE_REV_UPDATED':
          // Self-profile changed (another device/tab's edit — this device's own edit echoes back too, but
          // invalidateSelfProfile skips the echo since updateSessionProfile already applied it).
          if (m.data !== undefined) this.userService.invalidateSelfProfile((m.data as { profileRev: number }).profileRev);
          break;
        case 'FRIEND_REQ_REV_UPDATED':
          // The friend-request state changed (new/accepted/declined invite, OR a markRead ack on another
          // device) → apply the server-state pair (badge = friendReqRev > friendReqAckRev). The native layer
          // merges this too.
          if (m.data !== undefined) {
            const d = m.data as { friendReqRev: number | null; friendReqAckRev: number };
            this.userService.applyFriendReqRev(d.friendReqRev, d.friendReqAckRev);
          }
          break;
        case 'PEER_PROFILE_UPDATED':
          if (m.data !== undefined) this.onPeerProfileUpdated(m.data as unknown as User);
          break;
        case 'READ_CURSOR':
          if (m.data !== undefined) this.onReadCursor(m.data as { threadId: number; lastReadSeq: number });
          break;
      }
    });

    // Reconnect refresh is HELLO-driven now: the SSE reconnect re-pushes HELLO → onHello re-runs
    // (cache-paint + delta-replay + missed-summary walk). No separate reconnect→boot wiring needed.

    // Session-end reset: when the session ends (sessionUserId → null, i.e. clearSession/logout), drop
    // the in-memory list so a second account logging into the same live SPA cannot inherit this user's
    // cached list. The IDB partition is handled by WebdbService (closed on the same signal); this covers
    // the in-memory layer. Reset flips status back to LOADING so the next login's ThreadListComponent
    // re-enters the loading state until the fresh HELLO lands.
    effect(() => {
      const id = this.userService.sessionUserId();
      if (id === this.prevSessionId) return;
      this.prevSessionId = id;
      if (id === null) this.reset();
    });
  }

  /**
   * Drop ALL in-memory session state (logout / account switch). The IDB store is closed + deleted by
   * WebdbService (on the same sessionUserId signal); this resets the in-memory caches so they cannot leak
   * across users. Resets {@link _status} to LOADING so the freshly-mounted list re-loads on the next HELLO.
   */
  private reset(): void {
    this._items.set([]);
    this._status.set('LOADING');
    this._error.set('');
    this._openThreadId.set(undefined);
    this._topInserted.set(null);
    this._pendingTopId = null;
    this._deltaInFlight = false;
    this._pendingTailRev = undefined;
    this.lastSeenSeq.clear();
    this.optimisticLastRead.clear();
    this._missedCursor.set(null);
    this._threadHwms.set({});
    // Clear the native durable copy too (logout / account switch) so a different user does not inherit it.
    if (isAndroidNative()) window.SomsFcm?.setMissedCursor?.(null);
    clearTimeout(this.pullTimer);
    this.pullArmedAt = 0;
  }

  // ── boot: HELLO-driven (cache-paint + delta-replay live in onHello) ────────────────────────

  /**
   * Eager cache-paint — the ThreadListComponent init trigger. Reads the IDB `threads` store + paints it
   *  INSTANTLY, BEFORE the SSE/HELLO round-trip: the per-user IDB was opened on the persisted lastUserId by
   *  AuthService.restoreSession (an APP_INITIALIZER, pre-router), so the cache is readable the moment the
   *  list mounts. This is the "instant list on startup for returning users" path — no network wait. A true
   *  cold start (no IDB data) paints nothing → LOADING until HELLO's delta populates.
   *
   *  Guarded against clobbering a fresher state: bails if the list is already populated (a HELLO delta that
   *  landed during the IDB read, or a prior paint). The network refresh is HELLO-driven ({@link onHello});
   *  load() owns only the instant cache paint. The `force` flag is a no-op — a reconnect re-pushes HELLO.
   */
  load(_opts?: { force?: boolean }) {
    void this.paintFromCache();
  }

  /** Read the IDB `threads` store + apply it instantly (the eager pre-HELLO paint). Bails if the list is
   *  already populated so a late cache read cannot clobber a fresher HELLO delta that landed during it. */
  private async paintFromCache(): Promise<void> {
    if (this._items().length > 0) return; // already populated — don't clobber a fresher state
    const cached = await this.readCachedThreads();
    if (cached.length > 0 && this._items().length === 0) {
      this.applyItems(cached); // flips READY
      void this.hydratePreviews(); // re-derive previews from the local message store
    } else if (this._items().length === 0 && this._status() !== 'READY') {
      this._status.set('LOADING'); // cold start, no cache → await HELLO's delta
    }
  }

  /** Force `threadId` to index 0 on the next update and emit `topInserted` so the row animates in.
   *  Used when the caller knows the new id (group join SSE, group create response). */
  markTopOnNextUpdate(threadId: number): void {
    this._pendingTopId = threadId;
  }

  /** Clear the `topInserted` pulse after the list has played its enter/FLIP animation. */
  clearTopInserted(): void {
    this._topInserted.set(null);
  }

  /** Set/clear the open thread (UI layer drives this on open/close; used for unread suppression). */
  setOpenThread(threadId: number | undefined): void {
    this._openThreadId.set(threadId);
  }

  /** Resolve the ConversationItem for a thread the caller knows exists, waiting for a reload if it is not
   *  yet in the list (up to `timeoutMs`). Used by the join hero transition. */
  async ensureThread(threadId: number, timeoutMs = 2000): Promise<ConversationItem | undefined> {
    const found = this._items().find((t) => t.threadId === threadId);
    if (found) return found;
    if (this._status() === 'READY') this.load();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const it = this._items().find((t) => t.threadId === threadId);
      if (it) return it;
    }
    return undefined;
  }

  // ── list mutations (each writes through to IDB + emits a fine-grained signal update) ───────

  /** Patch per-user thread metadata (mute/pin/clear/block/alias) on a row, then re-sort so pin/unpin
   *  reorders it live. Only defined fields are applied. Called from the THREAD_META SSE handler
   *  (multi-device) and (via the facade) from local optimistic actions (mute/pin toggle, block/unblock). */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      clearedAt?: number | null;
      blocked?: boolean;
      alias?: string | null;
    },
  ): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === threadId);
      if (idx === -1) return list;
      const next = list.slice();
      changed = { ...next[idx], ...patch };
      next[idx] = changed;
      next.sort(byPinRank);
      return next;
    });
    if (changed) void this.persistThread(changed);
  }

  /** Replace a P2P item's peerUser (avatar/name/bio) after a federated profile sync. No-op for groups /
   *  absent items. (Via the facade from peer-profile / chat-open.) */
  updatePeerUser(threadId: number, user: User): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.threadId === threadId && t.type === 'P2P');
      if (!found) return list;
      changed = { ...found, peerUser: user };
      return list.map((t) => (t.threadId === threadId && t.type === 'P2P' ? changed! : t));
    });
    if (changed) {
      void this.persistThread(changed);
      this.writePeerProfile(changed.peerUser);
    }
  }

  /** A background peer-profile refresh on chat-open: re-pull the peer's avatar/name/bio if stale and patch
   *  the item. Fire-and-forget — chat-open is never blocked. The pull backstop behind the
   *  PEER_PROFILE_UPDATED push (covers reconnects / missed pushes / federated laziness). */
  refreshPeerOnOpen(threadId: number): void {
    const item = this._items().find((t) => t.threadId === threadId);
    if (!item || item.type !== 'P2P' || !item.peerUser) return;
    this.userService
      .syncPeerProfile({ userId: item.peerUser.id, sinceUpdatedAt: item.peerUser.updatedAt })
      .subscribe({
        next: (res) => {
          if (res.code === 0 && res.data) this.updatePeerUser(threadId, res.data);
        },
        error: () => {
          /* best-effort — keep the cached profile on a transient outage */
        },
      });
  }

  /** Apply a rename / avatar / description change from a GROUP_UPDATED event (live list refresh). */
  applyGroupUpdate(threadId: number, patch: { name?: string; description?: string; avatar?: string }): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) =>
      list.map((t) => {
        if (t.threadId !== threadId || !t.group) return t;
        const group = { ...t.group };
        if (patch.name !== undefined) group.name = patch.name;
        if (patch.description !== undefined) group.description = patch.description;
        if (patch.avatar !== undefined) group.avatar = patch.avatar;
        changed = { ...t, group };
        return changed;
      }),
    );
    if (changed) {
      void this.persistThread(changed);
      this.writeGroupProfile(changed.group);
    }
  }

  /** Apply my own role change from a GROUP_ROLE_CHANGED event targeting me. */
  applyRole(threadId: number, role: 'OWNER' | 'ADMIN' | 'MEMBER'): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.threadId === threadId);
      if (!found) return list;
      changed = { ...found, role };
      return list.map((t) => (t.threadId === threadId ? changed! : t));
    });
    if (changed) void this.persistThread(changed);
  }

  /** Drop a thread (self-kick / self-left / unfriend). This is the SOLE chokepoint for thread removal — the
   *  direct unfriend paths (header menu, peer-profile aside) and the indirect delta path (leaveGroup / kicked
   *  / a multi-device THREAD_REVISION DELETE, via {@link pullDelta}) all funnel here — so the full local
   *  cleanup lives here: drop the list row + open-thread pointer, delete the `threads`-store record, clear the
   *  stale {@link lastSeenSeq} residue, AND purge the cached message bodies via the message repo (the
   *  threadId is dead: the backend mints a fresh one on re-friend / re-join, so the orphaned bytes would
   *  otherwise linger until logout). Both IDB writes are best-effort + fire-and-forget. */
  removeThread(threadId: number): void {
    this._items.update((list) => list.filter((t) => t.threadId !== threadId));
    if (this._openThreadId() === threadId) this._openThreadId.set(undefined);
    this.lastSeenSeq.delete(threadId);
    this.optimisticLastRead.delete(threadId);
    void this.deleteThreadFromDb(threadId);
    void this.messageRepo.deleteByThread(threadId);
  }

  /** Optimistically clear the unread badge on a thread (UI open → mark-read). */
  clearUnread(threadId: number): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.threadId === threadId);
      if (!found) return list;
      changed = { ...found, unreadCount: 0 };
      return list.map((t) => (t.threadId === threadId ? changed! : t));
    });
    if (changed) void this.persistThread(changed);
  }

  /** Record an optimistic read watermark for `threadId` (the facade calls this as it fires markRead) — a cheap
   *  map set that drives {@link reconcileItem} to mask the unread badge + keep lastReadSeq ahead of the server
   *  while the POST is in flight. Pruned once the server catches up. No item mutation here (the open thread's
   *  badge is already 0 via clearUnread / the no-bump-while-open rule). */
  noteOptimisticRead(threadId: number, seq: number): void {
    const prev = this.optimisticLastRead.get(threadId);
    if (prev === undefined || seq > prev) this.optimisticLastRead.set(threadId, seq);
  }

  /** Reconcile a server-merged item with the optimistic read watermark — PURE (no map mutation). While the
   *  optimistic seq leads the server's, the server value is transiently stale (a markRead POST is in flight) →
   *  return the optimistic lastReadSeq + a masked (0) unread badge. When the server has caught up this returns
   *  the item unchanged; the caller drops the override via {@link pruneOptimistic}. */
  private reconcileItem(it: ConversationItem): ConversationItem {
    const opt = this.optimisticLastRead.get(it.threadId);
    if (opt === undefined) return it;
    const server = it.lastReadSeq ?? -1;
    if (server >= opt) return it; // server caught up — caller prunes the override
    return { ...it, lastReadSeq: opt, unreadCount: 0 };
  }

  /** Drop optimistic overrides the server has caught up to (server lastReadSeq ≥ optimistic). Called AFTER a
   *  server merge so an override stops masking future regressions once it has served its purpose (the POST has
   *  landed). Kept separate from the pure {@link reconcileItem} so the read has no hidden side effects. */
  private pruneOptimistic(serverByThread: Map<number, number | null>): void {
    for (const [tid, lrs] of serverByThread) {
      const opt = this.optimisticLastRead.get(tid);
      if (opt !== undefined && (lrs ?? -1) >= opt) this.optimisticLastRead.delete(tid);
    }
  }

  /** Merge the missed-summary's authoritative per-thread `lastReadSeq` into the list items (reconciled with the
   *  optimistic override). The summary is the freshest per-thread read state (it runs on every SSE signal), so
   *  this keeps each item's lastReadSeq current without a full snapshot refresh. Does not own unreadCount — the
   *  snapshot + live bumps do; {@link reconcileItem} masks the transient regression while optimistic leads. */
  private mergeSummaryReadState(items: MissedThreadItem[]): void {
    if (items.length === 0) return;
    const serverByThread = new Map<number, number | null>();
    for (const i of items) serverByThread.set(i.threadId, i.lastReadSeq);
    let changed = false;
    const updated = this._items().map((it) => {
      const serverLrs = serverByThread.get(it.threadId);
      if (serverLrs === undefined) return it;
      const next = this.reconcileItem({ ...it, lastReadSeq: serverLrs });
      if (next.lastReadSeq !== it.lastReadSeq || next.unreadCount !== it.unreadCount) changed = true;
      return next;
    });
    this.pruneOptimistic(serverByThread); // drop overrides the server just confirmed
    if (changed) {
      this._items.set(updated);
      void this.persistThreads(updated);
    }
  }

  /** READ_CURSOR (cross-tab / cross-device): another of the caller's connections marked `threadId` read up to
   *  `lastReadSeq`. Apply it authoritatively — advance the item's lastReadSeq (monotonic) + clear that thread's
   *  badge, and drop any optimistic override (the server has confirmed the read). The backend echoes this only
   *  to the caller's OTHER connections, so this is the cross-instance sync channel. */
  private onReadCursor(d: { threadId: number; lastReadSeq: number }): void {
    if (typeof d?.threadId !== 'number' || typeof d?.lastReadSeq !== 'number') return;
    this.optimisticLastRead.delete(d.threadId);
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.threadId === d.threadId);
      if (!found) return list;
      const cur = found.lastReadSeq ?? -1;
      if (d.lastReadSeq <= cur) return list; // never regress
      changed = { ...found, lastReadSeq: d.lastReadSeq, unreadCount: 0 };
      return list.map((t) => (t.threadId === d.threadId ? changed! : t));
    });
    if (changed) void this.persistThread(changed);
  }

  /** Insert or refresh a single ConversationItem (from a delta ADD's getThreadInfo fetch). Mirrors
   *  applyItems' FLIP: if `_pendingTopId` matches, force-top it + emit `topInserted`. Idempotent. */
  private upsertThread(item: ConversationItem): void {
    const reconciled = this.reconcileItem(item);
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === reconciled.threadId);
      const base = list.slice();
      if (idx === -1) base.unshift(reconciled);
      else base[idx] = reconciled;
      const sorted = base.sort(byPinRank);
      return this._pendingTopId === reconciled.threadId ? moveToTop(sorted, reconciled.threadId) : sorted;
    });
    if (this._pendingTopId === reconciled.threadId) {
      this._topInserted.set(reconciled.threadId);
      this._pendingTopId = null;
    }
    this._status.set('READY');
    void this.persistThread(reconciled);
    // A fresh item carries an embedded peer/group profile — write it through too (avatar freshness).
    if (reconciled.type === 'P2P') this.writePeerProfile(reconciled.peerUser);
    else if (reconciled.type === 'GROUP') this.writeGroupProfile(reconciled.group);
  }

  private applyItems(items: ConversationItem[]): void {
    const reconciled = items.map((it) => this.reconcileItem(it));
    const sorted = [...reconciled].sort(byPinRank);
    const topId = this.resolveTopId(reconciled);
    const ordered = topId != null ? moveToTop(sorted, topId) : sorted;
    this._items.set(ordered);
    this._status.set('READY');
    if (topId != null) this._topInserted.set(topId);
  }

  /** Determine which thread (if any) to promote to index 0 on this update, consuming the pending flag. */
  private resolveTopId(items: ConversationItem[]): number | undefined {
    let topId: number | undefined;
    if (this._pendingTopId != null && items.some((t) => t.threadId === this._pendingTopId)) {
      topId = this._pendingTopId;
    }
    this._pendingTopId = null;
    return topId;
  }

  // ── SSE handlers ───────────────────────────────────────────────────────────────────────────

  /** THREAD_META (multi-device sync for mute/pin/clear/alias). */
  private onThreadMeta(d: ThreadMetaPayload | undefined): void {
    if (!d || d.threadId === undefined) return;
    this.applyThreadMeta(d.threadId, {
      muted: d.muted,
      pinned: d.pinned,
      pinnedAt: d.pinnedAt,
      clearedAt: d.clearedAt,
      alias: d.alias,
    });
  }

  /** PEER_PROFILE_UPDATED — a friend changed avatar/name/bio. Patch the matching P2P row by peerUser.id. */
  private onPeerProfileUpdated(u: User): void {
    if (typeof u?.id !== 'number') return;
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.type === 'P2P' && t.peerUser?.id === u.id);
      if (!found) return list;
      changed = { ...found, peerUser: u };
      return list.map((t) => (t.type === 'P2P' && t.peerUser?.id === u.id ? changed! : t));
    });
    if (changed) {
      void this.persistThread(changed);
      this.writePeerProfile(u);
    }
  }

  /**
   * Apply an inbound NEW_MESSAGE identity signal `{ threadId, seq, ts }` (no body — the body is pulled by
   * the chat-box via queryMessages; the threadlist carries no preview). Advances the missed bound T + the
   * thread's `lastMessageAt` (re-sort) and bumps unread unless it is the open thread. The signal carries no
   * creator, so own-message suppression relies on the open-thread rule (the sender is normally viewing the
   * thread they just sent to); the snapshot reconciles any rare cross-device own-message false badge. A
   * redelivered/out-of-order seq is discarded by the per-thread HWM guard. If the thread isn't in the list
   * yet (a brand-new conversation), reloads to fetch it.
   */
  onNewMessage(msg: { threadId: number; seq: number; ts: number }): void {
    // High-water-mark guard: discard a redelivered/out-of-order event whose seq isn't strictly newer.
    const prev = this.lastSeenSeq.get(msg.threadId);
    if (prev !== undefined && msg.seq <= prev) return;
    this.lastSeenSeq.set(msg.threadId, msg.seq);
    // The body isn't in the identity signal — advance `to` to this signal + schedule a debounced missed-
    // summary walk to fetch the body (the unread bump + reorder below are instant from the signal itself).
    this.setToAndPull({ threadId: msg.threadId, seq: msg.seq });

    const open = this._openThreadId();
    let existed = false;
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === msg.threadId);
      if (idx === -1) return list;
      existed = true;
      const item = list[idx];
      const unread = open === msg.threadId ? item.unreadCount : (item.unreadCount ?? 0) + 1;
      changed = { ...item, unreadCount: unread, lastMessageAt: msg.ts };
      const next = list.slice();
      next[idx] = changed;
      next.sort(byPinRank);
      return next;
    });
    if (changed) void this.persistThread(changed);
    if (!existed) this.load();
    // B1: the open thread received a new message — emit so the facade can advance the server read watermark
    // (debounced + coalesced to the max seq). The repo emits; the facade owns the markRead write.
    if (open === msg.threadId) this._openThreadMessage.next({ threadId: msg.threadId, seq: msg.seq });
  }

  /** Load the persisted missed-summary cursor from IDB — the `(threadId, seq)` of the newest message the
   *  threadlist has accounted for. Null on first boot → the next pull is a snapshot (newest `take`). */
  private async loadMissedCursor(): Promise<void> {
    const c = await this.webdb.getMeta('missedCursor');
    const obj = c as { threadId?: unknown; seq?: unknown } | null | undefined;
    this._missedCursor.set(
      obj && typeof obj.threadId === 'number' && typeof obj.seq === 'number'
        ? { threadId: obj.threadId, seq: obj.seq }
        : null,
    );
  }

  /** Load the persisted per-thread dismiss-HWM map from IDB. Malformed/absent → empty (defensive — never
   *  blocks the away path). The numeric keys are JSON-encoded as strings, so coerce + validate on read. */
  private async loadThreadHwms(): Promise<void> {
    const raw = (await this.webdb.getMeta('threadHwms')) as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw !== 'object') {
      this._threadHwms.set({});
      return;
    }
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const tid = Number(k);
      if (Number.isInteger(tid) && typeof v === 'number' && Number.isFinite(v)) out[tid] = v;
    }
    this._threadHwms.set(out);
  }

  /** Persist the cursor to IDB (best-effort, fire-and-forget) AND push it to native durable storage on
   *  Android, so the background fetchers (FCM/WorkManager) can read it as the /notifications/missed `since`
   *  while the WebView is suspended or destroyed (the IDB copy dies with the WebView). One-way webview→native;
   *  native only reads. */
  private saveMissedCursor(c: MissedCursor): void {
    void this.webdb.putMeta('missedCursor', c);
    // JSON string — the @JavascriptInterface bridge takes a string (mirrors setFirebaseConfig).
    if (isAndroidNative()) window.SomsFcm?.setMissedCursor?.(JSON.stringify(c));
  }

  /** Debounce window for the missed-summary pull: a burst of NEW_MESSAGE signals collapses into one pull.
   *  The trailing edge fires `PULL_DEBOUNCE_MS` after the LAST signal; `PULL_MAX_WAIT_MS` is the hard
   *  ceiling so a SUSTAINED burst (a flood where a new signal lands inside the debounce window every
   *  time) still refreshes the preview within the bound instead of re-arming forever and starving it. */
  private static readonly PULL_DEBOUNCE_MS = 500;
  private static readonly PULL_MAX_WAIT_MS = 3000;
  private pullTimer?: ReturnType<typeof setTimeout>;
  /** Epoch-ms the current debounce window opened (0 = no window armed). Lets a mid-window [schedulePull]
   *  compute how much of the max-wait budget remains from the leading edge. */
  private pullArmedAt = 0;

  private schedulePull(): void {
    const now = Date.now();
    clearTimeout(this.pullTimer);
    if (this.pullArmedAt === 0) {
      // Leading edge of a fresh window → arm the standard trailing debounce.
      this.pullArmedAt = now;
      this.pullTimer = setTimeout(() => this.firePull(), ThreadRepository.PULL_DEBOUNCE_MS);
      return;
    }
    // Mid-window: never push the fire past leading-edge + PULL_MAX_WAIT_MS. If the budget is spent, fire
    // now (the burst is too long to keep coalescing); otherwise wait the smaller of the trailing debounce
    // and the remaining budget.
    const remaining = ThreadRepository.PULL_MAX_WAIT_MS - (now - this.pullArmedAt);
    const delay = remaining <= 0 ? 0 : Math.min(ThreadRepository.PULL_DEBOUNCE_MS, remaining);
    this.pullTimer = setTimeout(() => this.firePull(), delay);
  }

  /** Fire the pull and close the debounce window (the next [schedulePull] opens a fresh one). */
  private firePull(): void {
    this.pullArmedAt = 0;
    void this.pullMissed();
  }

  /** Hard cap on walk pages per pull — a runaway-loop backstop (a backend bug returning hasMore forever must
   *  not spin the client). 100 pages × 200 = 20000 threads is far past any real account. */
  private static readonly PULL_MAX_PAGES = 100;

  /** HELLO (the SSE connect handshake) — the network-refresh half of boot (the cache-paint is owned by
   *  {@link load}, which eager-paints from the IDB cache before HELLO lands). Carries the caller's userId
   *  (establishes the session — opens the IDB on cold start, idempotent on warm start), the newest-message
   *  cursor (→ the missed-summary walk's `to`), and the thread-list revision (→ a delta-replay). On each
   *  connect this: establishes the session, loads the missed cursor, delta-replays the thread list (full
   *  `(0, rev]` on first connect, incremental `(cursor, rev]` on reconnect), and kicks off the missed-
   *  summary walk. Fire-and-forget from the SSE switch. */
  private async onHello(d: HelloPayload | undefined): Promise<void> {
    if (!d || typeof d.userId !== 'number') return;
    // 1. Establish the session — opens the per-user IDB on HELLO's userId (cold start: first open; warm
    //    start: already opened by restoreSession's restoreWebdb, idempotent here). The profile fetch is
    //    gated async inside establishSession. The cache-paint is NOT repeated here — load() already eager-
    //    painted from the IDB cache (and on a cold start the cache is empty, so the delta below populates).
    await this.userService.establishSession(d.userId, d.profileRev ?? 0, d.friendReqRev ?? null, d.friendReqAckRev ?? 0);
    // 2. Load the persisted missed-summary cursor (the walk's `from`) + the per-thread dismiss-HWM map.
    await this.loadMissedCursor();
    await this.loadThreadHwms();
    // 3. Delta-replay the thread list: full `(0, rev]` on first connect (cursor unseeded → seed 0),
    //    incremental `(cursor, rev]` on reconnect. The server plans (last-op-wins) + hydrates.
    if (typeof d.threadRevision === 'number') {
      if (this.userService.threadRevCursor() === undefined) this.userService.seedThreadRevCursor(0);
      this.onThreadRevisionUpdated(d.threadRevision);
    }
    // 4. Missed-summary walk toward HELLO's newest message (debounced).
    const lm = d.latestMessage;
    if (lm && typeof lm.threadId === 'number' && typeof lm.seq === 'number') {
      this.setToAndPull({ threadId: lm.threadId, seq: lm.seq });
    }
    // 6. Re-derive previews from the local message store.
    void this.hydratePreviews();
  }

  /** Set the walk's upper bound `to` + schedule the debounced catch-up walk (a burst of signals collapses). */
  private setToAndPull(to: MissedCursor): void {
    this._to = to;
    this.schedulePull();
  }

  /** The persisted high-water mark — the newest message the threadlist has accounted for (the last walked
   *  `to`). The away-notification renderer reads it as `since` (the boundary before backgrounding). */
  missedCursor(): MissedCursor | null {
    return this._missedCursor();
  }

  /** Advance the away-HWM to `cursor` (the away-notification dismiss path). The descriptor carries the new
   *  target = the newest message its summary covered (≥ the current HWM by construction, since the summary
   *  aggregates messages newer than the HWM), so this is a forward advance — dismissing acknowledges the batch
   *  so the next background fetch's `since` gates past it (no re-fire for the same messages). No read-watermark
   *  change (lastReadSeq is untouched). */
  advanceMissedCursor(cursor: MissedCursor): void {
    this._missedCursor.set(cursor);
    this.saveMissedCursor(cursor);
  }

  /** The per-thread dismiss-HWM map (the away-notification renderer sends it as `threadHwms`). */
  threadHwms(): Record<number, number> {
    return this._threadHwms();
  }

  /** Record a per-thread dismiss — advance that thread's HWM to `seq` (monotonic; never regresses on a
   *  stale/out-of-order dismiss) so the next `/notifications/missed` pull counts this thread FROM it and the
   *  server drops it from the descriptors. Merge + persist (mirrors {@link advanceMissedCursor}). */
  recordThreadDismiss(c: { threadId: number; seq: number }): void {
    const prev = this._threadHwms()[c.threadId];
    if (prev !== undefined && c.seq <= prev) return;
    const next = { ...this._threadHwms(), [c.threadId]: c.seq };
    this._threadHwms.set(next);
    void this.webdb.putMeta('threadHwms', next);
  }

  /** Clear every per-thread dismiss-HWM (focus-regain reset — the Android "foreground → all per-thread HWMs
   *  reset" model; a dismissed thread re-fires next away period). No-op when already empty. */
  clearThreadDismiss(): void {
    if (Object.keys(this._threadHwms()).length === 0) return;
    this._threadHwms.set({});
    void this.webdb.putMeta('threadHwms', {});
  }

  /** Catch up the local message store + previews: walk the `(from, to]` double-boundary range — `from` is the
   *  persisted HWM (the last walked `to`), `to` is {@link _to} (the HELLO latestMessage, advanced by live
   *  NEW_MESSAGE signals). Pages advance `from` toward `to`; on a NON-empty walk the HWM advances to `to` (it
   *  never regresses on a stale `to ≤ from` — an empty walk leaves the HWM). Fire-and-forget from HELLO +
   *  (debounced) each NEW_MESSAGE; a transient failure retries on the next trigger. */
  private async pullMissed(): Promise<void> {
    const to = this._to;
    if (!to) return; // no HELLO yet → nothing to walk toward
    try {
      let from = this._missedCursor();
      let walkedAny = false;
      for (let i = 0; i < ThreadRepository.PULL_MAX_PAGES; i++) {
        const res = await this.missedSync.fetchMissedSummary(from, to);
        if (res.items.length > 0) {
          walkedAny = true;
          this.mergeSummaryReadState(res.items); // merge the authoritative lastReadSeq (reconciled w/ optimistic)
        }
        if (!res.hasMore) { from = to; break; } // walked the full (from, to] → caught up to `to`
        if (!res.nextCursor) break;
        from = res.nextCursor; // page max → advance `from`, continue
      }
      if (walkedAny && from) { // don't advance on an empty/stale walk (no HWM regression); from is non-null here
        this._missedCursor.set(from);
        this.saveMissedCursor(from);
      }
      await this.hydratePreviews();
    } catch {
      /* best-effort — the next HELLO/NEW_MESSAGE retries */
    }
  }

  /**
   * Apply a THREAD_REVISION_UPDATED { revision } signal: pull the ranged delta (cursor, revision] and
   * apply the server's hydrated response — DELETE drops the thread locally, ADD carries the hydrated thread
   * inline + inserts with a FLIP. Single-flight + tail-coalesce: a burst of signals collapses into one
   * ranged pull per in-flight window. The server plans (last-op-wins) + hydrates; the client only applies.
   */
  onThreadRevisionUpdated(toRev: number): void {
    if (this._deltaInFlight) {
      this._pendingTailRev = toRev;
      return;
    }
    void this.pullDelta(toRev);
  }

  private async pullDelta(toRev: number): Promise<void> {
    const cursor = this.userService.threadRevCursor();
    // Cursor undefined = boot hasn't seeded yet. Drop the signal — the HELLO replay reflects current state,
    // and the cursor advances past this signal once seeded.
    if (cursor === undefined) return;
    if (toRev <= cursor) return; // already applied (our own action echoed back, or a coalesced tail)
    this._deltaInFlight = true;
    try {
      const res = await firstValueFrom(
        this.userService.queryThreadDelta({ fromRevision: cursor, toRevision: toRev }),
      );
      if (res.code === 0) {
        // One hydrated response — ADD entries carry the item inline, DELETE entries carry the threadId only.
        // The server planned (last-op-wins) + hydrated; the client just applies (no second round-trip).
        for (const op of res.data ?? []) {
          if (op.direction === 'DELETE') this.removeThread(op.threadId);
          else {
            this.markTopOnNextUpdate(op.threadId); // precise FLIP per delta ADD
            this.upsertThread(op.item);
          }
        }
        this.userService.advanceThreadRevCursor(toRev);
      }
    } finally {
      this._deltaInFlight = false;
      const tail = this._pendingTailRev;
      this._pendingTailRev = undefined;
      if (tail !== undefined && tail > (this.userService.threadRevCursor() ?? -Infinity)) {
        void this.pullDelta(tail);
      }
    }
  }

  /** Re-derive each thread's list preview (`lastMessagePreview` + `lastMessageSenderId`) from the LOCAL
   *  message store — the durable, local-first source. The threadlist snapshot deliberately embeds NO preview
   *  content (the body is pulled, never denormalized — see query-thread/valid), so the list derives its
   *  preview from each thread's newest cached message. This covers EVERY thread with a cached newest message
   *  (not just the missed-summary page of the newest `take`), and on a cold start the local store is already
   *  populated from the prior session → previews paint instantly from the cached-paint items with no network
   *  round-trip and no "暂无消息" flash. Runs on boot (right after the snapshot, before the network pull) +
   *  after each missed pull (which pre-warms the local store). Leaves `lastMessageAt` untouched (the
   *  snapshot's value is the authoritative sort key); a thread with no cached message yet keeps its prior
   *  preview. */
  private async hydratePreviews(): Promise<void> {
    const items = this._items();
    if (items.length === 0) return;
    // One batched read (a single transaction, one reverse cursor per thread) — never N independent lookups.
    const newest = await this.messageRepo.getNewestMessages(items.map((it) => it.threadId));
    if (newest.size === 0) return; // nothing cached locally yet — leave the items' previews as-is
    const byThread = new Map<number, { lastMessagePreview: string; lastMessageSenderId: number }>();
    for (const it of items) {
      const m = newest.get(it.threadId);
      if (!m) continue;
      byThread.set(it.threadId, {
        lastMessagePreview: rawPreview(m.contentType, m.content),
        lastMessageSenderId: m.creator,
      });
    }
    if (byThread.size === 0) return;
    this._items.update((list) =>
      list.map((it) => {
        const patch = byThread.get(it.threadId);
        return patch ? { ...it, ...patch } : it;
      }),
    );
    // Persist so the next boot's cached paint already carries the derived preview (no "暂无消息" flash).
    void this.persistThreads(this._items());
  }

  // ── IDB persistence helpers (best-effort; IDB unavailable → graceful no-op) ────────────────

  /** Read all cached threads from IDB, ordered by pin rank (for instant boot paint). */
  private async readCachedThreads(): Promise<ConversationItem[]> {
    try {
      const all = await (await this.webdb.db()).getAll('threads');
      return all.sort(byPinRank);
    } catch {
      return [];
    }
  }

  /** Rewrite the whole `threads` store from a snapshot (clear + put all, in one transaction). */
  private async persistThreads(items: ConversationItem[]): Promise<void> {
    try {
      const db = await this.webdb.db();
      const tx = db.transaction('threads', 'readwrite');
      await tx.store.clear();
      for (const it of items) await tx.store.put(it);
      await tx.done;
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
  }

  /** Write-through a single changed thread (idempotent put by threadId). */
  private async persistThread(item: ConversationItem): Promise<void> {
    try {
      await (await this.webdb.db()).put('threads', item);
    } catch {
      /* best-effort */
    }
  }

  private async deleteThreadFromDb(threadId: number): Promise<void> {
    try {
      await (await this.webdb.db()).delete('threads', threadId);
    } catch {
      /* best-effort */
    }
  }

  /** Write an embedded peer/group profile through the profile store (drives avatar refresh on path change). */
  private writePeerProfile(u: User): void {
    void this.profileRepo.putProfile(`u${u.id}`, 'user', {
      id: u.id, name: u.name, avatar: u.avatar, bio: u.bio, domain: u.domain,
    });
  }
  private writeGroupProfile(g: { id: number; name: string; avatar: string }): void {
    void this.profileRepo.putProfile(`g${g.id}`, 'group', { id: g.id, name: g.name, avatar: g.avatar });
  }
}

// ── SSE payload shapes (the subset of fields each handler reads) ─────────────────────────────

/** HELLO (SSE connect handshake) payload — pushed once per connect, the sole boot-critical state the
 *  client cannot derive locally: the caller's userId (opens the per-user IDB), the newest-message cursor
 *  (→ the missed-summary walk's `to`), the thread-list revision (→ delta-replay `(0, rev]` on first
 *  connect), the self-profile version (→ gate the /user/my-profile fetch), and the friend-request revision
 *  (→ the unread badge, derived vs the client's friendReqAckRev). */
interface HelloPayload {
  userId?: number;
  latestMessage?: { threadId: number; seq: number; ts: number } | null;
  threadRevision?: number;
  profileRev?: number;
  friendReqRev?: number | null;
  friendReqAckRev?: number;
}

interface ThreadMetaPayload {
  threadId?: number;
  muted?: boolean;
  pinned?: boolean;
  pinnedAt?: number | null;
  clearedAt?: number | null;
  alias?: string | null;
}

/** Derive the RAW list preview by content type — the UN-localized form stored on the item. PURE_TEXT
 *  yields the message text; media types yield a closed set of English markers (`[Photo]`, `[Group invite]`,
 *  …) that exactly match the backend's `derivePreview` AND the view's `PREVIEW_MARKERS` map, so the view
 *  ({@link ThreadListComponent.previewText}) localizes them at render time. Pure: no i18n dependency. */
export function rawPreview(contentType: string, content: string): string {
  switch (contentType) {
    case 'PURE_TEXT':
      return content.replace(/\s+/g, ' ').trim().slice(0, 200);
    case 'IMAGE':
      return '[Photo]';
    case 'INVITE':
      return '[Group invite]';
    case 'VIDEO':
      return '[Video]';
    case 'FILE':
      return '[File]';
    case 'AUDIO':
      return '[Voice message]';
    default:
      return content.slice(0, 200);
  }
}

/** Return a new array with the first item matching `threadId` moved to index 0 (no-op if absent/first). */
function moveToTop<T extends { threadId: number }>(items: T[], threadId: number): T[] {
  const idx = items.findIndex((t) => t.threadId === threadId);
  if (idx <= 0) return items;
  const next = items.slice();
  const [moved] = next.splice(idx, 1);
  next.unshift(moved);
  return next;
}

/** Pin-aware conversation-list rank comparator — the SINGLE source of truth for client-side ordering,
 *  kept in lockstep with the backend's query-thread/valid ORDER BY. Pinned tier first (most-recently-
 *  pinned first via pinnedAt desc); then unpinned recent-first by lastMessageAt; empty threads sink;
 *  threadId breaks ties deterministically. */
function byPinRank(a: ConversationItem, b: ConversationItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned) {
    const ta = a.pinnedAt ?? -Infinity;
    const tb = b.pinnedAt ?? -Infinity;
    return tb - ta || a.threadId - b.threadId;
  }
  const la = a.lastMessageAt ?? -Infinity;
  const lb = b.lastMessageAt ?? -Infinity;
  return lb - la || a.threadId - b.threadId;
}
