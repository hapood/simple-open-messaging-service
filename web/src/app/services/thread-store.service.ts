import { Injectable, inject, signal, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map, Subject, Subscription } from 'rxjs';
import { WebdbService } from './webdb.service';
import { UserService, type ClientStateFeedItem } from './user.service';
import { WebsocketService } from './websocket.service';
import { ProfileRepository } from './profile-store.service';
import { MessageRepository } from './message-repository.service';
import { toDisplayText } from '../lib/message-entity';
import { deriveMessagePreview } from '../../../../shared/message-preview';
import {
  ConversationItem,
  GroupConversationItem,
  Message,
  messagePreviewSenderKey,
  localSubjectIdentity,
  P2PConversationItem,
  ThreadReadState,
  User,
} from './model';
import { MsgService } from './message.service';
import { MemberProfileRepository } from './member-profile-store.service';
import { ToastService } from './toast.service';
import { TranslocoService } from '@jsverse/transloco';
import { FederationNamespaceService } from './federation-namespace.service';
import { ProfileResolutionService } from './profile-resolution.service';
import { isTauri } from './runtime';
import { SessionLifecycleService } from './session-lifecycle.service';
import { isFullConsoleLoggingEnabled } from './log-buffer';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

type ThreadContentHead = Extract<
  ClientStateFeedItem,
  { eventType: 'THREAD_CONTENT_HEAD' }
