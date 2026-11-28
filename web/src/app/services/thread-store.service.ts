import {
  Injectable,
  inject,
  signal,
  effect,
  computed,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  defer,
  of,
  firstValueFrom,
  fromEvent,
  Subject,
  Subscription,
  takeUntil,
} from 'rxjs';
import { KeyedProjectionScheduler } from '../lib/keyed-projection-scheduler';
import { WebdbService } from './webdb.service';
import type { ThreadAttentionProjection } from './webdb-storage';
import type { GroupMetaCommitPatch } from './group-meta-model';
import { homeProfileDemand } from './profile-demand';
import {
  unevidencedProfileDemand,
  type ProfileRequest,
} from '../../../../shared/profile-demand';
import { ProfileRepository } from './profile-store.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import {
  ConversationItem,
  GroupConversationItem,
  GroupThreadPatch,
  LocalThreadPatch,
  localSubjectIdentity,
} from './model';
import { MemberProfileRepository } from './member-profile-store.service';
import { AppDataLifetime } from './app-data-lifetime.service';
import { ActiveThreadPresentation } from './active-thread-presentation.service';
import { isAndroidNative } from './runtime';
import type { ThreadNotificationUpdate } from './thread-notification';
import { compareThreadItems, mergeThreadItems } from './thread-list-order';
import { ConversationLoadStatus } from './conversation-load-status';

export { ConversationLoadStatus } from './conversation-load-status';

import {
  advanceLocalAttentionRead,
  attentionSnapshot,
  mergeThreadAttention,
  threadNotificationChanged,
  type LocalThreadAttention,
  type ThreadFeedSnapshot,
  type ThreadAliasApplied,
} from '../../../../shared/thread-attention';

type ThreadContentHead = Pick<ThreadFeedSnapshot, 'threadId' | 'messageEndSeq'>;

/**
 * In-memory conversation-list projection. The database Worker or Rust runtime owns state-feed
 * pagination and commits. HELLO establishes the session; local completion events cause this
 * repository to re-read committed rows. It never fetches feed pages from the renderer.
 *
 * Boot is split across an eager cache-paint + a HELLO-driven network refresh:
 *  - {@link load} eager-paints the IDB `threads` store INSTANTLY on mount — the per-user IDB is opened on
 *    the persisted lastUserId by AuthService.restoreSession (an APP_INITIALIZER, pre-router), so a returning
 *    user sees their list BEFORE the SSE/HELLO round-trip. A cold start (no cache) paints nothing until HELLO.
 *  - {@link onHello} (the SSE connect handshake) then drains the one ClientStateFeed (full on first
 *    connect, incremental on reconnect). The SSE stream does not replay events missed while offline, so
 *    this HELLO-driven state-feed pull is the freshness backstop.
 *
 * Every conversation is mirrored to IDB (`threads` store, one record per `threadId`). Each data-SSE event
 * mutates exactly the affected record(s) in IDB + emits a fine-grained signal update — never a whole-list
 * re-fetch, never a component reload.
 */
@Injectable({ providedIn: 'root' })
export class ThreadRepository {
  private readonly webdb = inject(WebdbService);
  private readonly profiles = inject(ProfileRepository);
  private readonly userService = inject(UserService);
  private readonly ws = inject(WebsocketService);
  private readonly messageRepo = inject(MessageRepository);
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly appData = inject(AppDataLifetime);
  private readonly activePresentation = inject(ActiveThreadPresentation);
  private readonly runtimeEnded = defer(() =>
    this.appData.signal.aborted
      ? of(undefined)
      : fromEvent(this.appData.signal, 'abort'),
  );

  private readonly _items = signal<ConversationItem[]>([]);
  private readonly threadStates = new Map<number, LocalThreadAttention>();
  private readonly pendingNotifications = new Set<number>();
  private readonly projections = new KeyedProjectionScheduler<
    number,
    ThreadAttentionProjection
  >({
    read: async (threadId) => {
      const me = this.userService.sessionProfile();
      if (!this.threadStates.has(threadId) || !me) return;
      return this.webdb.projectThreadAttention(threadId, {
        account: me.account,
        namespaceId: me.namespaceId,
      });
    },
    publish: (threadId, projection) => {
      const state = attentionSnapshot(this.threadStates.get(threadId));
      if (!state) return;
      const item = this.applyThreadAttentionProjection(projection);
      if (this.pendingNotifications.delete(threadId) && item)
        this.threadNotifications.next([{ item, state }]);
    },
    onError: (_threadId, error) =>
      console.warn('[thread-feed] attention projection failed', error),
  });
  readonly items = computed(() =>
    this._items().filter(
      (item): item is ConversationItem & { threadFeedId: number } =>
        item.visible !== false && isThreadListFeedId(item.threadFeedId),
    ),
  );

  private readonly _status = signal<ConversationLoadStatus>('LOADING');
  readonly status = this._status.asReadonly();

  // List rows may become visible one at a time during restoration. Absence is
  // meaningful for navigation only after a complete durable projection read.
  private readonly _navigationReady = signal(false);
  readonly navigationReady = this._navigationReady.asReadonly();

  private readonly _error = signal('');
  readonly error = this._error.asReadonly();

  /** The single active conversation, distinct from any set of mounted/open panes.
   * The UI selects it; the presentation bridge reports it to the native notification owner. */
  private readonly _activeThreadId = signal<number | undefined>(undefined);
  readonly activeThreadId = this._activeThreadId.asReadonly();

