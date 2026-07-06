import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { ServerResponse } from 'http';

/**
 * Group-lifecycle SSE event names. Carried on every group frame so the frontend dispatches by
 * event name (matching NEW_MESSAGE / FORCE_LOGOUT). Payload shape (the `data` field) is common:
 *   { groupId, threadId, ...event-specific fields, byUserId? }
 * The frontend refreshes the roster / conversation list on receipt (Phase 4).
 */
export type GroupSseEvent =
  | 'GROUP_MEMBER_JOINED'
  | 'GROUP_MEMBER_LEFT'
  | 'GROUP_MEMBER_KICKED'
  | 'GROUP_ROLE_CHANGED'
  | 'GROUP_UPDATED';

export const GROUP_SSE: Record<GroupSseEvent, GroupSseEvent> = {
  GROUP_MEMBER_JOINED: 'GROUP_MEMBER_JOINED',
  GROUP_MEMBER_LEFT: 'GROUP_MEMBER_LEFT',
  GROUP_MEMBER_KICKED: 'GROUP_MEMBER_KICKED',
  GROUP_ROLE_CHANGED: 'GROUP_ROLE_CHANGED',
  GROUP_UPDATED: 'GROUP_UPDATED',
};

/** One held SSE connection: the raw response, its heartbeat timer, and the establishment time. */
interface SseClient {
  res: ServerResponse;
  ping: NodeJS.Timeout;
  since: number;
}

