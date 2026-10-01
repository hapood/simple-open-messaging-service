import {
  Injectable,
  inject,
  signal,
  effect,
  computed,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, Subject, Subscription } from 'rxjs';
import { TrailingSingleFlight } from '../../../../shared/trailing-single-flight';
import { WebdbService } from './webdb.service';
import { preserveThreadProfile } from './thread-profile-projection';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import {
  ConversationItem,
  GroupConversationItem,
  messagePreviewSenderKey,
  localSubjectIdentity,
  P2PConversationItem,
  User,
} from './model';
import { MemberProfileRepository } from './member-profile-store.service';
import { FederationNamespaceService } from './federation-namespace.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { isAndroidNative } from './runtime';
import type { ThreadNotificationUpdate } from './thread-notification';

import {
  advanceLocalAttentionRead,
  attentionCountRange,
  attentionSnapshot,
  mergeThreadAttention,
  threadNotificationChanged,
  projectThreadAttention,
  type LocalThreadAttention,
  type ThreadFeedSnapshot,
  type ThreadAliasApplied,
} from '../../../../shared/thread-attention';

type ThreadContentHead = Pick<
  ThreadFeedSnapshot,
  'threadId' | 'messageEndSeq' | 'tombstoneEndSeq'
>;

/** Load status as a const object so it can be used as a VALUE in templates and as a TYPE. */
export const ConversationLoadStatus = {
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
export type ConversationLoadStatus =
  (typeof ConversationLoadStatus)[keyof typeof ConversationLoadStatus];

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
  private readonly userService = inject(UserService);
  private readonly ws = inject(WebsocketService);
  private readonly messageRepo = inject(MessageRepository);
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly namespaces = inject(FederationNamespaceService);

  private readonly _items = signal<ConversationItem[]>([]);
  private readonly threadStates = new Map<number, LocalThreadAttention>();
  private readonly projectionTokens = new Map<number, object>();
  private sessionEpoch = 0;
  readonly items = computed(() =>
    this._items().filter(
      (item): item is ConversationItem & { threadFeedId: number } =>
        item.visible !== false && isThreadListFeedId(item.threadFeedId),
    ),
  );

  private readonly _status = signal<ConversationLoadStatus>('LOADING');
  readonly status = this._status.asReadonly();

  private readonly _error = signal('');
  readonly error = this._error.asReadonly();

  /** The thread currently being viewed — drives the active-row highlight. Set by the UI layer
   *  ({@link setOpenThread} on open/close); in-memory only (not persisted, not a list field). */
  private readonly _openThreadId = signal<number | undefined>(undefined);
  readonly openThreadId = this._openThreadId.asReadonly();

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

  /** Account-scoped first thread initialization barrier. It is independent of HELLO payload state;
   * both the list mount and a fast-arriving HELLO await this same single-flight operation. */

  private readonly confirmedAliases = new Map<number, ThreadAliasApplied>();

  private readonly sseSub: Subscription;

  constructor() {
    if (isAndroidNative()) {
      document.addEventListener('visibilitychange', this.onAppVisibilityChange);
      inject(DestroyRef).onDestroy(() =>
        document.removeEventListener(
          'visibilitychange',
          this.onAppVisibilityChange,
        ),
      );
    }
    this.webdb.profileWake$.pipe(takeUntilDestroyed()).subscribe((wake) => {
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
      .pipe(takeUntilDestroyed())
      .subscribe((threadId) => {
        void this.projectThread(threadId);
      });
    // Cached rows can be painted before HELLO, while sessionUserId is already null. Logout must
    // reset them explicitly rather than relying on an identity signal transition.
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => this.reset());
    inject(SessionLifecycleService)
      .invalidated$.pipe(takeUntilDestroyed())
      .subscribe(() => this.sessionEpoch++);
    this.webdb.workerFailed$.pipe(takeUntilDestroyed()).subscribe(() => {
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
      .pipe(takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        void this.applyThreadStates(data.states, true);
      });
    this.webdb.groupMetaCommitted$
      .pipe(takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        this.memberProfiles.notifyChanged(
          data.threadIds.filter((threadId) =>
            this._items().some(
              (thread) => thread.type === 'GROUP' && thread.threadId === threadId,
            ),
          ),
        );
      });
    this.webdb.stateFeedCommitted$
      .pipe(takeUntilDestroyed())
      .subscribe((data) => {
        if (data.userId !== this.userService.sessionUserId()) return;
        void this.refreshCommittedStateFeed();
      });
    // ── thread-list DATA SSE events (the DB layer is the sole consumer) ──
    this.sseSub = this.ws.eventSubject.subscribe((m) => {
      switch (m.event) {
        case 'HELLO':
          void this.onHello(m.data as HelloPayload | undefined).catch(
            async (error) => {
              console.warn(
                '[cache-recovery] session cache initialization failed',
                error,
              );
              await this.userService.requestCacheRebuild();
            },
          );
          break;
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

    // Session-end reset: when the session ends (sessionUserId → null, i.e. clearSession/logout), drop
    // the in-memory list so a second account logging into the same live SPA cannot inherit this user's
    // cached list. The IDB partition is handled by WebdbService (closed on the same signal); this covers
    // the in-memory layer. Reset flips status back to LOADING so the next login's ThreadListComponent
    // re-enters the loading state until the fresh HELLO lands.
    effect(() => {
      if (this.userService.sessionProfile())
        for (const threadId of this.threadStates.keys())
          void this.projectThread(threadId);
    });
    effect(() => {
      const id = this.userService.sessionUserId();
      if (id === null) this.reset();
    });
  }

  /** Both query results and local worker wakes refresh the selected immutable snapshot. */
  private async resolveThreadProfile(item: ConversationItem): Promise<void> {
    const reference = threadProfileReference(item);
    if (reference.profileRev < 1) return;
    const epoch = this.sessionEpoch;
    try {
      const result = await this.webdb.resolveProfileDemand({
        publisherNamespaceId: reference.namespaceId,
        lookup: 'ACCOUNT_PROFILE',
        target: {
          profileNamespaceId: reference.namespaceId,
          account: reference.account,
          rev: reference.profileRev,
        },
      });
      if (epoch !== this.sessionEpoch || result.status === 'PENDING') return;
      const profile = result.profile;
      this._items.update((items) =>
        items.map((current) => {
          if (
            threadProfileKey(threadProfileReference(current)) !==
            JSON.stringify([
              profile.profileNamespaceId,
              profile.account,
              profile.profileRev,
            ])
          )
            return current;
          return current.type === 'GROUP'
            ? {
                ...current,
                group: {
                  ...current.group,
                  name: profile.name,
                  avatar: '',
                  description: profile.bio,
                },
              }
            : {
                ...current,
                peerUser: {
                  ...current.peerUser,
                  name: profile.name,
                  avatar: '',
                  bio: profile.bio,
                },
              };
        }),
      );
    } catch (error) {
      if (epoch === this.sessionEpoch)
        console.warn('[profile] thread resolution failed', error);
    }
  }

  /**
   * Drop ALL in-memory session state (logout / account switch). The IDB store is closed + deleted by
   * WebdbService (on the same sessionUserId signal); this resets the in-memory caches so they cannot leak
   * across users. Resets {@link _status} to LOADING so the freshly-mounted list re-loads on the next HELLO.
   */
  private readonly onAppVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    // The native stream can have been stopped in the background. Reconnect for a fresh
    // HELLO/feed ceiling before a resident or newly opened message pane resumes reads.
    this.ws.refreshHandshake();
  };

  private reset(): void {
    this.sessionEpoch++;
    this.threadStates.clear();
    this.confirmedAliases.clear();
    this.projectionTokens.clear();
    this._items.set([]);
    this._status.set('LOADING');
    this._error.set('');
    this._openThreadId.set(undefined);
    this.lastSeenSeq.clear();
    this.serverLastReadSeq.clear();
    this.localStableReadSeq.clear();
    this.pendingUnknownContentHeads.clear();
    this.threadFeedCursor = undefined;
    // Clear the native durable copy too (logout / account switch) so a different user does not inherit it.
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
    this.ws.disconnect();
    this.ws.connect();
  }

  /** Read the IDB `threads` store + apply it instantly (the eager pre-HELLO paint). Bails if the list is
   *  already populated so a late cache read cannot clobber a fresher HELLO delta that landed during it. */
  private async paintFromCache(): Promise<void> {
    const epoch = this.sessionEpoch;
    try {
      const namespaces = await this.webdb.getNamespaces();
      if (epoch !== this.sessionEpoch) return;
      this.namespaces.replace(namespaces);
      if (this._items().length > 0) return; // already populated — don't clobber a fresher state
      const cached = await this.readCachedThreads();
      if (epoch !== this.sessionEpoch) return;
      if (cached.length > 0 && this._items().length === 0) {
        for (const item of cached) {
          if (typeof item.lastReadSeq === 'number')
            this.localStableReadSeq.set(item.threadId, item.lastReadSeq);
        }
        this.applyItems(cached); // flips READY
        const states = await this.webdb.getThreadStates();
        if (epoch !== this.sessionEpoch) return;
        await this.applyThreadStates(states, false);
      } else if (this._items().length === 0 && this._status() !== 'READY') {
        this._status.set('LOADING'); // cold start, no cache → await HELLO's delta
      }
    } catch (error) {
      // Cache paint is optional; HELLO owns initialization and authoritative recovery.
      console.warn('[cache-paint] cached thread read failed', error);
      if (epoch === this.sessionEpoch)
        await this.userService.requestCacheRebuild();
    }
  }

  /** Set/clear the open thread (UI layer drives this on open/close; used for unread suppression). */
  async setOpenThread(threadId: number | undefined): Promise<void> {
    this._openThreadId.set(threadId);
    if (threadId === undefined) {
      // Stop signal: the worker finishes the current page and commits it,
      // then the guard prevents the next page.
      await this.webdb.drainThreadMisc(null, null, null);
      return;
    }
    const snapshot = attentionSnapshot(this.threadStates.get(threadId));
    const groupMetaEndId = snapshot?.groupMetaFeedEndId ?? '0';
    const tombstoneEndSeq = snapshot?.tombstoneEndSeq ?? 0;
    // Open the thread and fire both drains concurrently in one worker
    // message. The worker reports committed tombstone pages via
    // tombstoneCommitted$ → deletedSignal$ / slotsChanged.
    await this.webdb.drainThreadMisc(
      threadId,
      groupMetaEndId,
      tombstoneEndSeq,
    );
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
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const it = this._items().find((t) => t.threadId === threadId);
      if (it) return it;
    }
    return undefined;
  }

  // ── list mutations (each writes through to IDB + emits a fine-grained signal update) ───────

  /** Patch per-user thread metadata (mute/pin/block) on a row. Only pin changes re-sort the
   *  list; display-state changes stay at the row's current position.
   *  Only defined fields are applied. Used for optimistic UI patches
   *  (multi-device) and (via the facade) from local optimistic actions (mute/pin toggle, block/unblock). */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      blocked?: boolean;
      friendshipActive?: boolean;
      conversationState?: 'ACTIVE' | 'READ_ONLY';
    },
  ): void {
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === threadId);
      if (idx === -1) return list;
      const next = list.slice();
      changed = { ...next[idx], ...patch };
      next[idx] = changed;
      if ('pinned' in patch && patch.pinned !== list[idx].pinned)
        return sortThreadItems(next);
      return next;
    });
    if (changed) void this.persistThread(changed);
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

  markAuthorityNamespaceInactive(threadId: number): void {
    const source = this._items().find((thread) => thread.threadId === threadId);
    if (!source || source.authorityNamespaceId === 0) return;
    const domain =
      source.type === 'P2P' ? source.peerUser.domain : source.group.domain;
    const namespaceId = source.authorityNamespaceId;
    this.namespaces.archive(domain, namespaceId);
    void this.webdb.archiveNamespace(domain, namespaceId);
  }

  /** Replace a P2P item's peerUser (avatar/name/bio) after a federated profile sync. No-op for groups /
   *  absent items. (Via the facade from peer-profile / chat-open.) */
  updatePeerUser(threadId: number, user: User): void {
    user = localSubjectIdentity(user);
    let changed: P2PConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find(
        (t) => t.threadId === threadId && t.type === 'P2P',
      );
      if (
        !found ||
        found.type !== 'P2P' ||
        found.peerProfileMessageSeq != null ||
        user.profileRev !== found.profileRev ||
        user.account !== found.peerUser.account ||
        user.domain !== found.peerUser.domain ||
        user.namespaceId !== found.peerUser.namespaceId
      )
        return list;
      const { id: _localId, profileRev: _profileRev, ...peerUser } = user;
      changed = { ...found, peerUser };
      return list.map((t) =>
        t.threadId === threadId && t.type === 'P2P' ? changed! : t,
      );
    });
    if (changed) {
      void this.persistThread(changed);
    }
  }

  /** Apply an optimistic local group metadata patch. Durable replacement arrives via state delta. */
  applyGroupUpdate(
    threadId: number,
    patch: {
      name?: string;
      description?: string;
      avatar?: string;
      dissolvedAt?: number | null;
      memberCount?: number;
      groupMetaFeedId?: string;
      profileRev?: number;
      role?: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
    },
  ): void {
    let changed: GroupConversationItem | undefined;
    this._items.update((list) =>
      list.map((t) => {
        if (t.threadId !== threadId || t.type !== 'GROUP') return t;
        const group = { ...t.group };
        if (patch.name !== undefined) group.name = patch.name;
        if (patch.description !== undefined)
          group.description = patch.description;
        if (patch.avatar !== undefined) group.avatar = patch.avatar;
        if (patch.dissolvedAt !== undefined)
          group.dissolvedAt = patch.dissolvedAt;
        if (patch.memberCount !== undefined)
          group.memberCount = patch.memberCount;
        if (patch.groupMetaFeedId !== undefined)
          group.groupMetaFeedId = patch.groupMetaFeedId;
        changed = {
          ...t,
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.profileRev !== undefined
            ? { profileRev: Math.max(t.profileRev, patch.profileRev) }
            : {}),
          group,
        };
        return changed;
      }),
    );
    if (changed) {
      void this.persistThread(changed);
      if (patch.profileRev !== undefined)
        void this.resolveThreadProfile(changed);
    }
  }

  /** Drop a thread after an explicit delete-data action. This is the SOLE chokepoint for thread removal, so the full local
   *  cleanup lives here: drop the list row + open-thread pointer, delete the `threads`-store record, clear the
   *  stale {@link lastSeenSeq} residue, AND purge the cached message bodies via the message repo. An explicit
   *  delete-data choice must survive even when the backend later reuses the stable relationship thread.
   *  Both IDB writes are best-effort + fire-and-forget. */
  async removeThread(threadId: number): Promise<void> {
    this._items.update((list) => list.filter((t) => t.threadId !== threadId));
    if (this._openThreadId() === threadId) this._openThreadId.set(undefined);
    this.lastSeenSeq.delete(threadId);
    this.serverLastReadSeq.delete(threadId);
    this.localStableReadSeq.delete(threadId);
    this.threadStates.delete(threadId);
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
    void this.projectThread(threadId);
    const epoch = this.sessionEpoch;
    void this.webdb
      .advanceThreadRead(threadId, seq)
      .then((state) => {
        if (epoch === this.sessionEpoch)
          void this.applyThreadStates([state], false);
      })
      .catch((error) =>
        console.warn('[thread-feed] local read persistence failed', error),
      );
    return true;
  }

  /** Insert or refresh one structural conversation projection. It remains hidden until its
   * account-scoped thread-feed snapshot supplies the authoritative list-order coordinate. */
  private upsertThread(item: ConversationItem): void {
    const threadFeedId =
      attentionSnapshot(this.threadStates.get(item.threadId))?.threadFeedId ??
      item.threadFeedId;
    let reconciled: ConversationItem =
      item.type === 'P2P'
        ? {
            ...item,
            ...(threadFeedId !== undefined
              ? { threadFeedId, visible: true }
              : { visible: false }),
            lastReadSeq: null,
            unreadCount: 0,
            mentionUnread: [],
          }
        : {
            ...item,
            ...(threadFeedId !== undefined
              ? { threadFeedId, visible: true }
              : { visible: false }),
            lastReadSeq: null,
            unreadCount: 0,
            mentionUnread: [],
          };
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === reconciled.threadId);
      const base = list.slice();
      if (idx === -1) {
        base.unshift(this.withConfirmedAlias(reconciled));
      } else {
        const current = base[idx];
        if (
          current.type === 'P2P' &&
          reconciled.type === 'P2P' &&
          current.peerProfileMessageSeq != null &&
          current.peerProfileMessageSeq >
            (reconciled.peerProfileMessageSeq ?? 0) &&
          current.peerUser.account === reconciled.peerUser.account &&
          current.peerUser.domain === reconciled.peerUser.domain &&
          current.peerUser.namespaceId === reconciled.peerUser.namespaceId
        ) {
          reconciled = {
            ...reconciled,
            peerUser: current.peerUser,
            peerProfileMessageSeq: current.peerProfileMessageSeq,
          };
        }
        reconciled = preserveThreadProfile(reconciled, current);
        reconciled = {
          ...reconciled,
          lastReadSeq: current.lastReadSeq,
          unreadCount: current.unreadCount,
          mentionUnread: current.mentionUnread,
        };
        // Structural state-feed hydration does not own message preview content. Preserve the local
        // projection until message catch-up or local-cache hydration replaces it.
        if (
          reconciled.lastMessagePreview == null &&
          current.lastMessagePreview != null
        ) {
          reconciled = {
            ...reconciled,
            lastMessagePreview: current.lastMessagePreview,
            lastMessageSenderId: current.lastMessageSenderId,
          };
        }
        base[idx] = this.withConfirmedAlias(reconciled);
      }
      return sortThreadItems(base);
    });
    this._status.set('READY');
    if (threadFeedId !== undefined) void this.persistThread(reconciled);
    void this.resolveThreadProfile(reconciled);
  }

  private applyItems(items: ConversationItem[]): void {
    const ordered = sortThreadItems(
      items.map((item) => this.withConfirmedAlias(item)),
    );
    this._items.set(ordered);
    for (const item of ordered) void this.resolveThreadProfile(item);
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
        lastMessageSeq: head.messageEndSeq,
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
      typeof d.userId !== 'number' ||
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
    await this.userService.establishSession(d.userId, d.profileRev ?? 0);
    const epoch = this.sessionEpoch;
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
      const cursor = await this.webdb.getSyncState('threadFeedCursor');
      if (epoch !== this.sessionEpoch) return;
      this.threadFeedCursor = typeof cursor === 'number' ? cursor : 0;
    }
    const states = await this.webdb.getThreadStates();
    if (epoch !== this.sessionEpoch) return;
    await this.applyThreadStates(states, false);
    if (epoch !== this.sessionEpoch) return;
    const port = await this.webdb.createThreadFeedPort();
    if (epoch !== this.sessionEpoch) {
      port?.close();
      return;
    }
    if (port) this.ws.attachThreadFeed(port, d.userId);
    // HELLO is a memory event. The worker/Rust executor commits the state feed,
    // then reports state-feed-committed; the UI only reads its projection.
    await this.refreshCommittedStateFeed();
    if (epoch !== this.sessionEpoch) return;
    // The HELLO wake reaches the worker/Rust independently. A concurrent completion also
    // delivers thread-feed-committed after the cursor and Group Meta pages commit.
    await this.refreshCommittedThreadFeed();
  }

  private async refreshCommittedStateFeed(): Promise<void> {
    const epoch = this.sessionEpoch;
    const cursor = await this.userService.refreshCommittedStateFeed();
    if (epoch !== this.sessionEpoch || cursor === undefined) return;
    const [items, namespaces] = await Promise.all([
      this.readCachedThreads(),
      this.webdb.getNamespaces(),
    ]);
    if (epoch !== this.sessionEpoch) return;
    this.namespaces.replace(namespaces);
    this.applyItems(items);
  }

  async refreshBackgroundThreadFeed(userId: number): Promise<void> {
    if (userId !== this.userService.sessionUserId()) return;
    await this.refreshCommittedThreadFeed();
  }

  /** Completion wakes never initiate HTTP, including after a partially successful background drain. */
  private async refreshCommittedThreadFeed(): Promise<void> {
    if (this.threadFeedCursor === undefined) return;
    const epoch = this.sessionEpoch;
    try {
      const changes = await this.webdb.readThreadFeedChanges(
        this.threadFeedCursor,
      );
      if (epoch !== this.sessionEpoch) return;
      this.applyItems(await this.webdb.getThreads());
      if (epoch !== this.sessionEpoch) return;
      await this.applyThreadStates(changes.states, true);
      if (epoch !== this.sessionEpoch) return;
      this.threadFeedCursor = Math.max(
        this.threadFeedCursor ?? 0,
        changes.cursor,
      );
    } catch (error) {
      if (epoch === this.sessionEpoch)
        console.warn('[thread-feed] local completion refresh failed', error);
    }
  }

  private async applyThreadStates(
    states: LocalThreadAttention[],
    emitLive: boolean,
  ): Promise<void> {
    const epoch = this.sessionEpoch;
    const notifications: ThreadNotificationUpdate[] = [];
    for (const stored of states) {
      if (epoch !== this.sessionEpoch) return;
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
      if (!this._items().some((item) => item.threadId === state.threadId)) {
        const cached = (await this.webdb.getThreads()).find(
          (item) => item.threadId === state.threadId,
        );
        if (cached) this.upsertThread(cached);
      }
      const snapshot = attentionSnapshot(state);
      if (snapshot) {
        this.publishThreadAlias(snapshot);
        this.applyThreadFeedOrder(
          snapshot.threadId,
          snapshot.threadFeedId,
          snapshot.threadProfileRev,
        );
        this.applyGroupProjectionHeads(snapshot);
        this.serverLastReadSeq.set(state.threadId, snapshot.lastReadSeq);
        this.messageRepo.applyThreadContentHead(
          state.threadId,
          snapshot.messageEndSeq,
          emitLive,
        );
        this.applyThreadContentHead(snapshot, emitLive);
        const pending = this.pendingUnknownContentHeads.get(state.threadId);
        if (pending) {
          this.pendingUnknownContentHeads.delete(state.threadId);
          this.applyContentHeadToKnownThread(pending);
        }
        // Drain-open feedback loop: a committed state for the open thread
        // re-arms the per-thread Group Meta + tombstone drains with the new
        // coordinates. The worker's drains coalesce (same target → HWM already
        // current → no-op → no further notification), so this terminates.
        if (this._openThreadId() === state.threadId)
          void this.webdb
            .drainThreadMisc(
              state.threadId,
              snapshot.groupMetaFeedEndId,
              snapshot.tombstoneEndSeq,
            )
            .catch(() => undefined);
      }
      const item = await this.projectThread(state.threadId);
      if (notify && item && snapshot)
        notifications.push({ item, state: snapshot });
    }
    if (emitLive && epoch === this.sessionEpoch && notifications.length)
      this.threadNotifications.next(notifications);
  }

  private async projectThread(
    threadId: number,
  ): Promise<ConversationItem | undefined> {
    const state = this.threadStates.get(threadId);
    if (!state) return;
    const server = attentionSnapshot(state);
    if (!server) return;
    const range = attentionCountRange(state);
    const me = this.userService.sessionProfile();
    if (!range || !me) return;
    const epoch = this.sessionEpoch;
    const token = {};
    this.projectionTokens.set(threadId, token);
    const count = await this.webdb
      .countUnreadMessageSlots(threadId, range.afterSeq, range.throughSeq, {
        account: me.account,
        domain: 'local',
        namespaceId: 0,
      })
      .catch((error) => {
        if (epoch === this.sessionEpoch)
          console.warn('[thread-feed] count projection failed', error);
        return null;
      });
    if (count === null) return;
    if (
      epoch !== this.sessionEpoch ||
      this.threadStates.get(threadId) !== state ||
      this.projectionTokens.get(threadId) !== token
    )
      return;
    const projection = projectThreadAttention(state, count)!;
    // Preview membership belongs to the server; optimistic reads only affect
    // attention state and must not prune the conversation summary.
    const preview = server.previews?.at(-1);
    const namespaceId = preview
      ? this.namespaces.activeNamespaceId(preview.sender.domain)
      : null;
    let projected: ConversationItem | undefined;
    this._items.update((items) =>
      items.map((item) => {
        if (item.threadId !== threadId) return item;
        const changed = {
          ...item,
          lastReadSeq: projection.lastReadSeq,
          announcementReadFeedId: Math.max(
            item.announcementReadFeedId ?? 0,
            server.announcementReadFeedId ?? 0,
          ),
          unreadCount: projection.unreadCount,
          mentionUnread: projection.hasUnreadMention ? ['me' as const] : [],
          joinRequestEndFeedId: server.joinRequestEndFeedId,
          joinRequestReadFeedId: server.joinRequestReadFeedId,
          groupInviteEndFeedId: server.groupInviteEndFeedId,
          lastMessagePreview: preview
            ? preview.status === 'LIVE'
              ? (preview.text ?? '')
              : preview.status === 'USER_RETRACTION'
                ? '[Message retracted]'
                : '[Message removed by administrator]'
            : null,
          lastMessageAt: preview
            ? Date.parse(preview.createdAt)
            : item.lastMessageAt,
          lastMessageSenderId:
            preview && namespaceId != null
              ? messagePreviewSenderKey({ ...preview.sender, namespaceId })
              : null,
        };
        void this.persistThread(changed);
        projected = changed;
        return changed;
      }),
    );
    this._items.update(sortThreadItems);
    return projected;
  }

  private applyThreadFeedOrder(
    threadId: number,
    threadFeedId: number,
    threadProfileRev: number,
  ): void {
    if (!isThreadListFeedId(threadFeedId))
      throw new Error(`Invalid threadFeedId for thread ${threadId}`);
    let changed: ConversationItem | undefined;
    this._items.update((items) => {
      const index = items.findIndex((item) => item.threadId === threadId);
      if (index < 0) return items;
      const current = items[index];
      if (
        current.visible !== false &&
        current.threadFeedId === threadFeedId &&
        current.profileRev >= threadProfileRev
      )
        return items;
      changed = {
        ...current,
        visible: true,
        threadFeedId,
        profileRev: Math.max(current.profileRev, threadProfileRev),
      };
      const next = items.slice();
      next[index] = changed;
      return sortThreadItems(next);
    });
    if (changed) {
      void this.persistThread(changed);
      void this.resolveThreadProfile(changed);
    }
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
              (snapshot.announcementReadFeedId ?? 0) &&
            (item.type !== 'GROUP' ||
              item.groupMetaTargetFeedId === snapshot.groupMetaFeedEndId))
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
          ...(item.type === 'GROUP'
            ? { groupMetaTargetFeedId: snapshot.groupMetaFeedEndId }
            : {}),
        };
        return changed;
      }),
    );
    if (changed) void this.persistThread(changed);
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
    if (changed) void this.persistThread(changed);
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
    if (changed) void this.persistThread(changed);
  }

  // ── IDB persistence helpers (best-effort; IDB unavailable → graceful no-op) ────────────────

  /** Read cached threads and restore the authoritative account-scoped feed order. */
  private async readCachedThreads(): Promise<ConversationItem[]> {
    const all = await this.webdb.getThreads();
    const states = new Map(
      (await this.webdb.getThreadStates())
        .filter((state) => state.threadFeedId !== null)
        .map((state) => [state.threadId, state.threadFeedId!]),
    );
    return sortThreadItems(
      all
        .map((item) => ({
          ...item,
          threadFeedId: states.get(item.threadId) ?? item.threadFeedId,
        }))
        .filter((item) => isThreadListFeedId(item.threadFeedId)),
    );
  }

  /** Write-through a single changed thread (idempotent put by threadId). */
  private async persistThread(item: ConversationItem): Promise<void> {
    try {
      await this.webdb.putThread(item);
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
interface HelloPayload {
  userId?: number;
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

/** Pinned is the only tier. Within each tier the account feed is the sole ordering authority. */
function sortThreadItems(items: ConversationItem[]): ConversationItem[] {
  const visible = items.filter((item) => item.visible !== false);
  const ids = new Set<number>();
  for (const item of visible) {
    if (!isThreadListFeedId(item.threadFeedId))
      throw new Error(`Visible thread ${item.threadId} has no threadFeedId`);
    if (ids.has(item.threadFeedId))
      throw new Error(`Duplicate threadFeedId ${item.threadFeedId}`);
    ids.add(item.threadFeedId);
  }
  return [
    ...visible.sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.threadFeedId! - left.threadFeedId!,
    ),
    ...items.filter((item) => item.visible === false),
  ];
}

function threadProfileReference(item: ConversationItem) {
  const profile = item.type === 'GROUP' ? item.group : item.peerUser;
  return {
    account: profile.account,
    domain: profile.domain,
    namespaceId: profile.namespaceId,
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
