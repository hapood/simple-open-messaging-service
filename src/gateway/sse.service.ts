import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { ServerResponse } from 'http';
import { initSseResponse, formatSseFrame } from '../common/sse-stream.js';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { account, account as userTable } from '../database/schema.js';
import { CallStateRegistry } from './call-state.registry.js';
import { AccountFeedThrottle } from '../common/account-feed-throttle.js';

/** One held SSE connection: the raw response, its heartbeat timer, the establishment time, and the
 *  session-token row id — so a single revoked session can be targeted for FORCE_LOGOUT without kicking the
 *  user's other devices (see onSessionRevoked). */
interface SseClient {
  res: ServerResponse;
  ping: NodeJS.Timeout;
  since: number;
  sessionId: number;
}

/**
 * SSE (Server-Sent Events) downstream push service: push-only, no business uplink.
 *
 * Compared to WebSocket, SSE is a dedicated one-way push channel with native browser resumption
 * (Last-Event-ID) and controllable reconnection via fetch-event-source, which removes a whole class
 * of connection/reconnect/auth complexity at the root.
 *
 * One registry, `clients`, keyed by userId (a user may have multiple live connections — multiple
 * tabs/devices — in an array): the primary session stream (GET /events) carrying wake-ups and
 * ephemeral call coordination, with `res.on('close')` cleanup. (The former
 * separate notification-stream registry + its scoped notification token were removed — the Android
 * foreground service now consumes `/events` directly via the Kotlin-owned connection.)
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly clients: Record<number, SseClient[]> = {};
  private readonly stateThrottle = new AccountFeedThrottle(
    1000,
    (userId, feedId) =>
      this.pushToUser(userId, 'STATE_FEED_UPDATED', { feedId }),
    (error) => this.logger.warn(`State SSE hint failed: ${String(error)}`),
  );
  private readonly threadThrottle = new AccountFeedThrottle(
    1000,
    (userId, threadFeedEndId) =>
      this.pushToUser(userId, 'THREAD_FEED_UPDATED', { threadFeedEndId }),
    (error) => this.logger.warn(`Thread SSE hint failed: ${String(error)}`),
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly callState: CallStateRegistry,
  ) {}

  /**
   * Register one SSE connection (GET /events): the SSE headers, the `: connected` flush, and the 25s
   * named-ping heartbeat are in common/sse-stream.ts (one source of truth — the same wire format the
   * admin log viewer and the consumer sse.worker.ts use). This keeps the per-user registry insertion
   * + the close cleanup. Auth is already done by the route's guard before reaching this service
   * (SessionAuthGuard), so this only pushes. `origin` is the request Origin, forwarded so the hijacked raw
   * response carries its CORS header.
   */
  register(
    userId: number,
    sessionId: number,
    res: ServerResponse,
    origin?: string,
  ): void {
    const ping = initSseResponse(res, origin);

    const entry: SseClient = { res, ping, since: Date.now(), sessionId };
    (this.clients[userId] ??= []).push(entry);

    res.on('close', () => {
      clearInterval(ping);
      const list = this.clients[userId];
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete this.clients[userId];
    });

    // The connect handshake carries account revision snapshots. Durable message gaps are recovered from the
    // per-user feed, so HELLO does not carry a message cursor.
    void this.sendHello(userId, entry);
  }

  /** Whether this exact authenticated device session currently owns a live SSE connection. */
  isSessionOnline(userId: number, sessionId: number): boolean {
    return !!this.clients[userId]?.some(
      (client) => client.sessionId === sessionId,
    );
  }

  /** Push the HELLO handshake to one connection (the just-registered one). Best-effort: a racing close or a
   *  DB failure is swallowed (never throws on the connect path). */
  private async sendHello(userId: number, entry: SseClient): Promise<void> {
    try {
      const [user] = await this.database.db
        .select({
          stateFeedEndId: account.stateFeedEndId,
          threadFeedEndId: account.threadFeedEndId,
          profileRev: userTable.defaultProfileRev,
        })
        .from(account)
        .where(eq(account.id, userId))
        .limit(1);
      const frame = formatSseFrame('HELLO', {
        // The caller's userId. The session token is OPAQUE (server-side lookup only), so the client cannot
        // learn its userId without an authenticated response — HELLO is it. The client opens its per-user
        // IDB store on this userId (previously the /user/my-profile fetch was load-bearing for that, which
        // made the fetch un-skippable). Carrying it here lets the webdb open at connect time, independent
        // of the profile fetch.
        userId,
        // The state delta cursor. The client delta-replays (0, this] on first HELLO, then
        // The client pulls (cursor, stateFeedEndId] after this handshake and later feed signals.
        stateFeedEndId: user?.stateFeedEndId ?? 0,
        threadFeedEndId: user?.threadFeedEndId ?? 0,
        // The self-profile version. The client skips the cold-start /user/my-profile fetch when its IDB-
        // cached profileRev matches this (it already has the fresh name/avatar/bio). First-ever boot (no
        // cache) or a changed rev still fetches. PROFILE deltas advance the same state revision.
        profileRev: user?.profileRev ?? 0,
        // The user's active call (or null). Lets a reconnecting / freshly-booted client reconcile: a device
        // offline when the call's CALL_EVENT frames fired learns "I'm in a call with X" here. The native
        // FSM (driven by CALL_EVENT) is the live authority; this is the connect-time snapshot, mirrored by
        // CallsService. Null when no call OR after the call ended (cleared on terminal).
        activeCall: this.callState.get(userId),
      });
      if (!entry.res.writableEnded) entry.res.write(frame);
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
    const uids = Object.keys(this.clients).map(Number);
    const clients = uids.map((uid) => {
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

  /**
   * Write one frame to all of a user's live connections. Reverse iteration + cleaning up failed/broken
   * connections inline so a dead connection cannot abort the fan-out; backpressure (write returns
   * false) is not handled here — left for the next frame / heartbeat to detect the drop. When the
   * user's connection list empties, its slot is deleted.
   */
  private pushToUser(userId: number, eventName: string, data: unknown): void {
    const list = this.clients[userId];
    if (!list || list.length === 0) return;
    const frame = formatSseFrame(eventName, data);
    for (let i = list.length - 1; i >= 0; i--) {
      const { res } = list[i];
      try {
        if (!res.write(frame)) {
          // Backpressure: write buffer full; not handled here (the next frame / heartbeat will detect
          // the drop). Keep the connection; do not actively end.
        }
      } catch {
        // Connection is broken: clean up this entry so a later forEach doesn't throw and abort the fan-out.
        clearInterval(list[i].ping);
        list.splice(i, 1);
      }
    }
    if (list.length === 0) delete this.clients[userId];
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

  onProfileResolved(
    userId: number,
    data: { requestId: string; profile: unknown },
  ) {
    this.pushToUser(userId, 'PROFILE_RESOLVED', data);
  }

  onQuoteResolution(
    userId: number,
    event: 'QUOTE_RESOLVED' | 'QUOTE_FAILED',
    data: unknown,
  ) {
    this.pushToUser(userId, event, data);
  }

  onProfileFailed(
    userId: number,
    data: {
      requestId: string;
      reason: 'NOT_FOUND' | 'NOT_DISCLOSED' | 'TEMPORARILY_UNAVAILABLE';
    },
  ) {
    this.pushToUser(userId, 'PROFILE_FAILED', data);
  }

  /** Coalesce durable state feed hints per account, independently of thread hints. */
  onStateFeedUpdated(userId: number, data: { feedId: number }) {
    this.stateThrottle.enqueue(userId, data.feedId);
  }

  /** Thread projection cursor only. The durable, compacted feed owns the item body. */
  onThreadFeedUpdated(userId: number, data: { threadFeedEndId: number }) {
    this.threadThrottle.enqueue(userId, data.threadFeedEndId);
  }

  /** Send a FORCE_LOGOUT frame and end each connection, clearing its heartbeat. The caller removes the
   *  entries from the registry (the broadcast deletes the whole user slot; the per-session path splices
   *  just the matching entries). Idempotent per-connection — a half-closed socket is already gone.
   *  formatSseFrame keeps the wire shape identical to the client's SSE_EVENT_FORCE_LOGOUT handler. */
  private forceLogout(entries: SseClient[], reason: string): void {
    const frame = formatSseFrame('FORCE_LOGOUT', {
      event: 'FORCE_LOGOUT',
      status: 0,
      message: reason,
    });
    for (const { res, ping } of entries) {
      clearInterval(ping);
      try {
        res.write(frame);
        res.end();
      } catch {}
    }
  }

  /** All-device logout / password change / force-kick: push FORCE_LOGOUT then immediately drop ALL of
   *  the user's live connections. */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const list = this.clients[payload.userId];
    if (list) this.forceLogout(list, payload.reason);
    delete this.clients[payload.userId];
  }

  /** Single-session revoke (the "revoke this device" action from the device list): push FORCE_LOGOUT to +
   *  end ONLY that session's connection(s), leaving the user's other devices online. A device may hold
   *  several connections (multiple tabs sharing one session token) — all are disconnected, since they all
   *  ride the now-revoked credential. Splices the matching entries out and drops the user slot if empty. */
  @OnEvent('auth.session-revoked')
  onSessionRevoked(payload: {
    userId: number;
    sessionId: number;
    reason: string;
  }) {
    const list = this.clients[payload.userId];
    if (!list || list.length === 0) return;
    const revoked = list.filter((c) => c.sessionId === payload.sessionId);
    if (revoked.length === 0) return;
    this.forceLogout(revoked, payload.reason);
    const survivors = list.filter((c) => c.sessionId !== payload.sessionId);
    if (survivors.length === 0) delete this.clients[payload.userId];
    else this.clients[payload.userId] = survivors;
  }

  /** End held responses so HTTP shutdown does not wait indefinitely for SSE clients. */
  onModuleDestroy() {
    this.stateThrottle.stop();
    this.threadThrottle.stop();
    for (const uid of Object.keys(this.clients)) {
      const id = Number(uid);
      const clients = this.clients[id];
      // Detach before closing: close callbacks must not mutate the iteration.
      delete this.clients[id];
      for (const { res, ping } of clients) {
        clearInterval(ping);
        try {
          res.end();
        } catch {
          // A broken connection must not prevent the remaining streams from closing.
        }
      }
    }
  }
}