  /** Authoritative server cursor versus the locally-dwelled lower bound. ConversationItem.lastReadSeq remains
   *  the effective projection consumed by existing views; these maps keep the two meanings explicit. */
  private readonly serverLastReadSeq = new Map<number, number | null>();
  private readonly localStableReadSeq = new Map<number, number>();
  /** A content head can share a page with the relationship state that materializes its thread. */
  private readonly pendingUnknownContentHeads = new Map<
    number,
    ThreadContentHead
  >();

  /** Per-thread in-memory high-water mark for the newest message seq observed in this live session. It also
   *  avoids repeated list work for duplicate SSE
   *  redelivery (e.g. a frame duplicated across a reconnect) double-bumping the unread badge: if an inbound
   *  event's seq isn't strictly newer than the last one applied for that thread, it's discarded before
   *  touching the list. It is deliberately not seeded from or persisted with the cached thread row. */
  private readonly lastSeenSeq = new Map<number, number>();
  private readonly _threadSeq = new Subject<{
    threadId: number;
    seq: number;
  }>();
  readonly threadSeq$ = this._threadSeq.asObservable();
  private readonly threadNotifications = new Subject<
    ThreadNotificationUpdate[]
  >();
  readonly threadNotifications$ = this.threadNotifications.asObservable();

  latestSeq(threadId: number): number | undefined {
    return this.lastSeenSeq.get(threadId);
  }

  readCursorState(threadId: number): {
    serverLastReadSeq: number | null;
    localStableReadSeq: number | null;
    effectiveLastReadSeq: number | null;
  } {
    const server = this.serverLastReadSeq.get(threadId) ?? null;
    const local = this.localStableReadSeq.get(threadId) ?? null;
    return {
      serverLastReadSeq: server,
      localStableReadSeq: local,
      effectiveLastReadSeq: local ?? server,
    };
  }

  private readonly confirmedAliases = new Map<number, ThreadAliasApplied>();

  private readonly sseSub: Subscription;