>['body'];

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
 * list READ (`/user/state-feed`) and the consumer of the durable client-state wake
 * (`STATE_FEED_UPDATED`). UI-facing services
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
  private readonly profileRepo = inject(ProfileRepository);
  private readonly messageRepo = inject(MessageRepository);
  private readonly messages = inject(MsgService);
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  private readonly namespaces = inject(FederationNamespaceService);
  private readonly profileResolutions = inject(ProfileResolutionService);
  private readonly peerProfileRequests = new Set<string>();

  private readonly _items = signal<ConversationItem[]>([]);
  private readonly previewQueue = new Set<number>();
  private readonly previewRevisions = new Map<number, string>();
  private previewWorkers = 0;
  private previewEpoch = 0;
  readonly items = this._items.asReadonly();

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
  private readonly _readCommitPending = signal<ReadonlySet<number>>(new Set());
  readonly readCommitPending = this._readCommitPending.asReadonly();
  private readonly bufferedContentHeads = new Map<
    number,
    { head: ThreadContentHead; emitLiveSignal: boolean }
  >();
  /** A content head can share a page with the relationship state that materializes its thread. */
  private readonly pendingUnknownContentHeads = new Map<
    number,
    ThreadContentHead
  >();

  /** A thread promoted to index 0 on the most recent update (to be FLIP-animated by the list), or null.
   *  Set in {@link applyItems} / {@link upsertThread} when a top-insert was requested; the list clears it
   *  after animating ({@link clearTopInserted}). */
  private readonly _topInserted = signal<number | null>(null);
  readonly topInserted = this._topInserted.asReadonly();
  /** Explicit thread to force-top on the next applyItems (set by {@link markTopOnNextUpdate}). */
  private _pendingTopId: number | null = null;

  /** Single-flight + tail-coalesce for STATE_FEED_UPDATED (mirrors onmessagesignal-single-flight):
   *  while a delta pull is in-flight, the latest incoming revision is stashed as the tail; on completion
   *  the tail is pulled `(cursor, tail]`, collapsing a signal burst into ranged pulls. */
  private _deltaInFlight = false;
  private _pendingTailFeedId: number | undefined;
  private _fullStateDrainTarget: number | undefined;
  /** UI-facing revisions collected across every page/tail in the current state-feed drain. Publishing
   * them only at the drain boundary prevents consumers from rendering half of a multi-row transition. */
  private _drainRelationshipIntentRevision: number | undefined;
  private _drainRelationshipRequestRevision: number | undefined;

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
      effectiveLastReadSeq:
        server === null
          ? local
          : local === null
            ? server
            : Math.max(server, local),
    };
  }

  beginReadCommit(threadId: number): void {
    if (this._readCommitPending().has(threadId)) return;
    this._readCommitPending.update(
      (current) => new Set([...current, threadId]),
    );
  }

  /** Drop the merge barrier, then replay only the newest message signal captured behind it. */
  finishReadCommit(threadId: number): void {
    if (this._readCommitPending().has(threadId)) {
      this._readCommitPending.update((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
    const buffered = this.bufferedContentHeads.get(threadId);
    this.bufferedContentHeads.delete(threadId);
    if (buffered)
      this.applyThreadContentHead(buffered.head, buffered.emitLiveSignal);
  }

  /** Account-scoped first thread initialization barrier. It is independent of HELLO payload state;
   * both the list mount and a fast-arriving HELLO await this same single-flight operation. */

  /** Per-thread dismiss-HWM map (threadId → seq) for the away-notification's per-thread grouping. A dismiss
   *  records the descriptor's `{threadId, seq}` so the next notification-feed query counts THAT thread
   *  from it (resets its cumulative count to 0 until newer messages); the server drops threads whose
   *  post-dismiss count is 0. Persisted to IDB (survives a page reload mid-away-session) + cleared on
   *  focus-regain (the Android "foreground → all per-thread HWMs reset" model) and on logout (the per-user
   *  DB is deleted). Mirrors `SomsMessagingService.recordThreadDismiss` on Android. */
  private readonly _threadHwms = signal<Record<number, number>>({});

  private readonly sseSub: Subscription;

  constructor() {
    this.profileResolutions.resolved$
      .pipe(takeUntilDestroyed())
      .subscribe(({ selector, profile }) => {
        if (!('messageSeq' in selector)) return;
        const thread = this._items().find(
          (item) => item.threadId === selector.threadId,
        );
        if (
          thread?.type !== 'P2P' ||
          thread.peerUser.account !== profile.account ||
          thread.peerUser.domain !== profile.domain ||
          selector.messageSeq <= (thread.peerProfileMessageSeq ?? 0)
        )
          return;
        const changed = {
          ...thread,
          peerProfileMessageSeq: selector.messageSeq,
          peerUser: {
            ...thread.peerUser,
            name: profile.name,
            bio: profile.bio,
            avatar: profile.avatarBase64
              ? `data:image/webp;base64,${profile.avatarBase64}`
              : '',
            profileRev: profile.rev,
          },
        };
        this._items.update((items) =>
          items.map((item) => (item === thread ? changed : item)),
        );
        void this.persistThread(changed);
      });
    // Cached rows can be painted before HELLO, while sessionUserId is already null. Logout must
    // reset them explicitly rather than relying on an identity signal transition.
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => this.reset());
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
          if (m.data !== undefined)
            this.onStateFeedUpdated((m.data as { feedId: number }).feedId);
          break;
        case 'ATTENTION_REV_UPDATED':
          if (m.data !== undefined)
            void this.syncReadDelta(
              (m.data as { attentionRevision: number }).attentionRevision,
            );
          break;
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
      const id = this.userService.sessionUserId();
      if (id === null) this.reset();
    });
  }

  /**
   * Drop ALL in-memory session state (logout / account switch). The IDB store is closed + deleted by
   * WebdbService (on the same sessionUserId signal); this resets the in-memory caches so they cannot leak
   * across users. Resets {@link _status} to LOADING so the freshly-mounted list re-loads on the next HELLO.
   */
  private reset(): void {
    this.previewEpoch++;
    this.peerProfileRequests.clear();
    this.previewQueue.clear();
    this.previewRevisions.clear();
    this._items.set([]);
    this._status.set('LOADING');
    this._error.set('');
    this._openThreadId.set(undefined);
    this._topInserted.set(null);
    this._pendingTopId = null;
    this._deltaInFlight = false;
    this._pendingTailFeedId = undefined;
    this._fullStateDrainTarget = undefined;
    this._drainRelationshipIntentRevision = undefined;
    this._drainRelationshipRequestRevision = undefined;
    this.lastSeenSeq.clear();
    this.serverLastReadSeq.clear();
    this.localStableReadSeq.clear();
    this._readCommitPending.set(new Set());
    this.bufferedContentHeads.clear();
    this.pendingUnknownContentHeads.clear();
    this._threadHwms.set({});
    this.readRevision = undefined;
    this.readSyncInFlight = false;
    this.readSyncTarget = 0;
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

  /** Read the IDB `threads` store + apply it instantly (the eager pre-HELLO paint). Bails if the list is
   *  already populated so a late cache read cannot clobber a fresher HELLO delta that landed during it. */
  private async paintFromCache(): Promise<void> {
    const epoch = this.previewEpoch;
    try {
      const namespaces = await this.webdb.getNamespaces();
      if (epoch !== this.previewEpoch) return;
      this.namespaces.replace(namespaces);
      if (this._items().length > 0) return; // already populated — don't clobber a fresher state
      const cached = await this.readCachedThreads();
      if (epoch !== this.previewEpoch) return;
      if (cached.length > 0 && this._items().length === 0) {
        for (const item of cached) {
          if (typeof item.lastReadSeq === 'number')
            this.localStableReadSeq.set(item.threadId, item.lastReadSeq);
        }
        this.applyItems(cached); // flips READY
        void this.hydratePreviews(); // re-derive previews from the local message store
      } else if (this._items().length === 0 && this._status() !== 'READY') {
        this._status.set('LOADING'); // cold start, no cache → await HELLO's delta
      }
    } catch (error) {
      // Cache paint is optional; HELLO owns initialization and authoritative recovery.
      console.warn('[cache-paint] cached thread read failed', error);
      if (epoch === this.previewEpoch)
        await this.userService.requestCacheRebuild();
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
  async setOpenThread(threadId: number | undefined): Promise<void> {
    this._openThreadId.set(threadId);
    if (threadId !== undefined) {
      const target =
        this._items().find((item) => item.threadId === threadId)
          ?.tombstoneEndSeq ?? 0;
      await this.messageRepo.openTombstoneStream(threadId, target);
    }
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

  /** Patch per-user thread metadata (mute/pin/block/alias) on a row. Only pin changes re-sort the
   *  list; display-state changes stay at the row's current position and must not re-apply recency ordering.
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
      if ('pinned' in patch && patch.pinned !== list[idx].pinned)
        return stablePinnedTiers(next);
      return next;
    });
    if (changed) {
      void this.persistThread(changed);
      if ('pinned' in patch) void this.persistThreadOrder();
    }
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

  private applyJoinRequestActivity(threadId: number, at: number): void {
    if (!Number.isFinite(at) || at <= 0) return;
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const index = list.findIndex((thread) => thread.threadId === threadId);
      if (index < 0 || (list[index].joinRequestAt ?? 0) >= at) return list;
      const next = list.slice();
      changed = { ...next[index], joinRequestAt: at };
      next[index] = changed;
      return moveToTierTop(next, threadId);
    });
    if (changed) {
      void this.persistThread(changed);
      void this.persistThreadOrder();
    }
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
        user.profileRev !== found.peerUser.profileRev ||
        user.account !== found.peerUser.account ||
        user.domain !== found.peerUser.domain ||
        user.namespaceId !== found.peerUser.namespaceId
      )
        return list;
      changed = { ...found, peerUser: user };
      return list.map((t) =>
        t.threadId === threadId && t.type === 'P2P' ? changed! : t,
      );
    });
    if (changed) {
      void this.persistThread(changed);
      this.writePeerProfile(changed.peerUser);
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
        if (patch.profileRev !== undefined) group.profileRev = patch.profileRev;
        changed = {
          ...t,
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          group,
        };
        return changed;
      }),
    );
    if (changed) {
      void this.persistThread(changed);
      this.writeGroupProfile(changed.group);
      if (changed.role !== 'OWNER' && changed.role !== 'ADMIN')
        this.userService.clearGroupJoinRequestHead(threadId);
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
    if (this._readCommitPending().has(threadId)) {
      this._readCommitPending.update((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
    this.bufferedContentHeads.delete(threadId);
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

  /** Record a viewport-dwelled HWM without changing the server-owned unread badge. */
  commitLocalRead(threadId: number, seq: number): boolean {
    const found = this._items().find((t) => t.threadId === threadId);
    if (!found) return false;
    const current = Math.max(
      found.lastReadSeq ?? 0,
      this.localStableReadSeq.get(threadId) ?? 0,
    );
    if (seq <= current) return false;
    this.noteLocalStableRead(threadId, seq);
    return true;
  }

  /** Apply the atomic read-commit response; this is the only in-session writer of the open row's badge. */
  applyReadState(d: ThreadReadState): void {
    if (typeof d?.threadId !== 'number' || typeof d?.lastReadSeq !== 'number')
      return;
    const confirmed = this.serverLastReadSeq.get(d.threadId) ?? -1;
    if (d.lastReadSeq < confirmed) return;
    this.serverLastReadSeq.set(d.threadId, d.lastReadSeq);
    const local = this.localStableReadSeq.get(d.threadId);
    const coversLocal = local === undefined || d.lastReadSeq >= local;
    if (local !== undefined && d.lastReadSeq >= local)
      this.localStableReadSeq.delete(d.threadId);
    let changed: ConversationItem | undefined;
    this._items.update((list) => {
      const found = list.find((t) => t.threadId === d.threadId);
      if (!found) return list;
      changed = {
        ...found,
        lastReadSeq: d.lastReadSeq,
        unreadCount: d.unreadCount,
        mentionUnread: d.mentionUnread,
      };
      return list.map((t) => (t.threadId === d.threadId ? changed! : t));
    });
    if (changed) void this.persistThread(changed);
    if (coversLocal) this.finishReadCommit(d.threadId);
  }

  /** Insert or refresh a single ConversationItem from an explicit conversation fetch. Mirrors
   *  applyItems' FLIP: if `_pendingTopId` matches, force-top it + emit `topInserted`. Idempotent. */
  private upsertThread(item: ConversationItem): void {
    let reconciled: ConversationItem =
      item.type === 'P2P'
        ? {
            ...item,
            lastReadSeq: null,
            unreadCount: 0,
            mentionUnread: [],
          }
        : {
            ...item,
            lastReadSeq: null,
            unreadCount: 0,
            mentionUnread: [],
          };
    reconciled = this.normalizeGroupProjection(reconciled);
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === reconciled.threadId);
      const base = list.slice();
      if (idx === -1) {
        base.unshift(reconciled);
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
        base[idx] = reconciled;
      }
      return this._pendingTopId === reconciled.threadId
        ? moveToTierTop(base, reconciled.threadId)
        : stablePinnedTiers(base);
    });
    if (this._pendingTopId === reconciled.threadId) {
      this._topInserted.set(reconciled.threadId);
      this._pendingTopId = null;
    }
    void this.persistThreadOrder();
    this._status.set('READY');
    void this.persistThread(reconciled);
    // A fresh item carries an embedded peer/group profile — write it through too (avatar freshness).
    if (reconciled.type === 'P2P') {
      if (reconciled.peerProfileMessageSeq == null) {
        this.writePeerProfile(reconciled.peerUser);
        this.resolveThreadPeerProfile(reconciled);
      }
    } else if (reconciled.type === 'GROUP')
      this.writeGroupProfile(reconciled.group);
  }

  private applyItems(items: ConversationItem[]): void {
    const reconciled = items.map((item) => this.normalizeGroupProjection(item));
    const sorted = stablePinnedTiers(reconciled);
    const topId = this.resolveTopId(reconciled);
    const ordered = topId != null ? moveToTierTop(sorted, topId) : sorted;
    this._items.set(ordered);
    this._status.set('READY');
    if (topId != null) this._topInserted.set(topId);
    for (const item of ordered)
      if (item.type === 'P2P') this.resolveThreadPeerProfile(item);
  }

  private normalizeGroupProjection(item: ConversationItem): ConversationItem {
    if (item.type !== 'GROUP') return item;
    const legacy = item.group as typeof item.group & { members?: unknown };
    const { members: _members, ...group } = legacy;
    return {
      ...item,
      group: {
        ...group,
        memberCount:
          typeof group.memberCount === 'number' ? group.memberCount : 0,
        groupMetaFeedId:
          typeof group.groupMetaFeedId === 'string'
            ? group.groupMetaFeedId
            : '0',
      },
    };
  }

  /** Determine which thread (if any) to promote to index 0 on this update, consuming the pending flag. */
  private resolveTopId(items: ConversationItem[]): number | undefined {
    let topId: number | undefined;
    if (
      this._pendingTopId != null &&
      items.some((t) => t.threadId === this._pendingTopId)
    ) {
      topId = this._pendingTopId;
    }
    this._pendingTopId = null;
    return topId;
  }

  /** Relationship snapshots carry a profile revision even when their image bytes are absent.
   * Resolve that exact revision through the shared dispatcher and keep the list's durable projection current. */
  private resolveThreadPeerProfile(thread: P2PConversationItem): void {
    const { account, domain, profileRev: rev, namespaceId } = thread.peerUser;
    // Local PROFILE facts already contain the full avatar; the account selector uses canonical
    // federation domains and must not receive the local storage sentinel.
    if (
      thread.peerProfileMessageSeq != null ||
      domain === 'local' ||
      !(rev > 0)
    )
      return;
    const epoch = this.previewEpoch;
    const key = JSON.stringify([
      epoch,
      thread.threadId,
      namespaceId,
      domain,
      account,
      rev,
    ]);
    if (this.peerProfileRequests.has(key)) return;
    this.peerProfileRequests.add(key);
    this.profileResolutions.resolve({ account, domain, rev }).subscribe({
      next: (profile) => {
        if (epoch !== this.previewEpoch || profile.rev !== rev) return;
        let changed: P2PConversationItem | undefined;
        this._items.update((items) =>
          items.map((item) => {
            if (
              item.type !== 'P2P' ||
              item.peerProfileMessageSeq != null ||
              item.threadId !== thread.threadId ||
              item.peerUser.account !== account ||
              item.peerUser.domain !== domain ||
              item.peerUser.namespaceId !== namespaceId ||
              item.peerUser.profileRev !== rev
            )
              return item;
            changed = {
              ...item,
              peerUser: {
                ...item.peerUser,
                name: profile.name,
                bio: profile.bio,
                avatar: profile.avatarBase64
                  ? `data:image/webp;base64,${profile.avatarBase64}`
                  : '',
              },
            };
            return changed;
          }),
        );
        if (changed) void this.persistThread(changed);
      },
      error: () => this.peerProfileRequests.delete(key),
      complete: () => this.peerProfileRequests.delete(key),
    });
  }

  private resolveThreadGroupProfile(
    threadId: number,
    account: string,
    domain: string,
    rev: number,
  ): void {
    this.profileResolutions.resolve({ account, domain, rev }).subscribe({
      next: (profile) => {
        let changed: GroupConversationItem | undefined;
        this._items.update((items) =>
          items.map((item) => {
            if (
              item.threadId !== threadId ||
              item.type !== 'GROUP' ||
              item.group.account !== account ||
              item.group.domain !== domain ||
              item.group.profileRev !== rev
            )
              return item;
            changed = {
              ...item,
              group: {
                ...item.group,
                name: profile.name,
                description: profile.bio,
                avatar: profile.avatarBase64
                  ? `data:image/webp;base64,${profile.avatarBase64}`
                  : '',
                profileRev: profile.rev,
              },
            };
            return changed;
          }),
        );
        if (changed) void this.persistThread(changed);
      },
      error: (error: unknown) =>
        console.warn(
          `[profile] failed to resolve group thread ${threadId} revision ${rev}`,
          error,
        ),
    });
  }

  /** Apply a durable content projection after its State Feed page commits locally. */
  private applyThreadContentHead(
    head: ThreadContentHead,
    emitLiveSignal: boolean,
  ): void {
    if (this._readCommitPending().has(head.threadId)) {
      const current = this.bufferedContentHeads.get(head.threadId);
      if (!current || head.messageEndSeq >= current.head.messageEndSeq)
        this.bufferedContentHeads.set(head.threadId, {
          head,
          emitLiveSignal: current?.emitLiveSignal || emitLiveSignal,
        });
      return;
    }
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
        tombstoneEndSeq: head.tombstoneEndSeq,
      };
      const next = list.slice();
      next[idx] = changed;
      this.queuePreview(changed);
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

  /** Load the persisted per-thread dismiss-HWM map from IDB. Malformed/absent → empty (defensive — never
   *  blocks the away path). The numeric keys are JSON-encoded as strings, so coerce + validate on read. */
  private async loadThreadHwms(): Promise<void> {
    const raw = (await this.webdb.getMeta('threadHwms')) as
      | Record<string, unknown>
      | null
      | undefined;
    if (!raw || typeof raw !== 'object') {
      this._threadHwms.set({});
      return;
    }
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const tid = Number(k);
      if (Number.isInteger(tid) && typeof v === 'number' && Number.isFinite(v))
        out[tid] = v;
    }
    this._threadHwms.set(out);
  }

  private readRevision: number | undefined;
  private readSyncInFlight = false;
  private readSyncTarget = 0;

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
      d.stateFeedEndId < 0
    )
      return;
    // 1. Establish the session — opens the per-user IDB on HELLO's userId (cold start: first open; warm
    //    start: already opened by restoreSession's restoreWebdb, idempotent here). The profile fetch is
    //    gated async inside establishSession. The cache-paint is NOT repeated here — load() already eager-
    //    painted from the IDB cache (and on a cold start the cache is empty, so the delta below populates).
    await this.userService.establishSession(d.userId, d.profileRev ?? 0);
    // HELLO can race the thread-list mount. It awaits the account-level thread-init barrier, but does
    // not provide or own the deletion HWM; reconnects reuse the persisted result.
    // 2. Load the per-thread dismiss-HWM map.
    await this.loadThreadHwms();
    const persistedReadRevision = await this.webdb.getMeta('readRevision');
    if (this.readRevision === undefined)
      this.readRevision =
        typeof persistedReadRevision === 'number' && persistedReadRevision >= 0
          ? persistedReadRevision
          : 0;
    if (typeof d.readRevision === 'number')
      await this.syncReadDelta(d.readRevision);
    // 3. Delta-replay the thread list: full `(0, rev]` on first connect (cursor unseeded → seed 0),
    //    incremental `(cursor, rev]` on reconnect. The server plans (last-op-wins) + hydrates.
    if (this.userService.stateFeedCursor() === undefined) {
      const persisted = await this.webdb.getMeta('stateFeedId');
      this.userService.seedStateFeedCursor(
        typeof persisted === 'number' && persisted >= 0 ? persisted : 0,
      );
    }
    await this.pullDelta(d.stateFeedEndId);
    // 4. Re-derive previews from the local message store.
    void this.hydratePreviews(true);
  }

  private async syncReadDelta(target: number): Promise<void> {
    this.readSyncTarget = Math.max(this.readSyncTarget, target);
    if (this.readSyncInFlight || this.readRevision === undefined) return;
    this.readSyncInFlight = true;
    try {
      while (this.readRevision < this.readSyncTarget) {
        const fromRevision = this.readRevision;
        const toRevision = this.readSyncTarget;
        const res = await firstValueFrom(
          this.userService.queryReadDelta({ fromRevision, toRevision }),
        );
        if (res.code !== 0 || !res.data) break;
        for (const item of res.data.items) this.applyReadState(item);
        this.advanceReadRevision(res.data.readRevision);
        if (res.data.readRevision <= fromRevision) break;
      }
    } catch {
      // HELLO or the next live revision retries from the durable cursor.
    } finally {
      this.readSyncInFlight = false;
      if (
        this.readRevision !== undefined &&
        this.readRevision < this.readSyncTarget
      )
        void this.syncReadDelta(this.readSyncTarget);
    }
  }

  private advanceReadRevision(revision: number): void {
    if ((this.readRevision ?? -1) >= revision) return;
    this.readRevision = revision;
    void this.webdb.putMeta('readRevision', revision);
  }

  /** The per-thread dismiss-HWM map (the away-notification renderer sends it as `threadHwms`). */
  threadHwms(): Record<number, number> {
    return this._threadHwms();
  }

  /** Record a per-thread dismiss — advance that thread's HWM to `seq` (monotonic; never regresses on a
   *  stale/out-of-order dismiss) so the next notification-feed query starts that thread after it. */
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

  /**
   * Apply a STATE_FEED_UPDATED { feedId } signal by pulling compacted state after the local cursor.
   * Single-flight + tail-coalesce collapses a burst of signals into one bounded drain.
   */
  onStateFeedUpdated(targetFeedId: number): void {
    if (this._deltaInFlight) {
      // Delivery is normally ordered on one SSE stream, but reconnect/bridge buffering can surface an older
      // signal after a newer one. Tail coalescing must therefore be monotonic or the newer target is lost.
      this._pendingTailFeedId = Math.max(
        this._pendingTailFeedId ?? targetFeedId,
        targetFeedId,
      );
      return;
    }
    void this.pullDelta(targetFeedId);
  }

  private async pullDelta(targetFeedId: number): Promise<void> {
    const cursor = this.userService.stateFeedCursor();
    // Cursor undefined = boot hasn't seeded yet. Drop the signal — the HELLO replay reflects current state,
    // and the cursor advances past this signal once seeded.
    if (cursor === undefined) return;
    if (targetFeedId === cursor) return;
    if (targetFeedId < cursor)
      console.warn(
        `[state-feed] local cursor ${cursor} is ahead of server ${targetFeedId}; requesting recovery`,
      );
    if (cursor === 0) this._fullStateDrainTarget = targetFeedId;
    this._deltaInFlight = true;
    let pageCommitted = false;
    try {
      const res = await firstValueFrom(
        this.userService.queryStateFeed({
          mode: this._fullStateDrainTarget === targetFeedId ? 'full' : 'delta',
          after: cursor,
          through: targetFeedId,
          take: 100,
        }),
      );
      if (res.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
        const reset = res.data as unknown as {
          resumeAfter?: unknown;
          resumeBefore?: unknown;
        };
        if (
          !Number.isSafeInteger(reset?.resumeAfter) ||
          !Number.isSafeInteger(reset?.resumeBefore) ||
          (reset.resumeAfter as number) < 0 ||
          (reset.resumeBefore as number) <= (reset.resumeAfter as number)
        )
          throw new Error('invalid client state-feed recovery window');
        const resumeAfter = reset.resumeAfter as number;
        const resumeThrough = (reset.resumeBefore as number) - 1;
        console.warn(
          `[state-feed] cursor unavailable; rebuilding from ${resumeAfter} through ${resumeThrough}`,
        );
        this.userService.seedStateFeedCursor(resumeAfter);
        this._fullStateDrainTarget = resumeThrough;
        this._pendingTailFeedId = resumeThrough;
        return;
      }
      if (res.code !== 0)
        throw new Error(`state delta returned business code ${res.code}`);
      {
        const page = res.data;
        if (
          !page ||
          page.mode !==
            (this._fullStateDrainTarget === targetFeedId ? 'full' : 'delta') ||
          !Array.isArray(page.items) ||
          !Number.isSafeInteger(page.scannedThrough) ||
          !Number.isSafeInteger(page.stateFeedEndId) ||
          page.scannedThrough <= cursor ||
          page.scannedThrough > targetFeedId ||
          page.stateFeedEndId < page.scannedThrough ||
          page.items.some(
            (item, index, items) =>
              !Number.isSafeInteger(item.feedId) ||
              item.feedId <= cursor ||
              item.feedId > page.scannedThrough ||
              (index > 0 && item.feedId <= items[index - 1].feedId),
          )
        )
          throw new Error('invalid client state feed page');
        const delta = page.items;
        if (isFullConsoleLoggingEnabled())
          console.debug(
            '[state-feed] received page',
            JSON.stringify({
              mode: page.mode,
              after: cursor,
              through: targetFeedId,
              scannedThrough: page.scannedThrough,
              stateFeedEndId: page.stateFeedEndId,
              items: delta.map(({ feedId, eventType }) => ({
                feedId,
                eventType,
              })),
            }),
          );
        const groupMeta = await this.prefetchGroupMeta(delta);
        // The rows and cursor are one durable unit. If this fails, leave both memory and cursor untouched;
        // the next HELLO retries the same idempotent range.
        await this.webdb.applyStateFeedPage(
          delta,
          page.scannedThrough,
          groupMeta,
          page.mode === 'full' && cursor === 0,
        );
        this.namespaces.replace(await this.webdb.getNamespaces());
        if (page.mode === 'full' && cursor === 0) {
          this._items.update((threads) =>
            threads.map((thread) => ({
              ...thread,
              blocked: false,
              ...(thread.type === 'P2P'
                ? {
                    friendshipActive: false,
                    conversationState: 'READ_ONLY',
                  }
                : {}),
            })),
          );
        }
        const persistedThreads = groupMeta.length
          ? await this.webdb.getThreads()
          : [];
        for (const update of groupMeta) {
          const persisted = persistedThreads.find(
            (thread) => thread.threadId === update.threadId,
          );
          if (persisted?.type !== 'GROUP') continue;
          const memory = this.items().find(
            (thread) => thread.threadId === update.threadId,
          );
          if (
            memory?.type === 'GROUP' &&
            (memory.group.account !== persisted.group.account ||
              memory.group.domain !== persisted.group.domain ||
              memory.group.namespaceId !== persisted.group.namespaceId)
          )
            console.warn(
              '[state-feed] group identity differs before memory update',
              JSON.stringify({
                scannedThrough: page.scannedThrough,
                threadId: update.threadId,
                memory: {
                  account: memory.group.account,
                  domain: memory.group.domain,
                  namespaceId: memory.group.namespaceId,
                },
                persisted: {
                  account: persisted.group.account,
                  domain: persisted.group.domain,
                  namespaceId: persisted.group.namespaceId,
                },
              }),
            );
          this.applyGroupUpdate(update.threadId, {
            memberCount: persisted.group.memberCount,
            groupMetaFeedId: persisted.group.groupMetaFeedId,
            profileRev: persisted.group.profileRev,
            role: persisted.role,
          });
        }
        // State items and any referenced group-meta pages are committed with one durable cursor.
        let relationshipIntentRevision: number | undefined;
        const relationshipThreadIds = new Set<number>();
        for (const op of delta) {
          if (op.eventType === 'RELATIONSHIP_INTENT') {
            // Persisted atomically by WebdbService. The friend-request dialog reads the compacted
            // projection on demand, so no additional in-memory mirror is required here.
            relationshipIntentRevision = Math.max(
              relationshipIntentRevision ?? 0,
              op.feedId,
            );
            const body = op.body;
            if (
              'peer' in body &&
              body.localThreadId !== null &&
              Number.isSafeInteger(body.localThreadId) &&
              body.localThreadId > 0
            ) {
              relationshipThreadIds.add(body.localThreadId);
            } else if (
              'group' in body &&
              Number.isSafeInteger(body.threadId) &&
              body.threadId > 0
            ) {
              relationshipThreadIds.add(body.threadId);
            }
          } else if (op.eventType === 'PROFILE') {
            this.applyStateProfile(op);
          } else if (op.eventType === 'GROUP_META_FEED_HEAD') {
            const affected = groupMeta
              .filter((update) => update.page.account === op.account)
              .map((update) => update.threadId);
            if (affected.length) this.memberProfiles.notifyChanged(affected);
          } else if (op.eventType === 'GROUP_JOIN_REQUEST_HEAD') {
            const hasNewUnread = this.userService.applyGroupJoinRequestHead(
              op.body.threadId,
              op.body.latestFeedId,
              op.body.readFeedId,
            );
            if (hasNewUnread)
              this.applyJoinRequestActivity(
                op.body.threadId,
                op.body.latestRequestAt,
              );
          } else if (op.eventType === 'INCOMING_INVITE_HEAD') {
            this.userService.applyRelationshipRequestReadHead(
              op.body.readThroughFeedId,
            );
          } else if (op.eventType === 'THREAD_CONTENT_HEAD') {
            const emitLiveSignal = page.mode === 'delta';
            this.messageRepo.applyThreadContentHead(
              op.body.threadId,
              op.body.messageEndSeq,
              emitLiveSignal,
            );
            this.applyThreadContentHead(op.body, emitLiveSignal);
            if (this._openThreadId() === op.body.threadId)
              void this.messageRepo.updateTombstoneTarget(
                op.body.threadId,
                op.body.tombstoneEndSeq,
              );
          } else if (op.eventType === 'THREAD_BLOCK') {
            this.applyThreadMeta(op.body.threadId, {
              blocked: op.body.blocked,
            });
          }
        }
        if (relationshipThreadIds.size > 0) {
          const persistedRelationshipThreads = (
            await this.webdb.getThreads()
          ).filter((thread) => relationshipThreadIds.has(thread.threadId));
          const persistedIds = new Set(
            persistedRelationshipThreads.map((thread) => thread.threadId),
          );
          const removedIds = new Set(
            [...relationshipThreadIds].filter(
              (threadId) => !persistedIds.has(threadId),
            ),
          );
          if (removedIds.size > 0) {
            this._items.update((threads) =>
              threads.filter((thread) => !removedIds.has(thread.threadId)),
            );
            const openThreadId = this._openThreadId();
            if (openThreadId !== undefined && removedIds.has(openThreadId))
              this._openThreadId.set(undefined);
            for (const threadId of removedIds) {
              this.pendingUnknownContentHeads.delete(threadId);
              this.lastSeenSeq.delete(threadId);
              this.serverLastReadSeq.delete(threadId);
              this.localStableReadSeq.delete(threadId);
            }
          }
          for (const thread of persistedRelationshipThreads) {
            this.upsertThread(thread);
            const pending = this.pendingUnknownContentHeads.get(
              thread.threadId,
            );
            if (pending) {
              this.pendingUnknownContentHeads.delete(thread.threadId);
              this.applyContentHeadToKnownThread(pending);
            }
          }
        }
        // Resolve group profile references only after relationship rows from this same page are
        // visible in memory, including a just-created group conversation.
        for (const update of groupMeta) {
          const reference = update.page.items
            .filter((item) => item.operation === 'GROUP_PROFILE')
            .at(-1);
          if (reference?.operation !== 'GROUP_PROFILE') continue;
          this.resolveThreadGroupProfile(
            update.threadId,
            update.page.account,
            update.sourceServer,
            reference.body.profileRev,
          );
        }
        if (relationshipIntentRevision !== undefined)
          this._drainRelationshipIntentRevision = Math.max(
            this._drainRelationshipIntentRevision ?? 0,
            relationshipIntentRevision,
          );
        const relationshipRequestRevision = (await this.webdb.getMeta(
          'relationshipRequestStateRevision',
        )) as number | undefined;
        if (typeof relationshipRequestRevision === 'number')
          this._drainRelationshipRequestRevision = Math.max(
            this._drainRelationshipRequestRevision ?? 0,
            relationshipRequestRevision,
          );
        this.userService.advanceStateFeedCursor(page.scannedThrough);
        if (isFullConsoleLoggingEnabled())
          console.debug(
            '[state-feed] committed page',
            JSON.stringify({
              after: cursor,
              scannedThrough: page.scannedThrough,
              hasMore: page.hasMore,
              groupThreadIds: groupMeta.map((update) => update.threadId),
            }),
          );
        if (page.hasMore)
          this._pendingTailFeedId = Math.max(
            this._pendingTailFeedId ?? targetFeedId,
            targetFeedId,
          );
        // The first notification for a transaction may carry the first of several allocated feed ids.
        // The response exposes the committed account HWM, so extend this same drain through it instead
        // of publishing an intermediate projection and waiting for the next SSE frame.
        if (page.stateFeedEndId > page.scannedThrough)
          this._pendingTailFeedId = Math.max(
            this._pendingTailFeedId ?? page.stateFeedEndId,
            page.stateFeedEndId,
          );
        else if (this._fullStateDrainTarget === targetFeedId)
          this._fullStateDrainTarget = undefined;
        pageCommitted = true;
      }
    } catch (error) {
      // State pages and the local cursor are one consistency boundary. Any
      // transport, validation, hydration, or durable-write failure aborts the
      // complete drain; queued tails are discarded and require a new HELLO or
      // lightweight state signal before another attempt.
      this._pendingTailFeedId = undefined;
      this._drainRelationshipIntentRevision = undefined;
      this._drainRelationshipRequestRevision = undefined;
      this.toast.warn(this.transloco.translate('errors.stateSyncFatal'), {
        duration: 'forever',
        interactive: true,
      });
      console.error(
        '[state-feed] processing aborted',
        error,
        JSON.stringify({
          after: cursor,
          through: targetFeedId,
          currentCursor: this.userService.stateFeedCursor(),
        }),
      );
    } finally {
      this._deltaInFlight = false;
      const tail = this._pendingTailFeedId;
      this._pendingTailFeedId = undefined;
      if (
        tail !== undefined &&
        tail > (this.userService.stateFeedCursor() ?? -Infinity)
      ) {
        void this.pullDelta(tail);
      } else if (pageCommitted) {
        // All pages and any coalesced tail are now durable. Consumers may safely re-read projections
        // without observing a half-applied relationship pair.
        if (this._drainRelationshipIntentRevision !== undefined)
          this.userService.applyRelationshipIntentStateRevision(
            this._drainRelationshipIntentRevision,
          );
        if (this._drainRelationshipRequestRevision !== undefined)
          this.userService.applyRelationshipRequestStateRevision(
            this._drainRelationshipRequestRevision,
          );
        this._drainRelationshipIntentRevision = undefined;
        this._drainRelationshipRequestRevision = undefined;
      }
    }
  }

  private applyStateProfile(
    item: Extract<
      import('./user.service').ClientStateFeedItem,
      { eventType: 'PROFILE' }
    >,
  ): void {
    item = localSubjectIdentity(item);
    const matchingGroups = this._items().filter(
      (thread): thread is GroupConversationItem =>
        thread.type === 'GROUP' &&
        thread.group.account === item.account &&
        thread.group.domain === item.domain &&
        thread.group.namespaceId === item.namespaceId &&
        thread.group.profileRev <= item.body.profileRev,
    );
    this._items.update((threads) =>
      threads.map((thread) => {
        if (
          thread.type === 'P2P' &&
          thread.peerProfileMessageSeq == null &&
          thread.peerUser.profileRev === item.body.profileRev &&
          thread.peerUser.account === item.account &&
          (thread.peerUser.domain ?? '') === item.domain &&
          thread.peerUser.namespaceId === item.namespaceId
        )
          return {
            ...thread,
            peerUser: {
              ...thread.peerUser,
              name: item.body.displayName,
              bio: item.body.bio,
              avatar: item.body.avatar ?? '',
              profileRev: item.body.profileRev,
            },
          };
        if (
          thread.type === 'GROUP' &&
          thread.group.account === item.account &&
          thread.group.domain === item.domain &&
          thread.group.namespaceId === item.namespaceId &&
          thread.group.profileRev <= item.body.profileRev
        )
          return {
            ...thread,
            group: {
              ...thread.group,
              name: item.body.displayName,
              avatar: item.body.avatar ?? '',
              description: item.body.bio,
              profileRev: item.body.profileRev,
            },
          };
        return thread;
      }),
    );
    for (const thread of matchingGroups)
      this.resolveThreadGroupProfile(
        thread.threadId,
        item.account,
        item.domain,
        item.body.profileRev,
      );
    for (const thread of this._items())
      if (
        thread.type === 'P2P' &&
        thread.peerUser.account === item.account &&
        thread.peerUser.domain === item.domain &&
        thread.peerUser.namespaceId === item.namespaceId
      )
        this.resolveThreadPeerProfile(thread);
  }

  private async prefetchGroupMeta(
    items: import('./user.service').ClientStateFeedItem[],
  ): Promise<import('./webdb.service').ClientGroupMetaApply[]> {
    const updates: import('./webdb.service').ClientGroupMetaApply[] = [];
    for (const entry of items) {
      const item =
        entry.eventType === 'GROUP_META_FEED_HEAD'
          ? localSubjectIdentity(entry)
          : entry;
      if (item.eventType !== 'GROUP_META_FEED_HEAD') continue;
      const thread = this.items().find(
        (candidate) =>
          candidate.type === 'GROUP' &&
          candidate.group.account === item.account &&
          candidate.group.domain === item.domain &&
          candidate.group.namespaceId === item.namespaceId,
      );
      const groupIntents = items.filter(
        (candidate) =>
          candidate.eventType === 'RELATIONSHIP_INTENT' &&
          ((candidate.account === item.account &&
            candidate.domain === item.domain) ||
            (candidate.subjectAccount === item.account &&
              candidate.subjectDomain === item.domain)),
      );
      const projectedThreadId = groupIntents
        .map((candidate) => candidate.body)
        .find(
          (body): body is import('./user.service').ClientGroupInviteIntent =>
            'threadId' in body && Number.isSafeInteger(body.threadId),
        )?.threadId;
      if (
        (!thread || thread.type !== 'GROUP') &&
        projectedThreadId === undefined
      )
        throw new Error(
          `group-meta head has no local thread: ${JSON.stringify({
            feedId: item.feedId,
            account: item.account,
            domain: item.domain,
            namespaceId: item.namespaceId,
            groupMetaFeedEndId: item.body.groupMetaFeedEndId,
            localGroups: this.items()
              .filter((candidate) => candidate.type === 'GROUP')
              .map((candidate) => ({
                threadId: candidate.threadId,
                account: candidate.group.account,
                domain: candidate.group.domain,
                namespaceId: candidate.group.namespaceId,
              })),
          })}`,
        );
      const threadId =
        thread?.type === 'GROUP' ? thread.threadId : projectedThreadId!;
      const current =
        thread?.type === 'GROUP' ? (thread.group.groupMetaFeedId ?? '0') : '0';
      if (BigInt(current) >= BigInt(item.body.groupMetaFeedEndId)) continue;
      const mode = current === '0' ? 'full' : 'delta';
      let after = current;
      let through: string | undefined;
      const pages: import('./user.service').ClientGroupMetaFeedPage[] = [];
      do {
        const requestedAfter = after;
        const response = await firstValueFrom(
          this.userService.queryGroupMeta({
            threadId,
            mode,
            after,
            take: 100,
            through,
          }),
        );
        if (response.code !== 0 || !response.data)
          throw new Error('group-meta pull failed');
        const page = response.data;
        if (
          page.items.some(
            (entry) =>
              entry.operation !== 'GROUP_PROFILE' &&
              (!entry.account ||
                !entry.domain ||
                !Number.isSafeInteger(entry.namespaceId) ||
                entry.namespaceId < 0),
          )
        )
          throw new Error(
            'group-meta member is missing its namespace-qualified identity',
          );
        through ??= page.groupMetaFeedEndId;
        if (
          page.mode !== mode ||
          page.account !== item.account ||
          BigInt(page.scannedThrough) < BigInt(after) ||
          BigInt(page.scannedThrough) > BigInt(through)
        )
          throw new Error('invalid group-meta page');
        pages.push(page);
        after = page.scannedThrough;
        if (!page.hasMore) break;
        if (page.scannedThrough === requestedAfter)
          throw new Error('group-meta pagination made no progress');
      } while (true);
      updates.push({
        threadId,
        sourceServer: item.domain,
        namespaceId: item.namespaceId,
        page: {
          account: item.account,
          mode,
          items: pages.flatMap((page) => page.items),
          scannedThrough: after,
          groupMetaFeedEndId: through!,
          hasMore: false,
        },
      });
    }
    return updates;
  }

  /** Paint cached previews immediately. After HELLO, also reconcile each content head through the
   * history source, since structural state-feed rows intentionally carry no message bodies. */
  private async hydratePreviews(refresh = false): Promise<void> {
    const epoch = this.previewEpoch;
    try {
      await this.hydratePreviewsFromCache(refresh);
    } catch (error) {
      console.warn('[cache-paint] cached message preview read failed', error);
      if (epoch === this.previewEpoch)
        await this.userService.requestCacheRebuild();
    }
  }

  private async hydratePreviewsFromCache(refresh: boolean): Promise<void> {
    const items = this._items();
    if (items.length === 0) return;
    const epoch = this.previewEpoch;
    if (refresh) for (const item of items) this.queuePreview(item);
    // One batched read (a single transaction, one reverse cursor per thread) — never N independent lookups.
    const newest = await this.messageRepo.getNewestMessages(
      items.map((it) => it.threadId),
    );
    if (epoch !== this.previewEpoch) return;
    if (newest.size === 0) return; // nothing cached locally yet — leave the items' previews as-is
    const byThread = new Map<
      number,
      {
        lastMessagePreview: string;
        lastMessageSenderId: string | null;
        lastMessagePreviewSeq: number;
      }
    >();
    for (const it of items) {
      const m = newest.get(it.threadId);
      if (!m) continue;
      byThread.set(it.threadId, {
        lastMessagePreview: rawPreview(m.contentType, m.content),
        lastMessagePreviewSeq: m.seq,
        lastMessageSenderId: this.creatorKeyForThread(m.creator, it),
      });
    }
    if (byThread.size === 0) return;
    let changed = false;
    const hydrated = this._items().map((it) => {
      const patch = byThread.get(it.threadId);
      if (
        !patch ||
        (it.lastMessagePreviewSeq ?? 0) > patch.lastMessagePreviewSeq ||
        (it.lastMessagePreview === patch.lastMessagePreview &&
          it.lastMessageSenderId === patch.lastMessageSenderId)
      ) {
        return it;
      }
      changed = true;
      return { ...it, ...patch };
    });
    // Boot can request hydration from cache-paint, HELLO and the missed walk. Do not emit an identical
    // array for each request: on Android every emission rebinds the WebView rows and makes previews flicker.
    if (!changed) return;
    this._items.set(hydrated);
    // Persist so the next boot's cached paint already carries the derived preview (no "暂无消息" flash).
    void this.persistThreads(hydrated);
  }

  /** Content heads carry coordinates only. Fetch one source item to populate a cold or stale preview,
   * with bounded concurrency and one request per observed content revision. */
  private queuePreview(item: ConversationItem): void {
    if (!(item.lastMessageSeq && item.lastMessageSeq > 0)) return;
    const revision = `${item.lastMessageSeq}:${item.tombstoneEndSeq ?? 0}`;
    if (this.previewRevisions.get(item.threadId) === revision) return;
    this.previewRevisions.set(item.threadId, revision);
    this.previewQueue.add(item.threadId);
    queueMicrotask(() => this.drainPreviews());
  }

  private drainPreviews(): void {
    while (this.previewWorkers < 4 && this.previewQueue.size) {
      const threadId = this.previewQueue.values().next().value!;
      this.previewQueue.delete(threadId);
      this.previewWorkers++;
      const epoch = this.previewEpoch;
      const revision = this.previewRevisions.get(threadId);
      const lifetime = this.webdb.captureMessageLifetime();
      void (async () => {
        try {
          const demand = { kind: 'latest' as const, count: 1 };
          const result = isTauri()
            ? await this.messageRepo.queryNativeMessageHistory(threadId, demand)
            : await this.messageRepo.queryBrowserMessageHistory(
                threadId,
                demand,
              );
          if (
            epoch !== this.previewEpoch ||
            lifetime.aborted ||
            this.previewRevisions.get(threadId) !== revision
          )
            return;
          if (result.failed) {
            this.previewRevisions.delete(threadId);
            return;
          }
          const latest = result.items.at(-1);
          const message =
            latest?.kind === 'message' ? latest.message : undefined;
          // A missing body or a server gap does not replace the last usable preview. Leave cold
          // rows blank, and allow a later content notification or reconnect to retry this revision.
          if (!message) {
            this.previewRevisions.delete(threadId);
            return;
          }
          this._items.update((items) =>
            items.map((current) => {
              if (current.threadId !== threadId) return current;
              const updated = {
                ...current,
                lastMessagePreview: rawPreview(
                  message.contentType,
                  message.content,
                ),
                lastMessagePreviewSeq: message.seq,
                lastMessageSenderId: this.creatorKeyForThread(
                  message.creator,
                  current,
                ),
                lastMessageAt: message.createdAt,
              };
              void this.persistThread(updated);
              return updated;
            }),
          );
        } catch {
          if (
            epoch === this.previewEpoch &&
            this.previewRevisions.get(threadId) === revision
          )
            this.previewRevisions.delete(threadId);
        } finally {
          this.previewWorkers--;
          this.drainPreviews();
        }
      })();
    }
  }

  private creatorKeyForThread(
    creator: Message['creator'],
    thread: ConversationItem,
  ): string | null {
    if (creator === null) return null;
    return messagePreviewSenderKey(creator);
  }

  // ── IDB persistence helpers (best-effort; IDB unavailable → graceful no-op) ────────────────

  /** Read all cached threads from IDB. Their durable content heads are replayed by ClientStateFeed; keep
   * the fixed/non-fixed boundary here, without reconstructing order from wall-clock timestamps. */
  private async readCachedThreads(): Promise<ConversationItem[]> {
    const all = await this.webdb.getThreads();
    const storedOrder = await this.webdb.getMeta('threadListOrder');
    const ids = Array.isArray(storedOrder)
      ? storedOrder.filter(
          (id): id is number => Number.isSafeInteger(id) && id > 0,
        )
      : [];
    const rank = new Map(ids.map((id, index) => [id, index]));
    const restored = all
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (rank.get(a.item.threadId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.item.threadId) ?? Number.MAX_SAFE_INTEGER) ||
          a.index - b.index,
      )
      .map(({ item }) => item);
    return stablePinnedTiers(restored);
  }

  private persistThreadOrder(items = this._items()): Promise<void> {
    return this.webdb.putMeta(
      'threadListOrder',
      items.map((item) => item.threadId),
    );
  }

  /** Rewrite the whole `threads` store from a snapshot (clear + put all, in one transaction). */
  private async persistThreads(items: ConversationItem[]): Promise<void> {
    try {
      await this.webdb.replaceThreads(items);
    } catch {
      /* IDB unavailable / closed — cache is best-effort */
    }
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

  /** Write an embedded peer/group profile through the profile store (drives avatar refresh on path change). */
  private writePeerProfile(u: User): void {
    void this.profileRepo.putProfile(`u${u.id}`, 'user', {
      id: u.id,
      name: u.name,
      account: u.account,
      avatar: u.avatar,
      bio: u.bio,
      domain: u.domain,
      sourceServer: u.domain,
      namespaceId: u.namespaceId,
      profileRev: u.profileRev,
    });
  }
  private writeGroupProfile(g: {
    id: number;
    account: string;
    domain: string;
    namespaceId: number;
    name: string;
    avatar: string;
    description: string;
    profileRev: number;
  }): void {
    void this.profileRepo.putProfile(`g${g.id}`, 'group', {
      id: g.id,
      name: g.name,
      account: g.account,
      avatar: g.avatar,
      bio: g.description,
      domain: g.domain,
      sourceServer: g.domain,
      namespaceId: g.namespaceId,
      profileRev: g.profileRev,
    });
  }
}

