import { Injectable, inject, signal, effect } from '@angular/core';
import { filter, firstValueFrom, forkJoin, map, catchError, of, Subscription } from 'rxjs';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ProfileRepository } from './profile-store.service';
import { MessageRepository } from './message-repository.service';
import { MissedSyncService, type MissedThreadItem } from './missed-sync.service';
import type { MissedCursor } from './notification-descriptor.model';
import { ConversationItem, User } from './model';
import { planDelta } from './thread-delta';
import { toFriendlyHttpError } from './http-error';

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
 * list READs (`/user/query-thread/valid`, `/user/thread-info`, `/user/query-thread/delta`) and the ONLY
 * consumer of the thread-list DATA SSE events (`NEW_MESSAGE`, `THREAD_META`, `THREAD_REVISION_UPDATED`,
 * `PEER_PROFILE_UPDATED`). UI-facing services read its signals; they never fetch or mutate from SSE.
 *
 * NO write operations live here — `markRead` (a write) stays in the UI layer ({@link ConversationListService}
 * facade) and bypasses the DB layer, per the 3-tier contract. This repository only GETs (snapshot + delta
 * + single-thread backfill) and listens (SSE).
 *
 * Persistence (Phase 3): every conversation is mirrored to IDB (`threads` store, one record per
 * `threadId`). On boot the cached records paint INSTANTLY (no skeleton flash for returning users), then a
 * background snapshot refreshes previews / unread / membership — the SSE stream does NOT replay events
 * missed while the app was closed, so the snapshot is the freshness backstop (the online delta only
 * covers add/delete membership changes while connected).
 *
 * Incremental: each data-SSE event mutates exactly the affected record(s) in IDB + emits a fine-grained
 * signal update — never a whole-list re-fetch, never a component reload.
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

  /** True while a boot (cache-read + snapshot refresh) is in progress — the SOLE single-flight guard:
   *  a non-force {@link load} is a no-op while this is set. Set at the start of {@link boot} and cleared
   *  in its `finally` (only by the newest boot, so a force supersedure doesn't prematurely clear it). Do
   *  NOT gate on `_status() === 'LOADING'` instead — the initial status IS 'LOADING' before the first
   *  boot, so that would block the first boot and the list would never load until a reconnect. */
  private bootInFlight = false;
  /** Generation counter: a `force` boot supersedes an in-flight one; a stale boot's writes are dropped. */
  private bootGen = 0;

  /** Per-thread high-water-mark of the newest message seq applied via onNewMessage. Guards against SSE
   *  redelivery (e.g. a frame duplicated across a reconnect) double-bumping the unread badge: if an inbound
   *  event's seq isn't strictly newer than the last one applied for that thread, it's discarded before
   *  touching the list. Per-thread seq is a 0-indexed monotonic int (allocated by the backend), so a plain
   *  numeric compare is exact. Not seeded from the loaded list (items carry lastReadSeq, not the last message
   *  seq) — the first live event after a reload passes (it IS new to the in-memory state); only same/older
   *  duplicates are blocked. */
  private readonly lastSeenSeq = new Map<number, number>();

  /** Previous sessionProfile id seen by the session-end effect (null = no logged-in user). */
  private prevSessionId: number | null = null;

  /** The forward cursor for the missed-summary pull — the `(threadId, seq)` of the newest message the
   *  threadlist has accounted for (the backend resolves it to the internal message `id` it never exposes,
   *  and returns `id > cursor` ASC). Seeded at boot from IDB, advanced per pull to the response
   *  `nextCursor`. Owned HERE (the threadlist state owner). Null on first boot → the endpoint returns the
   *  newest `take` threads (a snapshot); subsequent pulls walk forward from the cursor. The background
   *  notification paths (Android/Web SW) pull the same endpoint with no cursor (current unread state). */
  private readonly _missedCursor = signal<MissedCursor | null>(null);

  private readonly sseSub: Subscription;

  constructor() {
    // ── thread-list DATA SSE events (the DB layer is the sole consumer) ──
    this.sseSub = this.ws.eventSubject.subscribe((m) => {
      switch (m.event) {
        case 'NEW_MESSAGE':
          if (m.data !== undefined) this.onNewMessage(m.data as { threadId: number; seq: number; ts: number });
          break;
        case 'THREAD_META':
          this.onThreadMeta(m.data as ThreadMetaPayload | undefined);
          break;
        case 'THREAD_REVISION_UPDATED':
          if (m.data !== undefined) this.onThreadRevisionUpdated((m.data as { revision: number }).revision);
          break;
        case 'PEER_PROFILE_UPDATED':
          if (m.data !== undefined) this.onPeerProfileUpdated(m.data as unknown as User);
          break;
      }
    });

    // Reconnect → force boot: re-snapshot (unread / membership / add-delete missed during the disconnect
    // — SSE does not replay) + re-pull the time-bounded missed-summary (T advances per message).
    this.sseSub.add(this.ws.reconnect$.subscribe(() => this.load({ force: true })));

    // Session-end reset: when the session ends (sessionProfile → undefined, i.e. clearSession/logout),
    // drop the in-memory list so a second account logging into the same live SPA cannot inherit this
    // user's cached list. The IDB partition is handled by WebdbService; this covers the in-memory layer.
    // Reset flips status back to LOADING, so the next login's ThreadListComponent.ngOnInit (guarded on
    // `status===LOADING && items empty`) re-triggers load() — otherwise the stale READY+items would
    // suppress the reload, and the SSE worker's fresh connect emits no `reconnect$` pulse to do it.
    // Driven by the same sessionProfile signal UserService already uses for the DB open/close effect
    // (consistent lifecycle; no extra registration API for consumers to wire).
    effect(() => {
      const id = this.userService.sessionProfile()?.id ?? null;
      if (id === this.prevSessionId) return;
      this.prevSessionId = id;
      if (id === null) this.reset();
    });
  }

  /**
   * Drop ALL in-memory session state (logout / account switch). The IDB store is closed + deleted by
   * WebdbService; this resets the in-memory caches so they cannot leak across users. Bumps {@link bootGen}
   * to invalidate any in-flight boot of the previous user (its snapshot is now stale and must not be
   * written back), and clears {@link bootInFlight} so the next login's boot runs. Resets {@link _status}
   * to LOADING so the freshly-mounted list re-loads.
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
    this._missedCursor.set(null);
    clearTimeout(this.pullTimer);
    this.pullArmedAt = 0;
    this.bootGen++;
    this.bootInFlight = false;
  }

  // ── boot: cached paint → snapshot refresh ──────────────────────────────────────────────────

  /**
   * Load (or refresh) the conversation list. Boot-from-cache: paint cached records instantly (READY, no
   * skeleton), then a background snapshot freshens. A non-force call while a boot is already in-flight is
   * a no-op ({@link bootInFlight}); a force call (reconnect) bypasses the guard and supersedes the
   * in-flight boot via {@link bootGen}.
   *
   * The guard is `bootInFlight` ONLY. The initial `_status` is `'LOADING'` before any boot has run, so
   * gating on `_status() === 'LOADING'` would reject the very first boot — the list would never load
   * until a reconnect (ThreadListComponent.ngOnInit's non-force `load()` is the initial trigger).
   */
  load(opts?: { force?: boolean }) {
    if (!opts?.force && this.bootInFlight) return;
    this._error.set('');
    // First boot with no cache → LOADING (skeleton gate). With cache (or a reconnect refresh) → keep the
    // current paint; the snapshot freshens silently in the background.
    if (this._items().length === 0) this._status.set('LOADING');
    void this.boot(opts?.force === true);
  }

  private async boot(force: boolean): Promise<void> {
    const gen = ++this.bootGen;
    this.bootInFlight = true;
    try {
      if (!force) {
        const cached = await this.readCachedThreads();
        if (gen !== this.bootGen) return; // a newer boot superseded this one
        if (cached.length > 0) {
          this.applyItems(cached);
          this._status.set('READY');
        }
      }
      // Freshness snapshot: SSE does not replay offline events, so previews / unread / membership changes
      // that landed while the app was closed are caught up here (the online delta only covers add/delete
      // while connected).
      await firstValueFrom(this.userService.ensureProfile({ force }));
      if (gen !== this.bootGen) return;
      const fresh = await firstValueFrom(this.userService.queryAllUserThreads());
      if (gen !== this.bootGen) return;
      this.applyItems(fresh);
      void this.persistThreads(this._items());
      this._status.set('READY');
      this._error.set('');
      // Load the persisted missed-summary cursor, then pull one page to refresh each thread's preview +
      // pre-warm the latest message body (the snapshot carries unread + lastMessageAt + the denormalized
      // lastMessagePreview; this pull supplements full bodies + advances the cursor). Fire-and-forget — a
      // transient failure retries on reconnect.
      await this.loadMissedCursor();
      void this.pullMissed();
    } catch (err) {
      if (gen !== this.bootGen) return;
      // First-boot failure (no cached paint) → ERROR. Otherwise keep the cached paint (stale but usable);
      // a later reconnect retries.
      if (this._items().length === 0) this.failLoad(err);
    } finally {
      // Only the newest boot owns the in-flight flag — a force supersedure (gen mismatch) leaves it set
      // for the newer boot to clear when it finishes.
      if (gen === this.bootGen) this.bootInFlight = false;
    }
  }

  private failLoad(err: unknown): void {
    this._error.set(toFriendlyHttpError(err));
    this._status.set('ERROR');
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

  /** Insert or refresh a single ConversationItem (from a delta ADD's getThreadInfo fetch). Mirrors
   *  applyItems' FLIP: if `_pendingTopId` matches, force-top it + emit `topInserted`. Idempotent. */
  private upsertThread(item: ConversationItem): void {
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === item.threadId);
      const base = list.slice();
      if (idx === -1) base.unshift(item);
      else base[idx] = item;
      const sorted = base.sort(byPinRank);
      return this._pendingTopId === item.threadId ? moveToTop(sorted, item.threadId) : sorted;
    });
    if (this._pendingTopId === item.threadId) {
      this._topInserted.set(item.threadId);
      this._pendingTopId = null;
    }
    this._status.set('READY');
    void this.persistThread(item);
    // A fresh item carries an embedded peer/group profile — write it through too (avatar freshness).
    if (item.type === 'P2P') this.writePeerProfile(item.peerUser);
    else if (item.type === 'GROUP') this.writeGroupProfile(item.group);
  }

  private applyItems(items: ConversationItem[]): void {
    const sorted = [...items].sort(byPinRank);
    const topId = this.resolveTopId(items);
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
    // The body isn't in the identity signal — schedule a debounced missed-summary pull to refresh this
    // thread's preview (the unread bump + reorder above are instant from the signal itself).
    this.schedulePull();

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

  /** Persist the cursor to IDB (best-effort, fire-and-forget). */
  private saveMissedCursor(c: MissedCursor): void {
    void this.webdb.putMeta('missedCursor', c);
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

  /** Pull one missed-summary page: refresh each thread's preview (lastMessagePreview/SenderId) from its
   *  latest message body, pre-warm the body cache, and advance + persist the cursor to the response
   *  `nextCursor` (the page's max-id item — strict-total-order forward pagination, no overlap). Fire-and-
   *  forget from boot + reconnect + (debounced) each NEW_MESSAGE; a transient failure retries on the next
   *  trigger. */
  private async pullMissed(): Promise<void> {
    try {
      const { items, nextCursor } = await this.missedSync.fetchMissedSummary(this._missedCursor());
      if (items.length > 0) {
        // Index the summary by threadId once (O(items)) so each list row is an O(1) lookup, not an O(items)
        // scan inside the map (O(threads × items)). A thread's latestMessage is its newest body.
        const latestByThread = new Map<number, NonNullable<MissedThreadItem['latestMessage']>>();
        for (const i of items) if (i.latestMessage) latestByThread.set(i.threadId, i.latestMessage);
        this._items.update((list) =>
          list.map((it) => {
            const m = latestByThread.get(it.threadId);
            if (!m) return it;
            return {
              ...it,
              lastMessagePreview: rawPreview(m.contentType, m.content),
              lastMessageSenderId: m.creator,
              lastMessageAt: m.createdAt,
            };
          }),
        );
        void this.persistThreads(this._items());
      }
      // Advance the cursor to the page's max-id item (null only when the page was empty → nothing new; the
      // cursor stays put so the next pull re-checks forward from the same position).
      if (nextCursor) {
        this._missedCursor.set(nextCursor);
        this.saveMissedCursor(nextCursor);
      }
    } catch {
      /* best-effort — the next boot/reconnect/NEW_MESSAGE retries */
    }
  }

  /**
   * Apply a THREAD_REVISION_UPDATED { revision } signal: pull the ranged delta (cursor, revision] and
   * merge — DELETE drops the thread locally, ADD fetches the single new thread + inserts with a FLIP.
   * Single-flight + tail-coalesce: a burst of signals collapses into one ranged pull per in-flight window.
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
    // Cursor undefined = boot hasn't seeded yet. Drop the signal — the boot snapshot reflects current
    // state, and the cursor advances past this signal once seeded.
    if (cursor === undefined) return;
    if (toRev <= cursor) return; // already applied (our own action echoed back, or a coalesced tail)
    this._deltaInFlight = true;
    try {
      const res = await firstValueFrom(
        this.userService.queryThreadDelta({ fromRevision: cursor, toRevision: toRev }),
      );
      if (res.code === 0) {
        const plan = planDelta(cursor, toRev, res.data ?? []);
        for (const id of plan.removeIds) this.removeThread(id);
        if (plan.addIds.length > 0) {
          const fetches = plan.addIds.map((id) => {
            this.markTopOnNextUpdate(id); // precise FLIP — the delta carries the threadId
            return this.userService.getThreadInfo({ threadId: id }).pipe(
              map((r) => (r.code === 0 && r.data ? r.data : null)),
              catchError(() => of(null)), // a failed fetch is skipped, not fatal to the batch
            );
          });
          const items = await firstValueFrom(forkJoin(fetches));
          for (const item of items) if (item) this.upsertThread(item);
        }
        this.userService.advanceThreadRevCursor(plan.nextCursor);
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