  constructor() {
    const stop = () => {
      this.clearProjection();
      this.projections.destroy();
      this.sseSub?.unsubscribe();
    };
    this.appData.signal.addEventListener('abort', stop, { once: true });
    inject(DestroyRef).onDestroy(() => {
      this.appData.end();
      this.appData.signal.removeEventListener('abort', stop);
      stop();
    });
    if (isAndroidNative()) {
      document.addEventListener('visibilitychange', this.onAppVisibilityChange);
      inject(DestroyRef).onDestroy(() =>
        document.removeEventListener(
          'visibilitychange',
          this.onAppVisibilityChange,
        ),
      );
    }
    this.webdb.profileWake$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe((wake) => {
        if (wake.event !== 'PROFILE_AVAILABLE') return;
        for (const item of this._items()) {
          const reference = threadProfileReference(item);
          if (
            reference.namespaceId === wake.key.profileNamespaceId &&
            reference.account === wake.key.account &&
            reference.profileRev === wake.key.rev
          )
            void this.resolveThreadProfile(item);
        }
      });
    this.messageRepo.slotsChanged$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe((threadId) => {
        void this.projectThreadAttention(threadId);
      });
    this.webdb.workerFailed$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe(() => {
        // A dead DB worker also destroys the direct port; a new HELLO binds a replacement.
        this.ws.disconnect();
        this.ws.connect();
      });
    // The database worker reports feed-drain completions directly (it used
    // to route through the SSE worker as LOCAL_*_COMMITTED events).
    // Browser path: the DB worker reports drain completions directly with the
    // changed states inline — the renderer applies them incrementally and
    // never re-reads the feed database. (Tauri walks sseSub below instead:
    // Rust emits LOCAL_* without states and the renderer reads the diff.)
    this.webdb.threadFeedCommitted$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        void this.applyThreadStates(data.states, true).catch((error) => {
          if (!this.appData.signal.aborted)
            console.warn(
              '[thread-feed] committed state projection failed',
              error,
            );
        });
      });
    this.webdb.groupMetaCommitted$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        this.applyGroupMetaPatches(data.patches);
        this.memberProfiles.notifyChanged(
          data.threadIds.filter((threadId) =>
            this._items().some(
              (thread) =>
                thread.type === 'GROUP' && thread.threadId === threadId,
            ),
          ),
        );
      });
    this.webdb.stateFeedCommitted$
      .pipe(takeUntil(this.runtimeEnded), takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        void this.refreshCommittedStateFeed().catch((error) => {
          if (!this.appData.signal.aborted)
            console.warn('[state-feed] committed state refresh failed', error);
        });
      });
    // ── thread-list DATA SSE events (the DB layer is the sole consumer) ──
    this.sseSub = this.ws.eventSubject
      .pipe(takeUntil(this.runtimeEnded))
      .subscribe((m) => {
        switch (m.event) {
          case 'HELLO': {
            void this.onHello(m.data as HelloPayload | undefined).catch(
              (error) => {
                if (this.appData.signal.aborted) return;
                // SSE already reconnects and redelivers HELLO. Do not enter local recovery.
                console.warn(
                  '[sse] HELLO handling failed; reconnect retries',
                  error,
                );
              },
            );
            break;
          }
          case 'STATE_FEED_UPDATED':
            // SSE workers hand the wake directly to the owning database/Rust executor.
            break;
          case 'PROFILE_NAMESPACE_UPDATED': {
            // Change-feed wake: pull (cursor, end] and converge bindings.
            const wakeEnd = (m.data as { end?: unknown } | undefined)?.end;
            if (typeof wakeEnd === 'number' && Number.isSafeInteger(wakeEnd))
              void this.webdb
                .pullProfileNamespaceChanges(wakeEnd)
                .catch((error) =>
                  console.warn(
                    '[profile-namespace] wake sync failed; next wake retries',
                    error,
                  ),
                );
            break;
          }
          case 'THREAD_FEED_UPDATED':
            // Worker/Rust owns the feed. The renderer only observes its local completion.
            break;
          case 'PROFILE_AVAILABLE':
          case 'PROFILE_UNAVAILABLE':
            void this.webdb
              .applyProfileEvent(m.event, m.data)
              .catch((error) =>
                console.warn('[profile] local materialization failed', error),
              );
            break;
          // ── Tauri only: Rust emits the thread-alias side effect separately
          // from the thread-feed states; the renderer applies it inline. ──
          case 'THREAD_ALIAS_APPLIED': {
            const data = m.data as ThreadAliasApplied & { userId: number };
            if (
              data?.userId > 0 &&
              data.userId === this.userService.sessionUserId()
            )
              this.applyThreadAlias(data);
            break;
          }
        }
      });
    // Reconnect refresh is HELLO-driven now: the SSE reconnect re-pushes HELLO → onHello re-runs
    // (cache-paint + state-feed replay). No separate reconnect→boot wiring needed.

    // Identity hydration can make the self coordinates available after cache paint.
    // Later login admission requires a new app; this effect never reactivates one.
    effect(() => {
      if (this.appData.signal.aborted) return;
      if (this.userService.sessionProfile())
        for (const threadId of this.threadStates.keys())
          void this.projectThreadAttention(threadId);
    });
    if (this.appData.signal.aborted) stop();
  }

  /** Both query results and local worker wakes refresh the selected immutable
   * snapshot. The request routes through the shared profile demand machinery
   * (dedup + READY cache), so the row's name and the row's label/avatar
   * components resolve through one entry: an active conversation authorizes a
   * remote refresh, a severed one reads caches only. An authorized demand that
   * comes back PENDING simply stays subscribed until its wake delivers. */
  private async resolveThreadProfile(item: ConversationItem): Promise<void> {
    const reference = threadProfileReference(item);
    if (this.appData.signal.aborted || reference.profileRev < 1) return;
    const demand = homeProfileDemand(
      reference.account,
      reference.namespaceId,
      reference.profileRev,
    );
    const request: ProfileRequest =
      item.conversationState === 'ACTIVE'
        ? demand
        : unevidencedProfileDemand(demand);
    try {
      const profile = await firstValueFrom(
        this.profiles.resolve(request).pipe(takeUntil(this.runtimeEnded)),
      );
      if (this.appData.signal.aborted) return;
      this._items.update((items) =>
        items.map((current) => {
          if (
            threadProfileKey(threadProfileReference(current)) !==
            JSON.stringify([
              profile.publisherNamespaceId,
              profile.account,
              profile.rev,
            ])
          )
            return current;
          return {
            ...current,
            profile: {
              name: profile.name,
              bio: profile.bio,
              avatarDigest: profile.avatarDigest,
            },
          };
        }),
      );
    } catch (error) {
      if (!this.appData.signal.aborted)
        console.warn('[profile] thread resolution failed', error);
    }
  }

  private readonly onAppVisibilityChange = (): void => {
    if (this.appData.signal.aborted || document.visibilityState !== 'visible')
      return;
    // The native stream can have been stopped in the background. Reconnect for a fresh
    // HELLO/feed ceiling before a resident or newly opened message pane resumes reads.
    this.ws.refreshHandshake();
  };

  /** Clear renderer data only when its one-shot app runtime ends. */
  private clearProjection(): void {
    for (const threadId of this.threadStates.keys())
      this.projections.invalidate(threadId);
    this.threadStates.clear();
    this.confirmedAliases.clear();
    this.pendingNotifications.clear();
    this._items.set([]);
    this._status.set('LOADING');
    this._navigationReady.set(false);
    this._error.set('');
    this._activeThreadId.set(undefined);
    this.lastSeenSeq.clear();
    this.serverLastReadSeq.clear();
    this.localStableReadSeq.clear();
    this.pendingUnknownContentHeads.clear();
    this.threadFeedCursor = undefined;
  }

  // ── boot: account thread initialization + HELLO delta replay ──────────────────────────────

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
  async load(_opts?: { force?: boolean }): Promise<void> {
    await this.paintFromCache();
  }

  /** Re-run the authoritative feed handshake after a mutation that creates a new thread. */
  async refreshAfterMutation(): Promise<void> {
    this.appData.assertActive();
    this.ws.disconnect();
    this.ws.connect();
  }

  /** Read the IDB `threads` store + apply it instantly (the eager pre-HELLO paint). Bails if the list is
   *  already populated so a late cache read cannot clobber a fresher HELLO delta that landed during it. */
  private async paintFromCache(): Promise<void> {
    try {
      if (this.appData.signal.aborted) return;
      if (this._items().length > 0) return; // already populated — don't clobber a fresher state
      const cached = await this.readCachedThreads();
      if (this.appData.signal.aborted) return;
      if (cached.length > 0 && this._items().length === 0) {
        for (const item of cached) {
          if (typeof item.lastReadSeq === 'number')
            this.localStableReadSeq.set(item.threadId, item.lastReadSeq);
        }
        this.applyItems(cached); // flips READY
        const states = await this.webdb.getThreadStates();
        if (this.appData.signal.aborted) return;
        await this.applyThreadStates(states, false);
        if (this.appData.signal.aborted) return;
        this._navigationReady.set(true);
      } else if (this._items().length === 0 && this._status() !== 'READY') {
        this._status.set('LOADING'); // cold start, no cache → await HELLO's delta
      }
    } catch (error) {
      // Cache paint is optional; HELLO owns initialization and authoritative recovery.
      if (!this.appData.signal.aborted)
        console.warn('[cache-paint] cached thread read failed', error);
    }
  }

  /** Select/clear the active thread without changing which panes remain open. */
  setActiveThread(threadId: number | undefined): void {
    if (this.appData.signal.aborted) return;
    this._activeThreadId.set(threadId);
    this.activePresentation.reportActiveThread(threadId);
  }

  /** Resolve the ConversationItem for a thread the caller knows exists, waiting for a reload if it is not
   *  yet in the list (up to `timeoutMs`). Used by the join hero transition. */
  async ensureThread(
    threadId: number,
    timeoutMs = 2000,
  ): Promise<ConversationItem | undefined> {
    const found = this._items().find((t) => t.threadId === threadId);
    if (found) return found;
    if (this._status() === 'READY') this.load();
    const deadline = Date.now() + timeoutMs;
    while (!this.appData.signal.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const it = this._items().find((t) => t.threadId === threadId);
      if (it) return it;
    }
    return undefined;
  }

  // ── list mutations (each writes through to IDB + emits a fine-grained signal update) ───────

  /** Patch per-user thread metadata (mute/pin/block) on a row. Pin state/time changes
   *  reposition only that row; display-state changes stay at the row's current position.
   *  Only defined fields are applied. Used for optimistic UI patches
   *  (multi-device) and (via the facade) from local optimistic actions (mute/pin toggle, block/unblock). */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      blocked?: boolean;
      conversationState?: 'ACTIVE' | 'READ_ONLY';
    },
  ): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === threadId);
      if (idx === -1) return list;
      changed = { ...list[idx], ...patch };
      if (
        changed.pinned !== list[idx].pinned ||
        changed.pinnedAt !== list[idx].pinnedAt
      )
        return mergeThreadItems(list, [changed]);
      const next = list.slice();
      next[idx] = changed;
      return next;
    });
    if (changed) void this.persistThreadPatch(threadId, patch);
  }

  /** Successful HTTP acknowledgements refresh names immediately; the backend
   *  fan-out pushes a THREAD_FEED_UPDATED wake whose committed states arrive
   *  via thread-feed-committed / LOCAL_THREAD_FEED_COMMITTED. */
  confirmThreadAlias(result: ThreadAliasApplied): void {
    this.publishThreadAlias(result);
  }

  private publishThreadAlias(result: ThreadAliasApplied): void {
    this.ws.eventSubject.next({
      event: 'THREAD_ALIAS_APPLIED',
      status: 0,
      message: 'thread alias applied',
      data: {
        userId: this.userService.sessionUserId(),
        threadId: result.threadId,
        threadFeedId: result.threadFeedId,
        alias: result.alias,
      },
    });
  }

  private applyThreadAlias(result: ThreadAliasApplied): void {
    if (
      !Number.isSafeInteger(result.threadId) ||
      result.threadId < 1 ||
      !Number.isSafeInteger(result.threadFeedId) ||
      result.threadFeedId < 1 ||
      (result.alias !== null && typeof result.alias !== 'string')
    )
      return;
    const previous = this.confirmedAliases.get(result.threadId);
    if (previous && previous.threadFeedId >= result.threadFeedId) return;
    this.confirmedAliases.set(result.threadId, result);
    this._items.update((items) =>
      items.map((item) =>
        item.threadId === result.threadId
          ? { ...item, alias: result.alias }
          : item,
      ),
    );
  }

  private withConfirmedAlias(item: ConversationItem): ConversationItem {
    const confirmed = this.confirmedAliases.get(item.threadId);
    return confirmed ? { ...item, alias: confirmed.alias } : item;
  }

  /** Apply an optimistic local group metadata patch. Durable replacement arrives via state delta. */
  applyGroupUpdate(threadId: number, patch: GroupThreadPatch): void {
    let changed: GroupConversationItem | undefined;
    this._items.update((list) =>
      list.map((t) => {
        if (t.threadId !== threadId || t.type !== 'GROUP') return t;
        changed = { ...t };
        if (patch.role !== undefined) changed.role = patch.role;
        if (patch.profile) changed.profile = { ...t.profile, ...patch.profile };
        if (patch.meta) changed.meta = { ...t.meta, ...patch.meta };
        return changed;
      }),
    );
  }

  /** Drop a thread after an explicit delete-data action. This is the SOLE chokepoint for thread removal, so the full local
   *  cleanup lives here: drop the list row + open-thread pointer, delete the `threads`-store record, clear the
   *  stale {@link lastSeenSeq} residue, AND purge the cached message bodies via the message repo. An explicit
   *  delete-data choice must survive even when the backend later reuses the stable relationship thread.
   *  Both IDB writes are best-effort + fire-and-forget. */
  async removeThread(threadId: number): Promise<void> {
    this._items.update((list) => list.filter((t) => t.threadId !== threadId));
    if (this._activeThreadId() === threadId) {
      this._activeThreadId.set(undefined);
      this.activePresentation.reportActiveThread(undefined);
    }
    this.lastSeenSeq.delete(threadId);
    this.serverLastReadSeq.delete(threadId);
    this.localStableReadSeq.delete(threadId);
    this.threadStates.delete(threadId);
    this.projections.invalidate(threadId);
    this.pendingNotifications.delete(threadId);
    this.pendingUnknownContentHeads.delete(threadId);
    await Promise.all([
      this.deleteThreadFromDb(threadId),
      this.messageRepo.deleteByThread(threadId),
    ]);
  }

  /** Record the locally-dwelled cursor independently from the server-confirmed cursor. */
  noteLocalStableRead(threadId: number, seq: number): void {
    const prev = this.localStableReadSeq.get(threadId);
    if (prev === undefined || seq > prev)
      this.localStableReadSeq.set(threadId, seq);
  }

  /** Persist viewport progress and rebase the optimistic badge from the raw snapshot. */
  commitLocalRead(threadId: number, seq: number): boolean {
    const found = this._items().find((t) => t.threadId === threadId);
    if (!found) return false;
    const current = Math.max(
      found.lastReadSeq ?? 0,
      this.localStableReadSeq.get(threadId) ?? 0,
    );
    if (seq <= current) return false;
    const currentState = this.threadStates.get(threadId);
    if (!currentState) return false;
    this.noteLocalStableRead(threadId, seq);
    this.threadStates.set(
      threadId,
      advanceLocalAttentionRead(currentState, seq),
    );
    void this.webdb
      .advanceThreadRead(threadId, seq)
      .then((state) => {
        if (this.appData.signal.aborted) return;
        return this.applyThreadStates([state], false);
      })
      .catch((error) => {
        if (!this.appData.signal.aborted)
          console.warn('[thread-feed] local read persistence failed', error);
      });
    return true;
  }

  private applyItems(items: ConversationItem[]): void {
    const currentById = new Map(
      this._items().map((item) => [item.threadId, item]),
    );
    const incoming = items.map((item) => {
      const current = currentById.get(item.threadId);
      // Hydration may seed attention once. Later cache reads must not bypass
      // the per-thread publication lane with an older persisted projection.
      return this.withConfirmedAlias(
        current && this.threadStates.has(item.threadId)
          ? {
              ...item,
              lastReadSeq: current.lastReadSeq,
              unreadCount: current.unreadCount,
              mentionUnread: current.mentionUnread,
              lastMessagePreview: current.lastMessagePreview,
              lastMessageAt: current.lastMessageAt,
              lastMessageSenderAccount: current.lastMessageSenderAccount,
              lastMessageSenderNamespaceId:
                current.lastMessageSenderNamespaceId,
            }
          : item,
      );
    });
    // Cache re-reads are full snapshots, not feed pages. Extract their ordering delta first.
    const byId = new Map(incoming.map((item) => [item.threadId, item]));
    const retained = this._items()
      .filter((item) => byId.has(item.threadId))
      .map((item) => {
        const next = byId.get(item.threadId)!;
        return compareThreadItems(item, next) === 0 ? next : item;
      });
    const delta = incoming.filter((item) => {
      const current = currentById.get(item.threadId);
      return !current || compareThreadItems(current, item) !== 0;
    });
    const ordered = mergeThreadItems(retained, delta);
    this._items.set(ordered);
    for (const item of ordered) {
      void this.resolveThreadProfile(item);
      if (this.threadStates.has(item.threadId))
        void this.projectThreadAttention(item.threadId);
    }
    this._status.set('READY');
  }

  /** Apply content heads from an already committed unified thread snapshot. */
  private applyThreadContentHead(
    head: ThreadContentHead,
    emitLiveSignal: boolean,
  ): void {
    this.advanceThreadSeq(head.threadId, head.messageEndSeq, emitLiveSignal);
    if (!this.applyContentHeadToKnownThread(head))
      this.pendingUnknownContentHeads.set(head.threadId, head);
  }

  /** Apply the HWM projection to an existing row without deriving list presentation. */
  private applyContentHeadToKnownThread(head: ThreadContentHead): boolean {
    let existed = false;
    this._items.update((list) => {
      const idx = list.findIndex((thread) => thread.threadId === head.threadId);
      if (idx === -1) return list;
      existed = true;
      const item = list[idx];
      const changed: ConversationItem = {
        ...item,
        messageEndSeq: head.messageEndSeq,
      };
      const next = list.slice();
      next[idx] = changed;
      return next;
    });
    return existed;
  }

  private advanceThreadSeq(
    threadId: number,
    seq: number,
    emitLiveSignal = true,
  ): boolean {
    const prev = this.lastSeenSeq.get(threadId);
    if (prev !== undefined && seq <= prev) return false;
    this.lastSeenSeq.set(threadId, seq);
    if (emitLiveSignal) this._threadSeq.next({ threadId, seq });
    return true;
  }

  private threadFeedCursor: number | undefined;

  /** HELLO (the SSE connect handshake) — the network-refresh half of boot (the cache-paint is owned by
   *  {@link load}, which eager-paints from the IDB cache before HELLO lands). Carries the caller's userId
   *  (establishes the session — opens the IDB on cold start, idempotent on warm start) and the current
   *  state-feed end. On each connect this establishes the session and drains the state feed from the one
   *  persisted cursor. Fire-and-forget from the SSE switch. */
  private async onHello(d: HelloPayload | undefined): Promise<void> {
    if (
      !d ||
      !Number.isSafeInteger(d.userId) ||
      d.userId <= 0 ||
      !Number.isSafeInteger(d.sessionId) ||
      d.sessionId <= 0 ||
      !Number.isSafeInteger(d.stateFeedEndId) ||
      d.stateFeedEndId < 0 ||
      !Number.isSafeInteger(d.threadFeedEndId) ||
      d.threadFeedEndId < 0
    )
      return;
    // 1. Establish the session — opens the per-user IDB on HELLO's userId (cold start: first open; warm
    //    start: already opened by restoreSession's restoreWebdb, idempotent here). The profile fetch is
    //    gated async inside establishSession. The cache-paint is NOT repeated here — load() already eager-
    //    painted from the IDB cache (and on a cold start the cache is empty, so the delta below populates).
    if (this.appData.signal.aborted) return;
    await this.userService.establishSession(
      d.userId,
      d.profileRev ?? 0,
      d.sessionId,
    );
    if (this.appData.signal.aborted) return;
    // Profile-namespace change sync: the HELLO anchor skips the pull when the
    // persisted cursor already matches (fresh caches simply start at 0).
    if (
      d.profileNamespaceChangeEndId === undefined ||
      Number.isSafeInteger(d.profileNamespaceChangeEndId)
    ) {
      void this.webdb
        .pullProfileNamespaceChanges(d.profileNamespaceChangeEndId)
        .catch((error) =>
          console.warn(
            '[profile-namespace] HELLO sync failed; next wake retries',
            error,
          ),
        );
    }
    // HELLO can race the thread-list mount. It awaits the account-level thread-init barrier, but does
    // not provide or own the deletion HWM; reconnects reuse the persisted result.
    if (this.threadFeedCursor === undefined) {
      const cursor = (await this.webdb.readAccountState()).threadFeedCursor;
      if (this.appData.signal.aborted) return;
      this.threadFeedCursor = typeof cursor === 'number' ? cursor : 0;
    }
    const states = await this.webdb.getThreadStates();
    if (this.appData.signal.aborted) return;
    await this.applyThreadStates(states, false);
    if (this.appData.signal.aborted) return;
    const port = await this.webdb.createThreadFeedPort();
    if (this.appData.signal.aborted) {
      port?.close();
      return;
    }
    if (port) this.ws.attachThreadFeed(port, d.userId);
    // HELLO is a memory event. The worker/Rust executor commits the state feed,
    // then reports state-feed-committed; the UI only reads its projection.
    await this.refreshCommittedStateFeed();
    if (this.appData.signal.aborted) return;
    // The HELLO wake reaches the worker/Rust independently. A concurrent completion also
    // delivers thread-feed-committed after the cursor and Group Meta pages commit.
    await this.refreshCommittedThreadFeed();
    if (this.appData.signal.aborted) return;
    this._navigationReady.set(true);
  }

  private async refreshCommittedStateFeed(): Promise<void> {
    const cursor = await this.userService.refreshCommittedStateFeed();
    if (this.appData.signal.aborted || cursor === undefined) return;
    const items = await this.readCachedThreads();
    if (this.appData.signal.aborted) return;
    this.applyItems(items);
  }

  async refreshBackgroundThreadFeed(userId: number): Promise<void> {
    if (userId !== this.userService.sessionUserId()) return;
    await this.refreshCommittedThreadFeed();
  }

  /** Completion wakes never initiate HTTP, including after a partially successful background drain. */
  private async refreshCommittedThreadFeed(): Promise<void> {
    if (this.threadFeedCursor === undefined) return;
    try {
      const changes = await this.webdb.readThreadFeedChanges(
        this.threadFeedCursor,
      );
      if (this.appData.signal.aborted) return;
      const items = await this.webdb.getThreads();
      if (this.appData.signal.aborted) return;
      this.applyItems(items);
      await this.applyThreadStates(changes.states, true);
      if (this.appData.signal.aborted) return;
      this.threadFeedCursor = Math.max(
        this.threadFeedCursor ?? 0,
        changes.cursor,
      );
    } catch (error) {
      if (!this.appData.signal.aborted)
        console.warn('[thread-feed] local completion refresh failed', error);
    }
  }

  private async applyThreadStates(
    states: LocalThreadAttention[],
    emitLive: boolean,
  ): Promise<void> {
    if (this.appData.signal.aborted) return;
    const refreshes: Promise<void>[] = [];
    const knownIds = new Set(this._items().map((item) => item.threadId));
    const missingIds = new Set(
      states
        .filter((state) => !knownIds.has(state.threadId))
        .map((state) => state.threadId),
    );
    let additions: ConversationItem[] = [];
    if (missingIds.size) {
      const cached = await this.webdb.getThreads();
      if (this.appData.signal.aborted) return;
      const stillKnown = new Set(this._items().map((item) => item.threadId));
      additions = cached
        .filter(
          (item) =>
            missingIds.has(item.threadId) && !stillKnown.has(item.threadId),
        )
        .map((item) =>
          this.withConfirmedAlias({
            ...item,
            visible: isThreadListFeedId(item.threadFeedId),
            lastReadSeq: null,
            unreadCount: 0,
            mentionUnread: [],
          }),
        );
    }
    this.applyThreadFeedOrders(
      states.flatMap((state) => {
        const delivered = attentionSnapshot(state);
        if (!delivered) return [];
        const current = this.threadStates.get(state.threadId);
        const merged = current
          ? attentionSnapshot(mergeThreadAttention(current, delivered))
          : delivered;
        return merged ? [merged] : [];
      }),
      additions,
    );
    for (const stored of states) {
      if (this.appData.signal.aborted) return;
      const delivered = attentionSnapshot(stored);
      const notify =
        delivered &&
        threadNotificationChanged(
          attentionSnapshot(this.threadStates.get(stored.threadId)),
          delivered,
        );
      let state = this.threadStates.get(stored.threadId) ?? stored;
      if (delivered) state = mergeThreadAttention(state, delivered);
      const local = Math.max(
        stored.localReadSeq ?? 0,
        this.localStableReadSeq.get(stored.threadId) ?? 0,
      );
      state = advanceLocalAttentionRead(state, local);
      this.threadStates.set(state.threadId, state);
      if (state.localReadSeq !== null)
        this.localStableReadSeq.set(state.threadId, state.localReadSeq);
      const snapshot = attentionSnapshot(state);
      if (snapshot) {
        this.publishThreadAlias(snapshot);
        // The worker has already committed the snapshot. Keep permission UI
        // aligned with its role without creating another durable writer.
        this.applyThreadRole(snapshot.threadId, snapshot.role);
        this.applyGroupProjectionHeads(snapshot);
        this.serverLastReadSeq.set(state.threadId, snapshot.lastReadSeq);
        this.messageRepo.applyThreadContentHead(
          state.threadId,
          snapshot.messageEndSeq,
          emitLive,
          snapshot.author,
        );
        this.applyThreadContentHead(snapshot, emitLive);
        const pending = this.pendingUnknownContentHeads.get(state.threadId);
        if (pending) {
          this.pendingUnknownContentHeads.delete(state.threadId);
          this.applyContentHeadToKnownThread(pending);
        }
      }
      if (emitLive && notify) this.pendingNotifications.add(state.threadId);
      refreshes.push(this.projectThreadAttention(state.threadId));
    }
    await Promise.all(refreshes);
  }

  /** All local attention reads share one lane per thread. The scheduler owns
   * publication after a clean pass, including slot-only and profile wakes. */
  private projectThreadAttention(threadId: number): Promise<void> {
    return this.projections.request(threadId);
  }

  private applyGroupMetaPatches(patches: GroupMetaCommitPatch[]): void {
    if (!patches.length) return;
    const byThread = new Map(
      patches.map((patch) => [patch.threadId, patch] as const),
    );
    this._items.update((items) =>
      items.map((item) => {
        if (item.type !== 'GROUP') return item;
        const patch = byThread.get(item.threadId);
        if (!patch) return item;
        return {
          ...item,
          meta: {
            ...item.meta,
            memberCount: patch.memberCount,
            groupMetaFeedId: patch.groupMetaFeedId,
            announcementFeedId: patch.announcementFeedId,
            announcementText: patch.announcementText,
            announcementCreatedAt: patch.announcementCreatedAt,
            announcementOriginCreatedAt: patch.announcementOriginCreatedAt,
            recoveryThrough: patch.groupMetaRecoveryThrough,
          },
        };
      }),
    );
  }

  private applyThreadAttentionProjection(
    projection: ThreadAttentionProjection,
  ): ConversationItem | undefined {
    let projected: ConversationItem | undefined;
    this._items.update((items) =>
      items.map((item) => {
        if (item.threadId !== projection.threadId) return item;
        const changed = {
          ...item,
          lastReadSeq: projection.lastReadSeq,
          // Feed-owned heads are applied synchronously by applyThreadStates,
          // never by a later attention read (which may follow a local acknowledgement).
          unreadCount: projection.unreadCount,
          mentionUnread: projection.mentionUnread,
          lastMessagePreview: projection.lastMessagePreview,
          lastMessageAt: projection.lastMessageAt,
          lastMessageSenderAccount: projection.lastMessageSenderAccount,
          lastMessageSenderNamespaceId: projection.lastMessageSenderNamespaceId,
        };
        projected = changed;
        return changed;
      }),
    );
    return projected;
  }

  private applyThreadRole(
    threadId: number,
    role: ThreadFeedSnapshot['role'],
  ): void {
    this._items.update((items) =>
      items.map((item) =>
        item.threadId === threadId && item.role !== role
          ? { ...item, role }
          : item,
      ),
    );
  }

  private applyThreadFeedOrders(
    snapshots: Pick<
      ThreadFeedSnapshot,
      'threadId' | 'threadFeedId' | 'profileRev'
    >[],
    additions: ConversationItem[] = [],
  ): void {
    const changed = new Map(additions.map((item) => [item.threadId, item]));
    const currentById = new Map(
      this._items().map((item) => [item.threadId, item]),
    );
    for (const { threadId, threadFeedId, profileRev } of snapshots) {
      if (!isThreadListFeedId(threadFeedId))
        throw new Error(`Invalid threadFeedId for thread ${threadId}`);
      const current = changed.get(threadId) ?? currentById.get(threadId);
      if (!current) continue;
      if (
        current.visible !== false &&
        current.threadFeedId === threadFeedId &&
        current.profileRev === profileRev
      )
        continue;
      // Snapshot freshness selects the revision; its numeric magnitude never ranks it.
      changed.set(threadId, {
        ...current,
        visible: true,
        threadFeedId,
        profileRev,
        ...(current.profileRev !== profileRev
          ? { profile: { name: '', bio: '', avatarDigest: null } }
          : {}),
      });
    }
    if (!changed.size) return;
    this._items.update((items) =>
      mergeThreadItems(items, [...changed.values()]),
    );
    this._status.set('READY');
    for (const item of changed.values()) void this.resolveThreadProfile(item);
  }

  private applyGroupProjectionHeads(snapshot: ThreadFeedSnapshot): void {
    let changed: ConversationItem | undefined;
    this._items.update((items) =>
      items.map((item) => {
        if (
          item.threadId !== snapshot.threadId ||
          (item.joinRequestEndFeedId === snapshot.joinRequestEndFeedId &&
            item.joinRequestReadFeedId === snapshot.joinRequestReadFeedId &&
            item.groupInviteEndFeedId === snapshot.groupInviteEndFeedId &&
            (item.announcementReadFeedId ?? 0) >=
              (snapshot.announcementReadFeedId ?? 0))
        )
          return item;
        changed = {
          ...item,
          joinRequestEndFeedId: snapshot.joinRequestEndFeedId,
          joinRequestReadFeedId: snapshot.joinRequestReadFeedId,
          groupInviteEndFeedId: snapshot.groupInviteEndFeedId,
          announcementReadFeedId: Math.max(
            item.announcementReadFeedId ?? 0,
            snapshot.announcementReadFeedId ?? 0,
          ),
        };
        return changed;
      }),
    );
  }

  /** A successful display acknowledgement is monotone even before the next
   * server thread-feed snapshot arrives on this device. */
  markAnnouncementReadLocally(threadId: number, feedId: number): void {
    if (!Number.isSafeInteger(feedId) || feedId < 1) return;
    let changed: ConversationItem | undefined;
    this._items.update((items) =>
      items.map((item) => {
        if (
          item.threadId !== threadId ||
          item.type !== 'GROUP' ||
          (item.announcementReadFeedId ?? 0) >= feedId
        )
          return item;
        changed = { ...item, announcementReadFeedId: feedId };
        return changed;
      }),
    );
    if (changed)
      void this.persistThreadPatch(threadId, {
        announcementReadFeedId: feedId,
      });
  }

  markJoinRequestsReadLocally(
    threadId: number,
    joinRequestReadFeedId: number,
  ): void {
    let changed: ConversationItem | undefined;
    this._items.update((items) =>
      items.map((item) => {
        if (
          item.threadId !== threadId ||
          item.joinRequestReadFeedId === undefined ||
          item.joinRequestEndFeedId === undefined ||
          item.joinRequestReadFeedId < 0 ||
          item.joinRequestReadFeedId >= item.joinRequestEndFeedId
        )
          return item;
        changed = {
          ...item,
          joinRequestReadFeedId: Math.min(
            item.joinRequestEndFeedId,
            Math.max(item.joinRequestReadFeedId, joinRequestReadFeedId),
          ),
        };
        return changed;
      }),
    );
    if (changed)
      void this.persistThreadPatch(threadId, { joinRequestReadFeedId });
  }

  // ── IDB persistence helpers (best-effort; IDB unavailable → graceful no-op) ────────────────

  /** Read cached threads and restore the authoritative account-scoped feed order. */
  private async readCachedThreads(): Promise<ConversationItem[]> {
    const all = await this.webdb.getThreads();
    if (this.appData.signal.aborted) return [];
    const storedStates = await this.webdb.getThreadStates();
    if (this.appData.signal.aborted) return [];
    const states = new Map(
      storedStates
        .filter((state) => state.threadFeedId !== null)
        .map((state) => [state.threadId, state.threadFeedId!]),
    );
    return all
      .map((item) => ({
        ...item,
        threadFeedId: states.get(item.threadId) ?? item.threadFeedId,
      }))
      .filter((item) => isThreadListFeedId(item.threadFeedId));
  }

  /** Write-through a single changed thread (idempotent put by threadId). */
  private async persistThreadPatch(
    threadId: number,
    patch: LocalThreadPatch,
  ): Promise<void> {
    try {
      await this.webdb.patchThread(threadId, patch);
    } catch {
      /* best-effort */
    }
  }

  private async deleteThreadFromDb(threadId: number): Promise<void> {
    try {
      await this.webdb.deleteThread(threadId);
    } catch {
      /* best-effort */
    }
  }
}

// ── SSE payload shapes (the subset of fields each handler reads) ─────────────────────────────

/** HELLO (SSE connect handshake) payload — pushed once per connect, the sole boot-critical state the
 *  client cannot derive locally: the caller's userId (opens the per-user IDB), the current state-feed end,
 *  and the self-profile version (which gates the /user/my-profile fetch). */
export interface HelloPayload {
  userId: number;
  sessionId: number;
  stateFeedEndId: number;
  threadFeedEndId: number;
  profileRev?: number;
  /** Change-feed head; a mismatch with the persisted cursor triggers one
   *  profile-namespace sync round (the profileRev skip pattern). */
  profileNamespaceChangeEndId?: number;
}

function isThreadListFeedId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function threadProfileReference(item: ConversationItem) {
  return {
    account: item.account,
    namespaceId: item.publisherNamespaceId,
    profileRev: item.profileRev,
  };
}

function threadProfileKey(
  profile: ReturnType<typeof threadProfileReference>,
): string {
  return JSON.stringify([
    profile.namespaceId,
    profile.account,
    profile.profileRev,
  ]);
}
