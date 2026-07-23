import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { ServerResponse } from 'http';
import { initSseResponse, formatSseFrame } from '../common/sse-stream.js';
import { PrismaService } from '../prisma.service.js';
import { MessageService } from '../message/message.service.js';
import { InviteKind } from '../prisma/generated/client.js';

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
 * tabs/devices — in an array): the primary session stream (GET /events) carrying full NEW_MESSAGE
 * payloads + group/read-cursor events for the in-app UI, with `res.on('close')` cleanup. (The former
 * separate notification-stream registry + its scoped notification token were removed — the Android
 * foreground service now consumes `/events` directly via the Kotlin-owned connection.)
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly clients: Record<number, SseClient[]> = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessageService,
  ) {}

  /**
   * Register one SSE connection (GET /events): the SSE headers, the `: connected` flush, and the 25s
   * named-ping heartbeat are in common/sse-stream.ts (one source of truth — the same wire format the
   * admin log viewer and the consumer sse.worker.ts use). This keeps the per-user registry insertion
   * + the close cleanup. Auth is already done by the route's guard before reaching this service
   * (SessionAuthGuard), so this only pushes. `origin` is the request Origin, forwarded so the hijacked raw
   * response carries its CORS header.
   */
  register(userId: number, sessionId: number, res: ServerResponse, origin?: string): void {
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

    // The connect handshake: push HELLO (the user's newest message cursor + the friend-list revision) to THIS
    // connection only. The cursor is the client's `to` (the missed-summary walk's pinned upper bound); the
    // revision lets it pull a thread-list delta if stale. Fire-and-forget — a transient failure just means no
    // HELLO this connect (the next live NEW_MESSAGE signal re-establishes `to`).
    void this.sendHello(userId, entry);
  }

  /** Push the HELLO handshake to one connection (the just-registered one). Best-effort: a racing close or a
   *  DB failure is swallowed (never throws on the connect path). */
  private async sendHello(userId: number, entry: SseClient): Promise<void> {
    try {
      const [latestMessage, user, friendReqAgg] = await Promise.all([
        this.messages.findNewestForUser(userId),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { threadRevision: true, profileRev: true },
        }),
        // friendReqRev = MAX(updatedAt) over the user's incoming FRIEND invites (the data-derived friend-
        // request revision; no denormalized badge column). Null when the user has never received one.
        this.prisma.invite.aggregate({
          where: { kind: InviteKind.FRIEND, toUserId: userId },
          _max: { updatedAt: true },
        }),
      ]);
      const friendReqRev = friendReqAgg._max.updatedAt
        ? friendReqAgg._max.updatedAt.getTime()
        : null;
      const frame = formatSseFrame('HELLO', {
        // The caller's userId. The session token is OPAQUE (server-side lookup only), so the client cannot
        // learn its userId without an authenticated response — HELLO is it. The client opens its per-user
        // IDB store on this userId (previously the /user/my-profile fetch was load-bearing for that, which
        // made the fetch un-skippable). Carrying it here lets the webdb open at connect time, independent
        // of the profile fetch.
        userId,
        // { threadId, seq, ts } | null — the missed-summary walk's pinned upper bound `to` (null when the
        // user has no messages yet → the client does not walk until the first live NEW_MESSAGE).
        latestMessage,
        // The thread-list delta cursor. The client delta-replays (0, this] on first HELLO, then
        // (cursor, this] on each subsequent THREAD_REVISION_UPDATED — the SOLE revision source now that
        // the snapshot endpoint is gone.
        threadRevision: user?.threadRevision ?? 0,
        // The self-profile version. The client skips the cold-start /user/my-profile fetch when its IDB-
        // cached profileRev matches this (it already has the fresh name/avatar/bio). First-ever boot (no
        // cache) or a changed rev still fetches. PROFILE_REV_UPDATED advances it live (multi-device).
        profileRev: user?.profileRev ?? 0,
        // The friend-request revision (epoch ms | null) = MAX(updatedAt) over incoming FRIEND invites. The
        // client compares it to its IDB cursor to derive the unread badge (mirroring the threadRevision
        // delta model); FRIEND_REQ_REV_UPDATED advances it live. Replaces the former denormalized boolean.
        friendReqRev,
      });
      if (!entry.res.writableEnded) entry.res.write(frame);
    } catch (e) {
      // HELLO is load-bearing: the threadlist cannot build without its threadRevision (delta-replay from
      // 0..rev). A send failure must therefore be OBSERVABLE, not silently swallowed — the connection still
      // establishes, and the client's HELLO-timeout will force a reconnect that re-pushes HELLO.
      this.logger.error(`HELLO handshake failed for user ${userId}`, e);
    }
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

  /** New message: identity-only signal `{ threadId, seq, ts }` — the body is PULLED by the client (single
   *  data source; the realtime stream is a trigger, never a body carrier). No Last-Event-ID cursor: a
   *  transient drop or an offline gap is reconciled by the missed-summary pull on reconnect, not by SSE
   *  replay, so no message-cursor `id` is emitted. */
  onNewMessage(userId: number, threadId: number, seq: number, ts: number) {
    this.pushToUser(userId, 'NEW_MESSAGE', { threadId, seq, ts });
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

  /** Self-profile revision bumped (avatar / name / bio edit on this account). The client invalidates its
   *  IDB-cached selfProfile (whose profileRev it compared at HELLO) and re-fetches /user/my-profile — this
   *  is the multi-device self-profile refresh (the editor's OTHER tabs/devices learn of their own edit's
   *  effect). Carried on the wire as `{ profileRev }`, advanced in HELLO too. */
  onProfileRevUpdated(userId: number, data: { profileRev: number }) {
    this.pushToUser(userId, 'PROFILE_REV_UPDATED', data);
  }

  /** Friend-request revision advanced (a FRIEND invite to this user was created / accepted / declined — any
   *  mutation of an incoming FRIEND row bumps its `updatedAt`). Carried as the new MAX(updatedAt) epoch ms
   *  (`friendReqRev`); the client compares it to its IDB cursor to (re)derive the unread badge, and the
   *  native layer merges it into its cached HELLO so a re-attached webview's replay is fresh. Replaces the
   *  former denormalized `hasUrFriendReq` boolean push. */
  onFriendReqRevUpdated(userId: number, data: { friendReqRev: number | null }) {
    this.pushToUser(userId, 'FRIEND_REQ_REV_UPDATED', data);
  }

  /** Send a FORCE_LOGOUT frame and end each connection, clearing its heartbeat. The caller removes the
   *  entries from the registry (the broadcast deletes the whole user slot; the per-session path splices
   *  just the matching entries). Idempotent per-connection — a half-closed socket is already gone.
   *  formatSseFrame keeps the wire shape identical to the client's SSE_EVENT_FORCE_LOGOUT handler. */
  private forceLogout(entries: SseClient[], reason: string): void {
    const frame = formatSseFrame('FORCE_LOGOUT', { event: 'FORCE_LOGOUT', status: 0, message: reason });
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
  onSessionRevoked(payload: { userId: number; sessionId: number; reason: string }) {
    const list = this.clients[payload.userId];
    if (!list || list.length === 0) return;
    const revoked = list.filter((c) => c.sessionId === payload.sessionId);
    if (revoked.length === 0) return;
    this.forceLogout(revoked, payload.reason);
    const survivors = list.filter((c) => c.sessionId !== payload.sessionId);
    if (survivors.length === 0) delete this.clients[payload.userId];
    else this.clients[payload.userId] = survivors;
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