// ── SSE payload shapes (the subset of fields each handler reads) ─────────────────────────────

/** HELLO (SSE connect handshake) payload — pushed once per connect, the sole boot-critical state the
 *  client cannot derive locally: the caller's userId (opens the per-user IDB), the current state-feed end,
 *  and the self-profile version (which gates the /user/my-profile fetch). */
interface HelloPayload {
  userId?: number;
  stateFeedEndId: number;
  readRevision?: number;
  profileRev?: number;
}

interface ThreadMetaPayload {
  threadId?: number;
  muted?: boolean;
  pinned?: boolean;
  pinnedAt?: number | null;
  blocked?: boolean;
  alias?: string | null;
}

/** Derive the RAW list preview by content type — the UN-localized form stored on the item. PURE_TEXT
 *  yields the message text; media types yield a closed set of English markers (`[Photo]`, `[Group invite]`,
 *  …) that exactly match the backend's `derivePreview` AND the view's `PREVIEW_MARKERS` map, so the view
 *  ({@link ThreadListComponent.previewText}) localizes them at render time. Pure: no i18n dependency. */
export function rawPreview(contentType: string, content: string): string {
  return deriveMessagePreview(contentType, content, toDisplayText);
}

/** Return a new array with the first item matching `threadId` moved to index 0 (no-op if absent/first). */
function moveToTop<T extends { threadId: number }>(
  items: T[],
  threadId: number,
): T[] {
  const idx = items.findIndex((t) => t.threadId === threadId);
  if (idx <= 0) return items;
  const next = items.slice();
  const [moved] = next.splice(idx, 1);
  next.unshift(moved);
  return next;
}

/** Keep fixed threads ahead of ordinary threads without changing either tier's event-maintained order. */
function stablePinnedTiers<T extends { pinned: boolean }>(items: T[]): T[] {
  return [
    ...items.filter((item) => item.pinned),
    ...items.filter((item) => !item.pinned),
  ];
}

/** Move an ordinary thread to the head of the ordinary tier. Fixed threads never move on activity. */
function moveToTierTop<T extends { threadId: number; pinned: boolean }>(
  items: T[],
  threadId: number,
): T[] {
  const index = items.findIndex((item) => item.threadId === threadId);
  if (index < 0 || items[index].pinned) return items;
  const pinnedCount = items.findIndex((item) => !item.pinned);
  const target = pinnedCount < 0 ? items.length - 1 : pinnedCount;
  if (index === target) return items;
  const next = items.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}
