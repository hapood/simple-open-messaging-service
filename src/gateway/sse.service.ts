import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import type { MessageEvent } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';
import { serializeBody } from '../common/serialize.interceptor.js';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account,
  account as userTable,
  sessionToken,
} from '../database/schema.js';
import { CallStateRegistry } from './call-state.registry.js';
import { AccountFeedThrottle } from '../common/account-feed-throttle.js';

/** One subscribed event stream and its authenticated session identity. */
interface SseClient {
  sink: Subscriber<MessageEvent>;
  since: number;
  sessionId: number;
  sseUuid: string;
}

/**
 * SSE (Server-Sent Events) downstream push service: push-only, no business uplink.
 *
 * SSE is a one-way push channel. Clients explicitly reconnect and reconcile durable feed cursors;
 * generated wire IDs are not used as history cursors.
 *
 * One registry, `clients`, keyed by userId (a user may have multiple live connections — multiple
 * tabs/devices — in an array): the primary session stream (GET /events) carrying wake-ups and
 * ephemeral call coordination, with Observable teardown on disconnect. (The former
 * separate notification-stream registry + its scoped notification token were removed — the Android
 * foreground service now consumes `/events` directly via the Kotlin-owned connection.)
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly clients: Record<number, SseClient[]> = {};
  private readonly clientsBySession = new Map<number, SseClient>();
  private readonly notificationHeads = new Map<number, number>();
  private readonly receipts = new Map<
    number,
    {
      userId: number;
      sseUuid: string;
      issuedHeads: Map<number, number>;
      confirmedHead: number;
      confirmedAt: number;
    }
  >();
  private readonly receiptCleanup = setInterval(
    () => this.pruneReceipts(),
    60_000,
  ).unref();
  private readonly stateThrottle = new AccountFeedThrottle(
    1000,
    (userId, feedId) =>
      this.pushToUser(userId, 'STATE_FEED_UPDATED', { feedId }),
    (error) => this.logger.warn(`State SSE hint failed: ${String(error)}`),
  );
  private readonly threadThrottle = new AccountFeedThrottle(
    1000,
    (userId, threadFeedEndId) => this.pushThreadFeed(userId, threadFeedEndId),
    (error) => this.logger.warn(`Thread SSE hint failed: ${String(error)}`),
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly callState: CallStateRegistry,
  ) {}

  /** Nest subscribes after guards succeed and unsubscribes when the HTTP connection closes. */
  register(userId: number, sessionId: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sink) => {
      // A device session owns exactly one stream. Complete the old Observable;
      // its identity-based teardown removes only that entry, never the new one.
      for (const old of [...(this.clients[userId] ?? [])]) {
        if (old.sessionId === sessionId) {
          // The old client must not reconnect automatically and evict the new
          // connection in a loop (e.g. two tabs sharing one session cookie).
          this.emit(old.sink, 'SSE_REPLACED', {});
          old.sink.complete();
        }
      }
      const sseUuid = randomUUID();
      const previous = this.receipts.get(sessionId);
      this.receipts.set(sessionId, {
        userId,
        sseUuid,
        issuedHeads: new Map(),
        confirmedHead:
          previous?.userId === userId ? previous.confirmedHead : -1,
        confirmedAt: previous?.userId === userId ? previous.confirmedAt : 0,
      });
      const entry: SseClient = { sink, since: Date.now(), sessionId, sseUuid };
      (this.clients[userId] ??= []).push(entry);
      this.clientsBySession.set(sessionId, entry);
      // HELLO captures the feed heads; a reconnect catches up from persisted cursors.
      void this.sendHello(userId, entry);
      return () => {
        const list = this.clients[userId];
        if (!list) return;
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
        if (this.clientsBySession.get(sessionId) === entry)
          this.clientsBySession.delete(sessionId);
        if (list.length === 0) delete this.clients[userId];
      };
    });
  }

  private emit(
    sink: Subscriber<MessageEvent>,
    type: string,
    data: unknown,
  ): void {
    if (!sink.closed) sink.next({ type, data: serializeBody(data) as object });
  }

  /** Whether this exact authenticated device session currently owns a live SSE connection. */
  isSessionOnline(userId: number, sessionId: number): boolean {
    return !!this.clients[userId]?.some(
      (client) => client.sessionId === sessionId,
    );
  }

  /** Mark receipt-eligible heads on the existing one-second feed hint. */
  private pushThreadFeed(userId: number, threadFeedEndId: number): void {
    const relevant = this.notificationHeads.has(userId);
    this.notificationHeads.delete(userId);
    for (const client of this.clients[userId] ?? []) {
      const slot = this.receipts.get(client.sessionId);
      const receiptEligible =
        relevant && !client.sink.closed && slot?.sseUuid === client.sseUuid;
      if (receiptEligible)
        slot.issuedHeads.set(threadFeedEndId, Date.now() + 30_000);
      this.emit(client.sink, 'THREAD_FEED_UPDATED', {
        threadFeedEndId,
        ...(receiptEligible ? { sseUuid: client.sseUuid } : {}),
      });
    }
  }

  /** A receipt must identify this session's current stream and a head it emitted. */
  async confirmThreadReceipt(
    userId: number,
    sessionId: number,
    sseUuid: string,
    threadFeedEndId: number,
  ): Promise<boolean> {
    const slot = this.receipts.get(sessionId);
    if (
      slot?.userId !== userId ||
      slot.sseUuid !== sseUuid ||
      !Number.isInteger(threadFeedEndId) ||
      (slot.issuedHeads.get(threadFeedEndId) ?? 0) <= Date.now()
    )
      return false;
    slot.confirmedHead = Math.max(slot.confirmedHead, threadFeedEndId);
    slot.confirmedAt = Date.now();
    return true;
  }

  /** Only a receipt issued to this device session suppresses its current message wake. */
  confirmedThreadHead(userId: number, sessionId: number): number {
    const slot = this.receipts.get(sessionId);
    return slot?.userId === userId && slot.confirmedAt > Date.now() - 60_000
      ? slot.confirmedHead
      : -1;
  }

  private pruneReceipts(): void {
    const now = Date.now();
    for (const [sessionId, slot] of this.receipts) {
      for (const [head, expiresAt] of slot.issuedHeads) {
        if (expiresAt <= now) slot.issuedHeads.delete(head);
      }
      if (
        slot.issuedHeads.size === 0 &&
        slot.confirmedAt <= now - 60_000 &&
        !this.isSessionOnline(slot.userId, sessionId)
      )
        this.receipts.delete(sessionId);
    }
  }

  /** Push the HELLO handshake to one connection (the just-registered one). Best-effort: a racing close or a
   *  DB failure is swallowed (never throws on the connect path). */
  private async sendHello(userId: number, entry: SseClient): Promise<void> {
    try {
      const [user] = await this.database.db
        .select({
          stateFeedEndId: account.clientStateFeedEndId,
          threadFeedEndId: account.threadFeedEndId,
          profileRev: userTable.defaultProfileRev,
          pushSubscriptionRev: sessionToken.pushSubscriptionRev,
        })
        .from(account)
        .innerJoin(sessionToken, eq(sessionToken.userId, account.id))
        .where(
          and(eq(account.id, userId), eq(sessionToken.id, entry.sessionId)),
        )
        .limit(1);
      const data = {
        // The caller's userId. The session token is OPAQUE (server-side lookup only), so the client cannot
        // learn its userId without an authenticated response — HELLO is it. The client opens its per-user
        // IDB store on this userId (previously the /user/my-profile fetch was load-bearing for that, which
        // made the fetch un-skippable). Carrying it here lets the webdb open at connect time, independent
        // of the profile fetch.
        userId,
        sessionId: entry.sessionId,
        pushSubscriptionRev: user?.pushSubscriptionRev,
        // The state delta cursor. The client delta-replays (0, this] on first HELLO, then
        // The client pulls (cursor, stateFeedEndId] after this handshake and later feed signals.
        stateFeedEndId: user?.stateFeedEndId ?? 0,
        threadFeedEndId: user?.threadFeedEndId ?? 0,
        // The self-profile version. The client skips the cold-start /user/my-profile fetch when its IDB-
        // cached profileRev matches this (it already has the fresh name/avatar/bio). First-ever boot (no
        // cache) or a changed rev still fetches.
        profileRev: user?.profileRev ?? 0,
        // The user's active call (or null). Lets a reconnecting / freshly-booted client reconcile: a device
        // offline when the call's CALL_EVENT frames fired learns "I'm in a call with X" here. The native
        // FSM (driven by CALL_EVENT) is the live authority; this is the connect-time snapshot, mirrored by
        // CallsService. Null when no call OR after the call ended (cleared on terminal).
        activeCall: this.callState.get(userId),
      };
      this.emit(entry.sink, 'HELLO', data);
    } catch (e) {
      // HELLO is load-bearing: client state cannot synchronize without its stateFeedEndId.
      // 0..rev). A send failure must therefore be OBSERVABLE, not silently swallowed — the connection still
      // establishes, and the client's HELLO-timeout will force a reconnect that re-pushes HELLO.
      this.logger.error(`HELLO handshake failed for user ${userId}`, e);
    }
  }

  /**
   * Read-only snapshot of live SSE connections (for the admin console to observe).
   * Aggregated per user: one user with multiple tabs → multiple connections merged into one entry,
   * `since` being the earliest establishment time. Contains no sensitive data (no token, no IP) — only
   * userId + connection count + establishment time.
   */
  snapshot(): {
    total: number;
    uniqueUsers: number;
    clients: { userId: number; connections: number; since: number }[];
  } {
    const clients = Object.keys(this.clients)
      .map(Number)
      .map((uid) => {
        const list = this.clients[uid];
        return {
          userId: uid,
          connections: list.length,
          since: list.reduce((min, c) => Math.min(min, c.since), Date.now()),
        };
      });
    clients.sort((a, b) => a.since - b.since);
    return {
      total: clients.reduce((sum, c) => sum + c.connections, 0),
      uniqueUsers: clients.length,
      clients,
    };
  }

  /** Publish to subscribed streams; Nest serializes events and handles stream backpressure. */
  onPushSubscriptionChanged(
    userId: number,
    sessionId: number,
    pushSubscriptionRev: number,
  ): void {
    for (const client of this.clients[userId] ?? []) {
      if (client.sessionId === sessionId) {
        this.emit(client.sink, 'PUSH_SUBSCRIPTION_CHANGED', {
          sessionId,
          pushSubscriptionRev,
        });
      }
    }
  }

  private pushToUser(userId: number, eventName: string, data: unknown): void {
    for (const client of this.clients[userId] ?? []) {
      this.emit(client.sink, eventName, data);
    }
  }

  /** Push a profile wake only to the live stream owned by this session. */
  private pushToSession(
    sessionId: number,
    eventName: string,
    data: unknown,
  ): void {
    const client = this.clientsBySession.get(sessionId);
    if (!client || client.sink.closed) return;
    this.emit(client.sink, eventName, data);
  }

  /** 1:1 WebRTC call LIFECYCLE notification — incoming ring / accepted / declined / cancelled / ended /
   *  missed. A call is ephemeral coordination rather than persisted content, so its descriptor rides
   *  inline. The addressed user's online
   *  connections all receive it; the caller (CallsService) emits one frame per user. No message-cursor
   *  id (a call event is not a resumable history cursor). */
  onCallEvent(userId: number, data: unknown) {
    this.pushToUser(userId, 'CALL_EVENT', data);
  }

  /** 1:1 WebRTC SIGNALING relay — SDP offer/answer, ICE candidates, and camera state. Ephemeral
   *  by nature: never persisted, never replayed (a missed ICE candidate is simply lost; the client
   *  re-gathers). Carried inline for the same reason as onCallEvent. The server is a pure relay — it
   *  never inspects or stores the WebRTC payload, only forwards it to the addressed peer. */
  onCallSignal(userId: number, data: unknown) {
    this.pushToUser(userId, 'CALL_SIGNAL', data);
  }

  /**
   * A federated media message finished localizing. Signal-only state flip: the recipient sets that
   * message's mediaStatus after a committed materialization transition, then re-renders every mounted
   * consumer of that message. No message-cursor id: reconnecting clients reconcile their registered
   * messages through the status query.
   */
  onMediaStatus(
    userId: number,
    data: {
      threadId: number;
      seq: number;
      status: 'pending' | 'downloading' | 'ready' | 'failed';
    },
  ) {
    this.pushToUser(userId, 'MEDIA_STATUS', data);
  }

  onProfileAvailable(
    sessionId: number,
    key: {
      namespaceId: number;
      account: string;
      domain: string;
      rev: number;
    },
  ): void {
    this.pushToSession(sessionId, 'PROFILE_AVAILABLE', key);
  }

  onQuoteResolution(
    userId: number,
    event: 'QUOTE_RESOLVED' | 'QUOTE_FAILED',
    data: unknown,
  ) {
    this.pushToUser(userId, event, data);
  }

  onProfileUnavailable(
    sessionId: number,
    data: {
      namespaceId: number;
      account: string;
      domain: string;
      rev: number;
      reason: 'NOT_FOUND' | 'NOT_DISCLOSED' | 'TEMPORARILY_UNAVAILABLE';
    },
  ): void {
    this.pushToSession(sessionId, 'PROFILE_UNAVAILABLE', data);
  }

  /** Coalesce durable state feed hints per account, independently of thread hints. */
  onStateFeedUpdated(userId: number, data: { feedId: number }) {
    this.stateThrottle.enqueue(userId, data.feedId);
  }

  /** Thread projection cursor only. The durable, compacted feed owns the item body. */
  onThreadFeedUpdated(
    userId: number,
    data: { threadFeedEndId: number; notificationRelevant?: boolean },
  ) {
    if (data.notificationRelevant)
      this.notificationHeads.set(userId, data.threadFeedEndId);
    this.threadThrottle.enqueue(userId, data.threadFeedEndId);
  }

  /** Finish the selected streams after sending the logout event. Completion triggers registry teardown. */
  private forceLogout(entries: SseClient[], reason: string): void {
    for (const { sink } of [...entries]) {
      this.emit(sink, 'FORCE_LOGOUT', {
        event: 'FORCE_LOGOUT',
        status: 0,
        message: reason,
      });
      sink.complete();
    }
  }

  /** All-device logout / password change / force-kick: complete every subscribed stream. */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const list = this.clients[payload.userId];
    if (list) this.forceLogout(list, payload.reason);
  }

  /** Revoke only the selected session; multiple tabs can share one credential. */
  @OnEvent('auth.session-revoked')
  onSessionRevoked(payload: {
    userId: number;
    sessionId: number;
    reason: string;
  }) {
    const list = this.clients[payload.userId];
    if (!list || list.length === 0) return;
    const revoked = list.filter((c) => c.sessionId === payload.sessionId);
    if (revoked.length > 0) this.forceLogout(revoked, payload.reason);
  }

  /** Complete held streams so HTTP shutdown does not wait for SSE clients. */
  onModuleDestroy() {
    clearInterval(this.receiptCleanup);
    this.receipts.clear();
    this.clientsBySession.clear();
    this.notificationHeads.clear();
    this.stateThrottle.stop();
    this.threadThrottle.stop();
    for (const list of Object.values(this.clients)) {
      for (const { sink } of [...list]) sink.complete();
    }
  }
}
