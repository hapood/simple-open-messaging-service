import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { ServerResponse } from 'http';
import { initSseResponse, formatSseFrame } from '../common/sse-stream.js';

/**
 * Group-lifecycle SSE event names. Carried on every group frame so the frontend dispatches by
 * event name (matching NEW_MESSAGE / FORCE_LOGOUT). Payload shape (the `data` field) is common:
 *   { groupId, threadId, ...event-specific fields, byUserId? }
 * The frontend refreshes the roster / conversation list on receipt (Phase 4).
 */
export type GroupSseEvent =
  | 'GROUP_UPDATED'
  | 'GROUP_ROSTER_UPDATED';

export const GROUP_SSE: Record<GroupSseEvent, GroupSseEvent> = {
  GROUP_UPDATED: 'GROUP_UPDATED',
  GROUP_ROSTER_UPDATED: 'GROUP_ROSTER_UPDATED',
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
 * One registry, `clients`, keyed by userId (a user may have multiple live connections — multiple
 * tabs/devices — in an array): the primary session stream (GET /events) carrying full NEW_MESSAGE
 * payloads + group/read-cursor events for the in-app UI, with `res.on('close')` cleanup. (The former
 * separate notification-stream registry + its scoped notification token were removed — the Android
 * foreground service now consumes `/events` directly via the Kotlin-owned connection.)
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly clients: Record<number, SseClient[]> = {};

  /**
   * Register one SSE connection (GET /events): the SSE headers, the `: connected` flush, and the 25s
   * named-ping heartbeat are in common/sse-stream.ts (one source of truth — the same wire format the
   * admin log viewer and the consumer sse.worker.ts use). This keeps the per-user registry insertion
   * + the close cleanup. Auth is already done by the route's guard before reaching this service
   * (JwtAuthGuard), so this only pushes. `origin` is the request Origin, forwarded so the hijacked raw
   * response carries its CORS header.
   */
  register(userId: number, res: ServerResponse, origin?: string): void {
    const ping = initSseResponse(res, origin);

    const entry: SseClient = { res, ping, since: Date.now() };
    (this.clients[userId] ??= []).push(entry);

    res.on('close', () => {
      clearInterval(ping);
      const list = this.clients[userId];
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete this.clients[userId];
    });
  }

  /** True iff the user currently has ≥1 live SSE connection. Used by PushService to skip FCM
   *  dispatch for already-online recipients (no double-delivery, no wasted battery) — the inverse of
   *  the fan-out loop in onNewMessage. Constant-time lookup; safe per-recipient in the send hot path.
   *  The 25s heartbeat bounds the only inaccuracy: a half-open connection reads "online" until the next
   *  failed ping, so FCM is skipped for at most one heartbeat after a real drop — self-correcting. */
  isUserOnline(userId: number): boolean {
    const list = this.clients[userId];
    return !!list && list.length > 0;
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
  private pushToUser(userId: number, eventName: string, data: unknown, id?: string | number): void {
    const list = this.clients[userId];
    if (!list || list.length === 0) return;
    const frame = formatSseFrame(eventName, data, id);
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

  /**
   * A federated media message finished localizing. Signal-only state flip: the recipient sets that
   * message's mediaStatus to 'ready' (every digest has bytes on disk + an authz row → the URL serves
   * 200) or 'failed' (at least one digest stayed inert → shown as a retryable failure), then re-renders
   * the card. No message-cursor id (a status flip is not a resumable history cursor). `v` is a monotonic
   * version the client uses to drop stale out-of-order frames (a manual retry re-localize, or a
   * reconnect replay). Fan-out to each active local thread member mirrors NEW_MESSAGE.
   */
  onMediaStatus(
    userId: number,
    data: { threadId: number; seq: number; status: 'ready' | 'failed'; v: number },
  ) {
    this.pushToUser(userId, 'MEDIA_STATUS', data);
  }

  /**
   * A peer's profile (avatar/name/bio) changed — push a signal to each approved P2P peer so the
   * recipient HTTP-pulls the fresh profile itself (SSE-signal-only convention). Emitted on local
   * self-edits (update-profile / update-avatar) and on federated stub re-localization (the catch-up
   * path: once any local user's probe refreshes a foreign stub, all that stub's local friends get it
   * too — the only way federated peers benefit from the push, since there is no S2S profile-push and
   * federation is pull-based by design).
   */
  onPeerProfileUpdated(userId: number, data: unknown) {
    this.pushToUser(userId, 'PEER_PROFILE_UPDATED', data);
  }

  /** Thread-list revision bumped (thread added or deleted). Signal-only: the client receives the new
   *  revision and pulls ADD/DELETE deltas via query-thread(from, to]. */
  onThreadRevisionUpdated(userId: number, data: unknown) {
    this.pushToUser(userId, 'THREAD_REVISION_UPDATED', data);
  }

  /** All-device logout / password change / force-kick: push FORCE_LOGOUT then immediately drop all of
   *  the user's live connections. */
  @OnEvent('auth.sessions-invalidated')
  onSessionsInvalidated(payload: { userId: number; reason: string }) {
    const frame =
      `event: FORCE_LOGOUT\n` +
      `data: ${JSON.stringify({ event: 'FORCE_LOGOUT', status: 0, message: payload.reason })}\n\n`;
    const list = this.clients[payload.userId];
    if (list) {
      list.forEach(({ res, ping }) => {
        clearInterval(ping);
        try {
          res.write(frame);
          res.end();
        } catch {}
      });
    }
    delete this.clients[payload.userId];
  }

  /** Process exit / hot reload: clear all heartbeat timers to avoid handle-leak warnings. */
  onModuleDestroy() {
    for (const uid of Object.keys(this.clients)) {
      const id = Number(uid);
      this.clients[id].forEach(({ ping }) => clearInterval(ping));
      delete this.clients[id];
    }
  }
}