/**
 * SSE (Server-Sent Events) downstream push service: push-only, no business uplink.
 *
 * Compared to WebSocket, SSE is a dedicated one-way push channel with native browser resumption
 * (Last-Event-ID) and controllable reconnection via fetch-event-source, which removes a whole class
 * of connection/reconnect/auth complexity at the root.
 *
 * Two parallel registries are maintained, both keyed by userId (a user may have multiple live
 * connections — multiple tabs/devices — in an array):
 *  - `clients`     : the primary session stream (GET /events, access-token auth) — full NEW_MESSAGE
 *                    payloads + group/read-cursor events for the in-app UI. `res.on('close')` cleanup.
 *  - `notifClients`: the notification stream (GET /notifications/stream, scoped notification-token
 *                    auth) — consumed by the Android foreground service. Pushes a coalesced
 *                    `NOTIF_SYNC` snapshot (the /notifications/missed shape) so the FGS can render ONE
 *                    away-notification statelessly (last snapshot wins).
 * The connect/push mechanics are identical, so both share `attach()`/`writeTo()`.
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  /** Heartbeat interval (must be < Nginx's default proxy_read_timeout of 60s). The `: ping` comment line is not treated as an event by the frontend. */
  private static readonly HEARTBEAT_MS = 25000;
  private readonly clients: Record<number, SseClient[]> = {};
  private readonly notifClients: Record<number, SseClient[]> = {};

  /**
   * Connect plumbing shared by the primary stream and the notification stream: write the streaming
   * response headers (X-Accel-Buffering:no tells Nginx not to buffer, otherwise frames would be
   * batched and delivered late), flush a `: connected` comment so the client's onopen fires
   * immediately, start the heartbeat, and register cleanup on res.on('close').
   *
   * Auth is already done by the route's guard before reaching this service (JwtAuthGuard for the
   * primary stream, NotificationTokenGuard for the notification stream), so this only pushes.
   *
   * `res` is the reply.raw handed over by Fastify after reply.hijack(): ServerResponse under h1.1,
   * Http2ServerResponse under HTTP/2 (both share the writeHead/write/end/on('close') interface).
   * HTTP/2 forbids the Connection header (Node http2 throws "HTTP/1 Connection specific headers are
   * forbidden"), and an h2 connection is already persistent, so Connection: keep-alive is only
   * written under h1.1. The protocol is detected by the presence of res.stream (Http2ServerResponse only).
   */
  private attach(map: Record<number, SseClient[]>, userId: number, res: ServerResponse): void {
    const isH2 = (res as unknown as { stream?: unknown }).stream !== undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    };
    if (!isH2) headers['Connection'] = 'keep-alive';
    res.writeHead(200, headers);
    res.write(': connected\n\n');

    const ping = setInterval(() => {
      // Heartbeat. Sent as a NAMED event (not a `:` comment) so the client's dispatcher observes it and
      // can run a liveness watchdog: a comment frame is invisible to fetch-event-source's onmessage, so a
      // silently stalled / half-open connection would otherwise go undetected and the "connection lost"
      // banner would never appear on a real disconnect. A failed write (broken connection) → end now and
      // let the res.on('close') handler finish the cleanup.
      if (!res.write('event: ping\ndata: {}\n\n')) {
        try {
          res.end();
        } catch {}
      }
    }, SseService.HEARTBEAT_MS);

    const entry: SseClient = { res, ping, since: Date.now() };
    (map[userId] ??= []).push(entry);

    res.on('close', () => {
      clearInterval(ping);
      const list = map[userId];
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete map[userId];
    });
  }

  /** Register one primary-session SSE connection (GET /events). Auth done upstream by JwtAuthGuard. */
  register(userId: number, res: ServerResponse): void {
    this.attach(this.clients, userId, res);
  }

  /** Register one notification-stream SSE connection (GET /notifications/stream). Auth done upstream
   *  by NotificationTokenGuard. Consumed by the Android foreground service. */
  registerNotif(userId: number, res: ServerResponse): void {
    this.attach(this.notifClients, userId, res);
  }

  /** True iff the user currently has ≥1 live PRIMARY SSE connection. Used by PushService to skip FCM
   *  dispatch for already-online recipients (no double-delivery, no wasted battery) — the inverse of
   *  the fan-out loop in onNewMessage. Constant-time lookup; safe per-recipient in the send hot path.
   *  The 25s heartbeat bounds the only inaccuracy: a half-open connection reads "online" until the next
   *  failed ping, so FCM is skipped for at most one heartbeat after a real drop — self-correcting. */
  isUserOnline(userId: number): boolean {
    const list = this.clients[userId];
    return !!list && list.length > 0;
  }

  /** True iff the user has ≥1 live NOTIFICATION-stream connection — i.e. the Android FGS is currently
   *  backgrounded and streaming. Gates the snapshot computation in the send-message fan-out so only
   *  backgrounded-FGS recipients pay it. */
  hasNotifClient(userId: number): boolean {
    const list = this.notifClients[userId];
    return !!list && list.length > 0;
  }

  /**
   * Read-only snapshot of live PRIMARY SSE connections (for the admin console to observe).
   * Aggregated per user: one user with multiple tabs → multiple connections merged into one entry,
   * `since` being the earliest establishment time. Contains no sensitive data (no token, no IP) — only
   * userId + connection count + establishment time. (Notification-stream connections are deliberately
   * excluded — they're an internal transport detail, not a "session" worth surfacing.)
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
   * Write one frame to all of a user's live connections in `map`. Reverse iteration + cleaning up
   * failed/broken connections inline so a dead connection cannot abort the fan-out; backpressure
   * (write returns false) is not handled here — left for the next frame / heartbeat to detect the
   * drop. When the user's connection list empties, its slot is deleted.
   */
  private writeTo(
    map: Record<number, SseClient[]>,
    userId: number,
    eventName: string,
    data: unknown,
    id?: string | number,
  ): void {
    const list = map[userId];
    if (!list || list.length === 0) return;
    const frame =
      `event: ${eventName}\n` +
      (id !== undefined && id !== null ? `id: ${id}\n` : '') +
      `data: ${JSON.stringify(data)}\n\n`;
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
    if (list.length === 0) delete map[userId];
  }

  /** Push to all of a user's live PRIMARY connections. (Indirection so the notification stream can
   *  share the write path via writeTo without exposing the registry map publicly.) */
  private pushToUser(userId: number, eventName: string, data: unknown, id?: string | number): void {
    this.writeTo(this.clients, userId, eventName, data, id);
  }

  /** Push one coalesced unread-snapshot frame to the user's live notification-stream connection(s).
   *  The Android FGS renders this as a single away-notification (last snapshot wins). */
  pushNotifSnapshot(userId: number, snapshot: unknown): void {
    this.writeTo(this.notifClients, userId, 'NOTIF_SYNC', snapshot);
  }

  /** New message: push the full message body. id = the message id (the client's Last-Event-ID resume cursor). */
  onNewMessage(userId: number, data: unknown) {
    const id = (data as { id?: string | number } | null)?.id;
    this.pushToUser(userId, 'NEW_MESSAGE', data, id);
  }

  /** Notification: push to all of the user's live connections (e.g. a new friend request). No id (not a message-cursor semantic). */
  onNotify(userId: number, data: unknown) {
    this.pushToUser(userId, 'NOTIFY', data);
  }

  /**
   * Group-lifecycle event (joined/left/kicked/role-changed/updated). No message-cursor id (these
   * are not message-history events). Fan-out to each affected member is the caller's job — this
   * pushes one frame to one user's online connections only.
   */
  onGroupEvent(userId: number, eventName: GroupSseEvent, data: unknown) {
    this.pushToUser(userId, eventName, data);
  }

  /**
   * Read-cursor advance (mark-read). Tells the caller's OTHER online connections to drop the unread
   * badge for a thread — multi-device/tab consistency for the same per-user state that send-message
   * already syncs by fanning NEW_MESSAGE to the sender. Fanned to the user's OWN connections only:
   * this is NOT a read receipt to peers (the app deliberately surfaces no read receipts). No
   * message-cursor id (a read watermark is not a resumable history cursor).
   */
  onReadCursor(userId: number, data: unknown) {
    this.pushToUser(userId, 'READ_CURSOR', data);
  }

  /**
   * Per-user thread metadata change (mute / pin / clear-history). Fanned to the caller's OWN connections
   * only — these are per-user display settings, not shared state, so (like onReadCursor) this is NOT a
   * peer broadcast. It carries whichever fields just changed so each of the user's other online
   * tabs/devices patches its conversation-list row + re-sorts without a full reload.
   */
  onThreadMeta(userId: number, data: unknown) {
    this.pushToUser(userId, 'THREAD_META', data);
  }

  /** All-device logout / password change / force-kick: push FORCE_LOGOUT then immediately drop all of
   *  the user's PRIMARY connections, and close their notification-stream connection(s) too (an FGS
   *  holding a notification stream must stop on logout). */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const frame =
      `event: FORCE_LOGOUT\n` +
      `data: ${JSON.stringify({ event: 'FORCE_LOGOUT', status: 0, message: payload.reason })}\n\n`;
    const drop = (list: SseClient[] | undefined) => {
      if (!list) return;
      list.forEach(({ res, ping }) => {
        clearInterval(ping);
        try {
          res.write(frame);
          res.end();
        } catch {}
      });
    };
    drop(this.clients[payload.userId]);
    drop(this.notifClients[payload.userId]);
    delete this.clients[payload.userId];
    delete this.notifClients[payload.userId];
  }

  /** Process exit / hot reload: clear all heartbeat timers (both registries) to avoid handle-leak warnings. */
  onModuleDestroy() {
    for (const map of [this.clients, this.notifClients]) {
      for (const uid of Object.keys(map)) {
        const id = Number(uid);
        map[id].forEach(({ ping }) => clearInterval(ping));
        delete map[id];
      }
    }
  }
}
