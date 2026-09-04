import {
  Injectable,
  Logger,
  HttpStatus,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, gt, lt } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { callTombstone, user } from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { CallStateRegistry } from '../gateway/call-state.registry.js';
import { PushService } from '../push/push.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import {
  FederationService,
  S2sResponseError,
} from '../federation/federation.service.js';
import type {
  S2SCallFrame,
  S2SCallOperation,
  S2SAddress,
} from '../federation/federation.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../database/enums.js';
import {
  buildCallContent,
  type CallMediaType,
  type CallOutcome,
} from './call-content.js';
import type { CallSignalType } from './federated-call-protocol.js';
import {
  decideCallTransition,
  decideVideoUpgrade,
  isEndReasonAllowed,
  isSignalAllowed,
  timeoutLifecycle,
} from './call-state-machine.js';

/** Server-side ringing timeout on the CALLEE's server: a RINGING call flips to MISSED if the callee
 *  does not answer. The caller's client also has its own (UI) timeout; this is the authoritative
 *  server-side backstop so an unanswered call never lingers live. Used for LOCAL calls AND the federated
 *  callee server (the only side that knows whether the callee answered). */
const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 45_000;
/** Federated caller-server safety-net. Strictly longer than the callee's RING_TIMEOUT_MS +
 *  S2S RTT, so the callee's `accepted`/terminal frames land first. Fires only on partition/crash (no
 *  terminal frame arrived from the peer) → writes a `missed` bubble. Avoids the accept-after-missed race
 *  a symmetric-timer design would create. */
const FED_SAFETY_NET_MS = 60_000;
const FED_CONNECT_SAFETY_NET_MS = 60_000;
const CALL_TOMBSTONE_MAX_MS = 300_000;
type TerminalCallOperation = 'declined' | 'cancelled' | 'missed' | 'ended';
type RelayedLifecycleOperation = Exclude<
  S2SCallOperation,
  'incoming' | 'signal'
>;
interface StagedCallSignal {
  id: string;
  payload: string;
}

/** The live (in-memory) state of one in-flight call. Only `ringing` / `accepted` are live; every
 *  terminal transition writes a CALL Message bubble (persisted on the caller server only)
 *  and drops this entry. */
interface LiveCall {
  /** Client-generated canonical lowercase RFC UUID — the call's idempotency key + frame address.
   *  Becomes the terminal bubble's clientMessageId (idempotent terminal write). */
  callSid: string;
  threadId: number;
  /** The caller. LOCAL on the caller server; a foreigner STUB on the callee server. */
  callerId: number;
  /** The callee. LOCAL on the callee server; a foreigner STUB on the caller server. */
  calleeId: number;
  callType: CallMediaType;
  initialCallType: CallMediaType;
  state: 'ringing' | 'accepted' | 'connected';
  /** Set synchronously before a terminal DB write so racing inbound frames cannot revive the call. */
  terminal?: { op: TerminalCallOperation; endReason: string | null };
  /** Connect epoch-ms (set when the media leg connects — NOT on accept). Null until connected. */
  startedAt: number | null;
  /** True once the callee side has acked that it is alerting the user. Set by the LOCAL {@link ringing}
   *  method (a callee device POSTed /calls/ringing) OR by {@link onInboundRinging} (the caller server
   *  received the S2S `ringing` relay from the callee server). Guards the `ringing` fan-out so a multi-device
   *  double-ack / a replayed S2S frame emits CALL_EVENT{ringing} exactly once. The call does NOT transition
   *  on a ring ack, so this bit — not the state — is the idempotency key. */
  ringingAcked?: boolean;
  /** Which participant is local on this server. For a local call both participants are local, and the
   *  lifecycle is coordinated with the caller role. */
  localRole: 'caller' | 'callee';
  /** The foreign participant's account; null for a local call. */
  peerAccount: string | null;
  /** The local participant's canonical account on an inbound federated call; used before identity resolution
   *  to distinguish an exact incoming retry from a callSid collision. */
  localAccount: string | null;
  /** The server domain hosting the foreign participant (the S2S POST target); null for a local call. */
  peerDomain: string | null;
  /** Identity namespace captured when the federated call was admitted. */
  peerNamespaceId: number | null;
  /** Server-authoritative setup signaling (store-and-forward). The caller's offer + ICE are staged for the
   *  CALLEE to fetch; the callee's answer + ICE for the CALLER. Each server stages for its LOCAL participant
   *  (caller server for the caller, callee server for the callee), so an offline callee still gets an
   *  earlier offer on accept via GET /calls/:sid/signaling — no client-side re-offer hack. Cleared on
   *  `connected` (media up → setup consumed) and on release (call ends). Every staged item retains its
   *  endpoint-authored signal ID so pull fallback and realtime delivery share one dedup key. */
  pendingOffer?: StagedCallSignal;
  pendingAnswer?: StagedCallSignal;
  pendingOfferIce: StagedCallSignal[];
  pendingAnswerIce: StagedCallSignal[];
  /** Endpoint-authored IDs already accepted through the local HTTP API, scoped by sender. */
  localSignalIds: Set<string>;
  seenSignalIds: Set<string>;
}

/** The payload FederationService emits on 'call.frame.inbound' (the inbound bridge — see the
 *  FederationService→CallsService event edge). Identities are already resolved to LOCAL ids by the
 *  federation layer; CallsService applies the frame to its in-memory state machine. */
export interface InboundCallFramePayload {
  /** The LOCAL user this frame is for (the callee for `incoming`; the local participant otherwise). */
  localUserId?: number;
  /** The foreign sender's LOCAL stub id (the caller's stub on the callee server; used as CALL_EVENT/CALL_SIGNAL
   *  `fromUserId` so the client renders the peer from the localized stub). */
  peerStubId?: number;
  /** The verified HTTP signer domain; Call Frame bodies carry account names only. */
  peerDomain: string;
  namespaceId: number;
  /** The LOCAL P2P thread between the local user and the peer stub. */
  threadId?: number;
  signatureExpiresAtSec: number;
  frame: S2SCallFrame;
}

/**
 * 1:1 WebRTC call lifecycle + signaling relay. The server is the signaling COORDINATOR and the
 * lifecycle OWNER — it never carries media (P2P DTLS-SRTP; coturn is the TURN relay fallback, OFF in
 * current SOMS).
 *
 * LIVE state is a single-instance in-memory map (one active call per user — the busy-line invariant).
 * The PERSISTED record is a {@link ContentType.CALL} Message bubble, authored at the call's TERMINAL
 * state by the caller server only — so BOTH participants see every call record (the callee's
 * server pulls it via the existing message sync; no separate visibility rule, no Call table). Persisting
 * only at the terminal state (CDR-at-end) is the deliberate trade-off for single-instance simplicity: a
 * process restart mid-call drops the in-flight state and forfeits that one record.
 *
 * FEDERATED calls (callee on a peer server): the realtime lifecycle + WebRTC relay cross servers via
 * signed S2S frames ({@link FederationService.sendCallFrame} outbound; `@OnEvent('call.frame.inbound')`
 * inbound — the event bus breaks the Calls→Fed cycle). The bubble needs no federation code (it is an
 * ordinary message). TURN is off → federated media is STUN/P2P-only; a hard-NAT pair fails → `failed`.
 *
 * Delivery mirrors {@link MessageFanoutService}'s manual composition: an in-band SSE frame (the online
 * device) PLUS, for the incoming RING only, a push wake-up to ALL the callee's devices. Lifecycle events
 * (accepted/declined/cancelled/ended) fan to the local participant(s) over SSE so every device of each
 * side stays in sync.
 */
@Injectable()
export class CallsService implements OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  /** Authoritative live call state, keyed by callSid. Dropped on restart (by design). */
  private readonly activeCalls = new Map<string, LiveCall>();
  /** Busy-line index: userId → the callSid of the one active call that user is in. A user may be in
   *  at most one active (ringing/accepted) call as caller OR callee. (For a federated call the foreign
   *  STUB also occupies a slot on the caller server — correct: the foreign user can be in only one call.) */
  private readonly activeByUser = new Map<number, string>();
  /** Per-call ringing timers (ringing → missed), keyed by callSid. Cleared on any earlier terminal
   *  transition + on shutdown. */
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
    private readonly push: PushService,
    private readonly participants: AccountThreadStateService,
    private readonly messages: MessageService,
    private readonly fanout: MessageFanoutService,
    private readonly federation: FederationService,
    private readonly quota: QuotaService,
    private readonly callState: CallStateRegistry,
  ) {}

  // ── initiate ──────────────────────────────────────────────────────────────────

  /** Caller initiates a call: authorize (friends), busy-check both parties, register the live call,
   *  ring the callee (locally for a same-server call; via an S2S `incoming` frame for a federated
   *  callee), and arm the ringing-timeout. Idempotent on callSid. */
  async initiate(
    callerId: number,
    dto: { callSid: string; calleeUserId: number; callType: CallMediaType },
  ): Promise<{ callSid: string; threadId: number }> {
    if (callerId === dto.calleeUserId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'cannot call yourself',
      );
    }
    // Authorization: caller + callee must share an active P2P thread (be friends).
    const threadId = await this.participants.findP2PThreadBetween(
      callerId,
      dto.calleeUserId,
    );
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'not friends with this user',
      );
    }

    // Idempotent: check the live call BEFORE the busy guard — the caller's own in-flight call would
    // otherwise trip the busy check on retry. A callSid held by a different (caller,callee) pair is
    // impossible in practice (client-generated UUID); refuse rather than leak.
    const existing = this.activeCalls.get(dto.callSid);
    if (existing) {
      if (
        existing.callerId === callerId &&
        existing.calleeId === dto.calleeUserId
      ) {
        if (existing.state === 'ringing') await this.ring(existing);
        return { callSid: existing.callSid, threadId: existing.threadId };
      }
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'callSid conflict',
      );
    }

    // Federated? A foreigner callee is rung on ITS server via an S2S frame; a local callee is rung here.
    // Fetched BEFORE the busy-check so the check + the activeByUser reservation below stay one synchronous
    // block (no await between) — closes the TOCTOU race where two concurrent initiates (A→B + B→A) both
    // pass the check during each other's await, then both register (glare: each side then sees the other's
    // late incoming while its own outgoing screen is up).
    const callee = await this.database.db.query.user.findFirst({
      where: eq(user.id, dto.calleeUserId),
      columns: { account: true, domain: true, namespaceId: true },
    });
    const federated = callee?.domain !== 'local';

    // New call: neither party may already be in an active call (one active call per user). The check + the
    // activeByUser.set below are SYNCHRONOUS (no await between) → atomic on the event loop → no glare race.
    if (
      this.activeByUser.has(callerId) ||
      this.activeByUser.has(dto.calleeUserId)
    ) {
      throw new BusinessException(
        BusinessCode.CALL_BUSY,
        'an active call already exists',
      );
    }

    const call: LiveCall = {
      callSid: dto.callSid,
      threadId,
      callerId,
      calleeId: dto.calleeUserId,
      callType: dto.callType,
      initialCallType: dto.callType,
      state: 'ringing',
      startedAt: null,
      localRole: 'caller',
      peerAccount: federated ? callee!.account : null,
      localAccount: null,
      peerDomain: federated ? callee!.domain : null,
      peerNamespaceId: federated ? callee!.namespaceId : null,
      pendingOfferIce: [],
      pendingAnswerIce: [],
      localSignalIds: new Set(),
      seenSignalIds: new Set(),
    };
    this.activeCalls.set(call.callSid, call);
    this.logger.debug(
      `[call] initiate sid=${call.callSid} caller=${callerId} callee=${dto.calleeUserId} state=ringing`,
    );
    this.activeByUser.set(callerId, call.callSid);
    this.activeByUser.set(dto.calleeUserId, call.callSid);
    this.armRingTimer(call);
    this.syncCallState(call);

    if (federated) {
      // Ring the peer server. Await so a ring failure (network/trust/quota/busy) is caught here → the
      // caller learns `unreachable` immediately. No local ring() — the foreign callee is rung by the
      // peer's inbound handler.
      try {
        await this.federation.sendCallFrame(
          {
            fromLocalUserId: callerId,
            to: { account: call.peerAccount!, domain: call.peerDomain! },
            callSid: call.callSid,
            op: 'incoming',
            callType: call.callType,
          },
          call.peerDomain!,
        );
      } catch {
        this.release(call);
        await this.persistTerminal(call, 'unreachable');
        throw new BusinessException(
          BusinessCode.CALL_PEER_UNREACHABLE,
          'could not reach the peer server',
        );
      }
    } else {
      await this.ring(call);
    }
    return { callSid: call.callSid, threadId: call.threadId };
  }

  /** Ring the callee: in-band SSE (the online device renders the incoming-call UI) + a push wake-up
   *  to ALL the callee's devices (the phone rings even when the desktop SSE is live). Carries the
   *  caller's display name/avatar so the callee UI can render without an extra fetch. Called for LOCAL
   *  calls + the federated callee server (where callerId is the localized foreigner stub). */
  private async ring(call: LiveCall): Promise<void> {
    const caller = await this.database.db.query.user.findFirst({
      where: eq(user.id, call.callerId),
      columns: { account: true, domain: true, name: true, avatar: true },
    });
    this.emit(call.calleeId, 'incoming', {
      callSid: call.callSid,
      threadId: call.threadId,
      callerUserId: call.callerId,
      callerName: caller?.name ?? '',
      callerAvatar: caller?.avatar ?? '',
      callerAccount: caller?.account ?? '',
      callerDomain: caller?.domain ?? '',
      callType: call.callType,
    });
    if (caller?.account) {
      this.callState.setPeerIdentity(
        call.calleeId,
        caller.account,
        caller.domain,
      );
    }
    void this.push.dispatchForCall(call.calleeId, {
      callSid: call.callSid,
      callerUserId: call.callerId,
      callerName: caller?.name ?? '',
      callerAvatar: caller?.avatar ?? '',
      callerAccount: caller?.account ?? '',
      callerDomain: caller?.domain ?? '',
      threadId: call.threadId,
      callType: call.callType,
    });
  }

  // ── callee / caller responses ─────────────────────────────────────────────────

  /** The callee accepts: ringing → accepted. This is "callee answered / negotiating", NOT connected —
   *  media may still fail to come up. So `startedAt` is NOT set here + the ringing timer keeps running
   *  (if it fires while accepted → `failed`, a connection failure). The real connect marker is {@link connected}.
   *  Fans `accepted` so the caller's UI flips to "connecting" + the callee's other devices dismiss. */
  async accept(calleeId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] accept calleeId=${calleeId} sid=${callSid} found=${!!call}` +
        (call
          ? ` state=${call.state} caller=${call.callerId} callee=${call.calleeId}`
          : ''),
    );
    if (!call) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no ringing call',
      );
    }
    if (call.calleeId !== calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the callee can accept',
      );
    }
    if (call.terminal) {
      throw new BusinessException(BusinessCode.CALL_NOT_FOUND, 'call ended');
    }
    const decision = decideCallTransition(call.state, 'accepted');
    if (decision === 'noop') return;
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot accept while ${call.state}`,
      );
    }
    call.state = 'accepted';
    this.syncCallState(call);
    this.armConnectTimer(call);
    this.notifyBoth(call, 'accepted', { threadId: call.threadId });
  }

  /** The callee's device acknowledges it is alerting the user (it received the `incoming` ring and is now
   *  ringing the UI). This is NOT progress toward connect — the call stays `ringing`, the ringing timer
   *  keeps running, and `startedAt` is untouched (the real connect marker is {@link connected}). Fans a
   *  `ringing` event so the caller's UI flips "Calling…" → "Ringing…"; the server cannot otherwise know the
   *  callee device is alerting (receiving the SSE `incoming` only proves the socket arrived). Idempotent
   *  across the callee's devices (a second device's ack is a no-op). Structurally a twin of {@link accept}
   *  MINUS the state transition + timer clear. For a federated call, notifyBoth relays an S2S `ringing`
   *  frame to the caller server (handled inbound by {@link onInboundRinging}). */
  async ringing(calleeId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no ringing call',
      );
    }
    if (call.calleeId !== calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the callee can ack ringing',
      );
    }
    if (call.terminal) {
      throw new BusinessException(BusinessCode.CALL_NOT_FOUND, 'call ended');
    }
    const decision = decideCallTransition(call.state, 'ringing');
    if (decision === 'noop') return;
    if (call.ringingAcked) return; // another of the callee's devices already acked — no-op
    call.ringingAcked = true;
    this.notifyBoth(call, 'ringing', { threadId: call.threadId });
  }

  /** A client reports that its media leg is up. The callee endpoint is authoritative for both local and
   *  federated calls; a caller-side report is an advisory no-op and waits for the callee's event. */
  async connected(userId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call) return;
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    if (call.terminal) {
      throw new BusinessException(BusinessCode.CALL_NOT_FOUND, 'call ended');
    }
    const decision = decideCallTransition(call.state, 'connected');
    if (decision === 'noop') return;
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot connect while ${call.state}`,
      );
    }
    // The callee endpoint is the single connected/startedAt authority for local
    // and federated calls. A caller report is an idempotent advisory no-op.
    if (userId !== call.calleeId) return;
    call.state = 'connected';
    call.startedAt = Date.now();
    this.clearStaged(call); // media is up — the setup signaling is consumed, drop the staged store
    this.syncCallState(call);
    this.clearRingTimer(callSid);
    this.notifyBoth(call, 'connected', { startedAt: call.startedAt });
  }

  /** Permanently upgrade a connected AUDIO call to VIDEO. Camera enable/disable remains client-local after
   *  this transition; the server only owns the durable call type so both live clients and the terminal CALL
   *  bubble agree that this became a video call. Idempotent when another device/participant races the same
   *  upgrade. */
  async upgradeVideo(userId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no connected call to upgrade',
      );
    }
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    if (call.terminal) {
      throw new BusinessException(BusinessCode.CALL_NOT_FOUND, 'call ended');
    }
    if (userId !== call.callerId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the caller can commit a video upgrade',
      );
    }
    const decision = decideVideoUpgrade(
      call.state,
      call.initialCallType,
      call.callType,
    );
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot upgrade video while ${call.state}`,
      );
    }
    if (decision === 'noop') return;
    call.callType = 'VIDEO';
    this.syncCallState(call);
    this.notifyBoth(call, 'video-upgraded', {
      callType: 'VIDEO',
      upgradedBy: userId,
    });
  }

  /** The callee declines a ringing call: fans `declined`, then writes the terminal bubble on the caller server.
   *  Idempotent on an already-terminal call (no live entry → no-op). */
  async decline(calleeId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] decline calleeId=${calleeId} sid=${callSid} state=${call?.state ?? 'null'}`,
    );
    if (!call) return; // already resolved — idempotent no-op
    if (call.calleeId !== calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the callee can decline',
      );
    }
    if (call.terminal) return;
    if (decideCallTransition(call.state, 'declined') === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot decline while ${call.state}`,
      );
    }
    call.terminal = { op: 'declined', endReason: null };
    this.notifyBoth(call, 'declined');
    await this.saveTombstone(
      call,
      'declined',
      null,
      Math.floor(Date.now() / 1000) + 300,
    );
    this.release(call);
    await this.persistTerminal(call, 'declined');
  }

  /** The caller cancels a ringing call before the callee answers: fans `cancelled`, then writes the
   *  `cancelled` bubble on the caller server. Idempotent on an already-terminal call. */
  async cancel(callerId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] cancel callerId=${callerId} sid=${callSid} state=${call?.state ?? 'null'}`,
    );
    if (!call) return; // already resolved — idempotent no-op
    if (call.callerId !== callerId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the caller can cancel',
      );
    }
    if (call.terminal) return;
    if (decideCallTransition(call.state, 'cancelled') === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot cancel while ${call.state}; use end after accepted`,
      );
    }
    call.terminal = { op: 'cancelled', endReason: null };
    this.notifyBoth(call, 'cancelled');
    await this.saveTombstone(
      call,
      'cancelled',
      null,
      Math.floor(Date.now() / 1000) + 300,
    );
    this.release(call);
    await this.persistTerminal(call, 'cancelled');
  }

  /** Either party ends an answered/connected call: fans `ended`, then writes the terminal bubble on
   *  the caller server. The persisted outcome is `completed` only if the media actually connected; an
   *  answered-but-never-connected call is `failed` or `timeout` (no duration). A connected call is
   *  `completed` for a normal hangup or `failed` for an unrecoverable media failure. */
  async end(
    userId: number,
    callSid: string,
    endReason?: string,
  ): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] end userId=${userId} sid=${callSid} state=${call?.state ?? 'null'} reason=${endReason ?? ''}`,
    );
    if (!call) return; // terminal retry — no second observable effect
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    if (call.terminal) return;
    if (decideCallTransition(call.state, 'ended') === 'invalid') {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `cannot end while ${call.state}`,
      );
    }
    const normalizedEndReason: 'completed' | 'timeout' | 'failed' =
      call.state === 'connected'
        ? endReason === 'failed'
          ? 'failed'
          : 'completed'
        : endReason === 'timeout'
          ? 'timeout'
          : 'failed';
    const outcome: CallOutcome = CallsService.endOutcome(normalizedEndReason);
    call.terminal = { op: 'ended', endReason: normalizedEndReason };
    this.notifyBoth(call, 'ended', { endReason: normalizedEndReason });
    await this.saveTombstone(
      call,
      'ended',
      normalizedEndReason,
      Math.floor(Date.now() / 1000) + 300,
    );
    this.release(call);
    await this.persistTerminal(call, outcome);
  }

  // ── signaling relay ───────────────────────────────────────────────────────────

  /** Relay one WebRTC frame to the peer. Authorize the sender is a participant, the target is the
   *  OTHER participant, and the call is live — then forward inline over SSE (local call) or via an S2S
   *  `signal` frame (federated call). Signal metadata is validated; only the data string is opaque. */
  async signal(
    fromUserId: number,
    dto: {
      id: string;
      callSid: string;
      toUserId: number;
      kind: CallSignalType;
      payload: string;
    },
  ): Promise<void> {
    const call = this.activeCalls.get(dto.callSid);
    if (!call) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no active call',
      );
    }
    if (fromUserId !== call.callerId && fromUserId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    const peer = fromUserId === call.callerId ? call.calleeId : call.callerId;
    if (dto.toUserId !== peer) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'relay target is not the call peer',
      );
    }
    if (call.terminal) {
      throw new BusinessException(BusinessCode.CALL_NOT_FOUND, 'call ended');
    }
    const localSignalKey = `${fromUserId}:${dto.id}`;
    if (call.localSignalIds.has(localSignalKey)) return;
    const senderRole =
      fromUserId === call.callerId ? ('caller' as const) : ('callee' as const);
    if (!isSignalAllowed(call.state, senderRole, dto.kind)) {
      throw new BusinessException(
        BusinessCode.CALL_INVALID_TRANSITION,
        `${dto.kind} is not valid from ${senderRole} while ${call.state}`,
      );
    }
    call.localSignalIds.add(localSignalKey);
    this.stage(call, fromUserId, dto.id, dto.kind, dto.payload); // store-and-forward: a peer offline now can GET it later
    if (call.peerDomain) {
      // Federated: relay over S2S to the peer server (the foreign participant isn't on this server).
      // Fire-and-forget: a dropped ICE candidate is harmless (the client re-gathers / retries).
      void this.federation
        .sendCallFrame(
          {
            fromLocalUserId: this.localUserId(call),
            to: this.peerAddress(call),
            callSid: call.callSid,
            op: 'signal',
            callType: call.callType,
            signalType: dto.kind,
            data: dto.payload,
            signalId: dto.id,
          },
          call.peerDomain,
        )
        .catch((e) => {
          if (this.convergePeerTerminal(call, e)) return;
          this.logger.warn(
            `failed to relay call signal (callSid=${call.callSid}): ${(e as Error).message}`,
          );
        });
    } else {
      this.sse.onCallSignal(dto.toUserId, {
        event: 'CALL_SIGNAL',
        id: dto.id,
        callSid: dto.callSid,
        fromUserId,
        kind: dto.kind,
        payload: dto.payload,
      });
    }
  }

  // ── inbound S2S frames (the FederationService→CallsService event bridge) ──────

  /** Apply one inbound federated call frame to the local call state machine. Invoked by the
   *  'call.frame.inbound' event (FederationService.handleCallFrame resolved the wire identities first).
   *  Throws on a federated callee-busy (`incoming`) so emitAsync rejects → the caller's server gets a
   *  HTTP 200 business rejection → writes an `unreachable` bubble. */
  @OnEvent('call.frame.inbound')
  async onInboundCallFrame(payload: InboundCallFramePayload): Promise<void> {
    const { peerDomain, namespaceId, frame } = payload;
    if (frame.op !== 'incoming') {
      const active = this.activeCalls.get(frame.callSid);
      if (!active || active.peerDomain !== peerDomain) {
        await this.resolveInactiveFrame(peerDomain, namespaceId, frame);
        return;
      }
      if (active.terminal) {
        this.resolveTerminatingFrame(active, frame);
        return;
      }
      if (
        frame.op === 'signal' &&
        active.seenSignalIds.has(frame.payload.signalId)
      ) {
        return; // first accepted ID wins before comparing a retried signal body
      }
      this.assertInboundActiveBinding(active, peerDomain, namespaceId, frame);
    }
    switch (frame.op) {
      case 'incoming':
        return this.onInboundIncoming(
          payload.localUserId!,
          payload.peerStubId!,
          peerDomain,
          namespaceId,
          payload.threadId!,
          frame,
        );
      case 'accepted':
        return this.onInboundAccepted(frame);
      case 'ringing':
        return this.onInboundRinging(frame);
      case 'connected':
        return this.onInboundConnected(frame);
      case 'video-upgraded':
        return this.onInboundVideoUpgraded(
          this.localUserId(this.activeCalls.get(frame.callSid)!),
          frame,
        );
      case 'signal':
        return this.onInboundSignal(frame);
      case 'declined':
      case 'cancelled':
      case 'ended':
      case 'missed':
        return this.onInboundTerminal(frame, payload.signatureExpiresAtSec);
    }
  }

  /** Resolve an inbound `incoming` retry/collision before FederationService parses either account. */
  @OnEvent('call.frame.incoming.preflight')
  onInboundIncomingPreflight(payload: {
    peerDomain: string;
    namespaceId: number;
    frame: Extract<S2SCallFrame, { op: 'incoming' }>;
  }): boolean {
    const { peerDomain, namespaceId, frame } = payload;
    const existing = this.activeCalls.get(frame.callSid);
    if (!existing) return false;
    if (existing.terminal) {
      this.resolveTerminatingFrame(existing, frame);
      return true;
    }
    const sameCall =
      existing.localRole === 'callee' &&
      existing.peerAccount === frame.payload.fromAccount &&
      existing.localAccount === frame.payload.toAccount &&
      existing.peerDomain === peerDomain &&
      existing.peerNamespaceId === namespaceId &&
      existing.initialCallType === frame.callType;
    if (sameCall) return true;
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'callSid conflicts with another active call',
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Bind every post-incoming frame to the exact active call and legal server direction. A signed peer
   *  still cannot use a guessed/colliding callSid to target another local participant or impersonate the
   *  opposite call role. Unknown (already-cleaned) calls are handled as no-op by the caller. */
  private assertInboundActiveBinding(
    call: LiveCall,
    peerDomain: string,
    namespaceId: number,
    frame: S2SCallFrame,
  ): void {
    const sameParticipants =
      peerDomain === call.peerDomain && namespaceId === call.peerNamespaceId;
    const sameType =
      frame.op === 'video-upgraded'
        ? frame.callType === 'VIDEO'
        : frame.callType === call.callType;
    const calleeToCallerOnly = [
      'ringing',
      'accepted',
      'connected',
      'declined',
      'missed',
    ].includes(frame.op);
    const callerToCalleeOnly = ['cancelled', 'video-upgraded'].includes(
      frame.op,
    );
    const legalDirection =
      (!calleeToCallerOnly || call.localRole === 'caller') &&
      (!callerToCalleeOnly || call.localRole === 'callee') &&
      (frame.op !== 'signal' ||
        (frame.payload.signalType !== 'offer' &&
          frame.payload.signalType !== 'answer') ||
        (frame.payload.signalType === 'offer'
          ? call.localRole === 'callee'
          : call.localRole === 'caller'));

    if (!sameParticipants || !sameType || !legalDirection) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'call frame does not match the active call binding or direction',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Inbound `incoming`: the caller server is ringing our local user. Register a callee-side live call
   *  (this server never authors the bubble) + ring the local user, unless the local user is busy
   *  (→ return CALL_BUSY in the ordinary envelope) or it is a duplicate ring (→ no-op). Quota `tick` runs HERE, after the
   *  live-state guard, so a busy reject / duplicate burns no quota. */
  private async onInboundIncoming(
    localUserId: number,
    peerStubId: number,
    peerDomain: string,
    namespaceId: number,
    threadId: number,
    frame: Extract<S2SCallFrame, { op: 'incoming' }>,
  ): Promise<void> {
    const existing = this.activeCalls.get(frame.callSid);
    if (existing) {
      if (existing.terminal) {
        this.resolveTerminatingFrame(existing, frame);
        return;
      }
      const sameCall =
        existing.localRole === 'callee' &&
        existing.callerId === peerStubId &&
        existing.calleeId === localUserId &&
        existing.peerAccount === frame.payload.fromAccount &&
        existing.localAccount === frame.payload.toAccount &&
        existing.peerDomain === peerDomain &&
        existing.peerNamespaceId === namespaceId &&
        existing.initialCallType === frame.callType;
      if (sameCall) return; // exact duplicate ring (retry) — already active here
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'callSid conflicts with another active call',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (this.activeByUser.has(localUserId)) {
      throw new BusinessException(
        BusinessCode.CALL_BUSY,
        'callee busy',
        HttpStatus.OK,
      );
    }
    // Register the callee-side call SYNCHRONOUSLY (before any await) so two concurrent `incoming` frames for the
    // same callee can't both pass the busy check across an await boundary and each register — the second
    // would overwrite the first's busy slot, double-ringing the callee and breaking the one-active-call
    // invariant. (The local initiate is already race-free: its check→register is synchronous.)
    const calleeCall: LiveCall = {
      callSid: frame.callSid,
      threadId,
      callerId: peerStubId, // the foreign caller → local stub (ring() reads its localized name/avatar)
      calleeId: localUserId,
      callType: frame.callType,
      initialCallType: frame.callType,
      state: 'ringing',
      startedAt: null,
      localRole: 'callee',
      peerAccount: frame.payload.fromAccount,
      localAccount: frame.payload.toAccount,
      peerDomain,
      peerNamespaceId: namespaceId,
      pendingOfferIce: [],
      pendingAnswerIce: [],
      localSignalIds: new Set(),
      seenSignalIds: new Set(),
    };
    this.activeCalls.set(calleeCall.callSid, calleeCall);
    this.activeByUser.set(localUserId, calleeCall.callSid);
    this.armRingTimer(calleeCall);
    this.syncCallState(calleeCall);
    // Best-effort quota tick: handleCallFrame already peek-gated the hard limit BEFORE the emitAsync.
    // A race-loss here (the budget consumed between peek and tick) must NOT unwind the ring — the caller
    // is already being processed and the callee is ringing. Logged, never thrown.
    await this.quota
      .tick(peerDomain, 'requests')
      .catch((e) =>
        this.logger.warn(
          `quota tick lost for inbound call (callSid=${frame.callSid}): ${(e as Error).message}`,
        ),
      );
    await this.ring(calleeCall);
  }

  /** Inbound `accepted`: the peer (callee) answered → ringing → accepted (negotiating, NOT connected).
   *  No startedAt, no timer clear (media may still fail). Idempotent. */
  private async onInboundAccepted(frame: S2SCallFrame): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return;
    const decision = decideCallTransition(call.state, 'accepted');
    if (decision === 'noop') return;
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `accepted is not valid while ${call.state}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    call.state = 'accepted';
    this.syncCallState(call);
    this.armConnectTimer(call);
    this.emit(this.localUserId(call), 'accepted', {
      callSid: call.callSid,
      threadId: call.threadId,
    });
  }

  /** Inbound `ringing` (federated): the callee server reports that the device is alerting → emit
   *  `ringing` to the caller so its UI shows "Ringing…". No state
   *  transition, no timer change (the inbound twin of {@link ringing}). Idempotent via `ringingAcked`
   *  (a replayed frame is a no-op). */
  private async onInboundRinging(frame: S2SCallFrame): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return;
    const decision = decideCallTransition(call.state, 'ringing');
    if (decision === 'noop') return;
    if (call.ringingAcked) return; // already relayed — idempotent
    call.ringingAcked = true;
    this.emit(this.localUserId(call), 'ringing', {
      callSid: call.callSid,
      threadId: call.threadId,
    });
  }

  /** Inbound `connected`: the peer reports the media leg is up → stamp startedAt (the real connect marker,
   *  from the frame so both servers agree) + transition accepted → connected + disarm the timer.
   *  Idempotent; a frame before the call is `accepted` is a no-op (race — the local client will report). */
  private onInboundConnected(
    frame: Extract<S2SCallFrame, { op: 'connected' }>,
  ): void {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return;
    const decision = decideCallTransition(call.state, 'connected');
    if (decision === 'noop') return; // first startedAt wins
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'connected requires an accepted call',
        HttpStatus.BAD_REQUEST,
      );
    }
    call.state = 'connected';
    call.startedAt = frame.payload.startedAt;
    this.clearStaged(call); // the caller server clears its staged signaling on connect too
    this.syncCallState(call);
    this.clearRingTimer(frame.callSid);
    this.emit(this.localUserId(call), 'connected', {
      callSid: call.callSid,
      startedAt: call.startedAt,
    });
  }

  /** Federated peer permanently upgraded the live call to video. The frame is idempotent and carries no
   *  media; clients perform SDP renegotiation separately over the ordinary signaling relay. */
  private onInboundVideoUpgraded(
    localUserId: number,
    frame: Extract<S2SCallFrame, { op: 'video-upgraded' }>,
  ): void {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return;
    const decision = decideVideoUpgrade(
      call.state,
      call.initialCallType,
      call.callType,
    );
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'video-upgraded is not valid for the current call state/type',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (decision === 'noop') return;
    call.callType = 'VIDEO';
    this.syncCallState(call);
    this.emit(localUserId, 'video-upgraded', {
      callSid: call.callSid,
      callType: 'VIDEO',
    });
  }

  /** Inbound `signal`: relay one WebRTC frame from the peer to the local participant. The signal type
   *  participates in direction and lifecycle validation; the data string remains opaque. */
  private async onInboundSignal(
    frame: Extract<S2SCallFrame, { op: 'signal' }>,
  ): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return;
    if (call.seenSignalIds.has(frame.payload.signalId)) return;
    const signalType = frame.payload.signalType;
    const senderRole =
      call.localRole === 'callee' ? ('caller' as const) : ('callee' as const);
    if (!isSignalAllowed(call.state, senderRole, signalType)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${signalType} is not valid from ${senderRole} while ${call.state}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.quota.tick(call.peerDomain!, 'signals');
    call.seenSignalIds.add(frame.payload.signalId);
    const localUserId = this.localUserId(call);
    const peerStubId =
      call.localRole === 'caller' ? call.calleeId : call.callerId;
    this.stage(
      call,
      peerStubId,
      frame.payload.signalId,
      frame.payload.signalType,
      frame.payload.data,
    );
    this.sse.onCallSignal(localUserId, {
      event: 'CALL_SIGNAL',
      id: frame.payload.signalId,
      callSid: frame.callSid,
      fromUserId: peerStubId,
      kind: frame.payload.signalType,
      payload: frame.payload.data,
    });
  }

  /** Inbound terminal (declined/cancelled/ended/missed): release the active call + emit the event to the
   *  local participant. The caller server authors the bubble; the callee server pulls it. CRITICAL idempotency:
   *  if the active call is already gone (the local path / a prior frame resolved it) → no-op, avoiding a
   *  double bubble + double fanout. */
  private async onInboundTerminal(
    frame: Extract<S2SCallFrame, { op: TerminalCallOperation }>,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return; // already resolved — idempotent no-op
    const decision = decideCallTransition(call.state, frame.op, {
      allowAcceptedCancel: true,
    });
    if (decision === 'invalid') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${frame.op} is not valid while ${call.state}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (frame.op === 'ended') {
      const reason = frame.payload.endReason;
      if (!isEndReasonAllowed(call.state, reason)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'ended reason is not valid for the active call state',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    call.terminal = {
      op: frame.op,
      endReason: frame.op === 'ended' ? frame.payload.endReason : null,
    };
    await this.saveTombstone(
      call,
      frame.op,
      frame.op === 'ended' ? frame.payload.endReason : null,
      signatureExpiresAtSec,
    );
    this.emit(this.localUserId(call), frame.op, { callSid: call.callSid });
    this.release(call);
    if (call.localRole === 'caller') {
      const outcome: CallOutcome =
        frame.op === 'ended'
          ? CallsService.endOutcome(frame.payload.endReason)
          : (frame.op as CallOutcome);
      await this.persistTerminal(call, outcome);
    }
  }

  private async resolveInactiveFrame(
    peerDomain: string,
    namespaceId: number,
    frame: Exclude<S2SCallFrame, { op: 'incoming' }>,
  ): Promise<void> {
    const tombstone = await this.database.db.query.callTombstone.findFirst({
      where: and(
        eq(callTombstone.peerDomain, peerDomain),
        eq(callTombstone.namespaceId, namespaceId),
        eq(callTombstone.callSid, frame.callSid),
        gt(callTombstone.expiresAt, new Date()),
      ),
    });
    if (!tombstone) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'unknown or inactive callSid',
        HttpStatus.OK,
      );
    }
    if (
      (['declined', 'cancelled', 'missed', 'ended'] as const).includes(
        frame.op as TerminalCallOperation,
      ) ||
      (frame.op === 'signal' &&
        tombstone.signalIds.includes(frame.payload.signalId))
    ) {
      return;
    }
    throw new BusinessException(
      tombstone.terminalOp === 'cancelled'
        ? BusinessCode.CALL_CANCELLED
        : BusinessCode.CALL_TERMINATED,
      tombstone.terminalOp === 'cancelled'
        ? 'call was already cancelled'
        : 'call was already terminated',
      HttpStatus.OK,
    );
  }

  private resolveTerminatingFrame(call: LiveCall, frame: S2SCallFrame): void {
    if (
      (['declined', 'cancelled', 'missed', 'ended'] as const).includes(
        frame.op as TerminalCallOperation,
      ) ||
      (frame.op === 'signal' && call.seenSignalIds.has(frame.payload.signalId))
    ) {
      return;
    }
    const terminal = call.terminal!;
    throw new BusinessException(
      terminal.op === 'cancelled'
        ? BusinessCode.CALL_CANCELLED
        : BusinessCode.CALL_TERMINATED,
      terminal.op === 'cancelled'
        ? 'call was already cancelled'
        : 'call was already terminated',
      HttpStatus.OK,
    );
  }

  private async saveTombstone(
    call: LiveCall,
    terminalOp: TerminalCallOperation,
    endReason: string | null,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    if (!call.peerDomain) return;
    if (call.peerNamespaceId === null)
      throw new Error('federated call has no captured namespace');
    const expiresAt = new Date(
      Math.min(
        signatureExpiresAtSec * 1000,
        Date.now() + CALL_TOMBSTONE_MAX_MS,
      ),
    );
    await this.database.db
      .delete(callTombstone)
      .where(lt(callTombstone.expiresAt, new Date()));
    await this.database.db
      .insert(callTombstone)
      .values({
        peerDomain: call.peerDomain,
        namespaceId: call.peerNamespaceId,
        callSid: call.callSid,
        terminalOp,
        endReason,
        initialCallType: call.initialCallType,
        finalCallType: call.callType,
        signalIds: [...call.seenSignalIds],
        expiresAt,
      })
      .onConflictDoNothing();
  }

  // ── terminal persist + bookkeeping ───────────────────────────────────────────

  /** Write the call's terminal record as a CALL Message bubble into the P2P thread and fan it out
   *  exactly like a normal send. Caller-server only — the callee server never writes (it pulls
   *  the caller server's bubble via message sync). `callSid` is the message's clientMessageId → the write
   *  is idempotent. `startedAt`/`durationMs` are included only when the call connected. */
  private async persistTerminal(
    call: LiveCall,
    outcome: CallOutcome,
  ): Promise<void> {
    if (call.localRole !== 'caller') return;
    const endedAt = Date.now();
    const content = buildCallContent(
      call.startedAt !== null
        ? {
            callType: call.callType,
            outcome,
            callerId: call.callerId,
            calleeId: call.calleeId,
            startedAt: call.startedAt,
            endedAt,
            durationMs: endedAt - call.startedAt,
          }
        : {
            callType: call.callType,
            outcome,
            callerId: call.callerId,
            calleeId: call.calleeId,
            endedAt,
          },
    );
    try {
      const msg = await this.messages.writeMsgToThread(
        call.callerId,
        call.threadId,
        content,
        ContentType.CALL,
        call.callSid,
      );
      // Fire-and-forget: the bubble is committed; a fan-out failure degrades to the normal chat-open /
      // missed-message pull backstop, never a lost record. (For a federated caller server, dispatch's
      // notifyOnSend marks the conversation dirty so the peer pulls the bubble.)
      void this.fanout.dispatch(msg);
    } catch (e) {
      // The in-memory call is already released; a persist failure forfeits this one record (the
      // CDR-at-end trade-off). Log and swallow — never leave an unhandled rejection.
      this.logger.error(
        `failed to persist terminal call record (callSid=${call.callSid}, outcome=${outcome}): ${(e as Error).message}`,
      );
    }
  }

  /** Free a call's live state: drop it from activeCalls, release both users' busy slots (only if they
   *  still point at THIS call — defensive against a re-entrant edge), and disarm its ring timer. */
  /** Mirror the call's state into the CallStateRegistry for both participants (SseService reads it for the
   *  HELLO `activeCall` so a reconnecting / freshly-booted client reconciles). Best-effort (ringing/connected);
   *  the native FSM driven by CALL_EVENT is the live authority — this is the connect-time snapshot. */
  private syncCallState(call: LiveCall): void {
    const base = {
      callSid: call.callSid,
      state: call.state,
      startedAt: call.startedAt,
      callType: call.callType,
    };
    this.callState.set(call.callerId, {
      ...base,
      peerUserId: call.calleeId,
      peerAccount: call.peerAccount ?? '',
      peerDomain: call.peerDomain ?? '',
      isCaller: true,
    });
    this.callState.set(call.calleeId, {
      ...base,
      peerUserId: call.callerId,
      peerAccount: '',
      peerDomain: '',
      isCaller: false,
    });
  }

  private release(call: LiveCall): void {
    this.logger.debug(
      `[call] release sid=${call.callSid} state=${call.state} caller=${call.callerId} callee=${call.calleeId}`,
    );
    this.activeCalls.delete(call.callSid);
    if (this.activeByUser.get(call.callerId) === call.callSid)
      this.activeByUser.delete(call.callerId);
    if (this.activeByUser.get(call.calleeId) === call.callSid)
      this.activeByUser.delete(call.calleeId);
    this.callState.clear(call.callerId);
    this.callState.clear(call.calleeId);
    this.clearRingTimer(call.callSid);
  }

  /** Stage one setup frame for the recipient to fetch (store-and-forward). The offer + the caller's ICE are
   *  staged for the CALLEE; the answer + the callee's ICE for the CALLER — derived from the sender. ICE is
   *  deduped by its raw payload (a retransmit / a replayed S2S frame must not duplicate). */
  private stage(
    call: LiveCall,
    senderId: number,
    id: string,
    kind: string,
    payload: string,
  ): void {
    const signal = { id, payload };
    if (kind === 'offer') {
      call.pendingOffer = signal;
    } else if (kind === 'answer') {
      call.pendingAnswer = signal;
    } else if (kind === 'ice') {
      const list =
        senderId === call.callerId
          ? call.pendingOfferIce
          : call.pendingAnswerIce;
      if (!list.some((item) => item.id === id)) list.push(signal);
    }
  }

  /** Drop the staged setup signaling (on connect — media up, setup consumed). */
  private clearStaged(call: LiveCall): void {
    call.pendingOffer = undefined;
    call.pendingAnswer = undefined;
    call.pendingOfferIce = [];
    call.pendingAnswerIce = [];
  }

  /** The staged setup signaling for `userId` to fetch (GET /calls/:sid/signaling). The caller fetches the
   *  answer + the callee's ICE; the callee fetches the offer + the caller's ICE. Participant-gated. Sync —
   *  it's an in-memory map read (no I/O); the controller awaits it harmlessly. */
  signaling(
    userId: number,
    callSid: string,
  ): {
    offer?: StagedCallSignal | null;
    answer?: StagedCallSignal | null;
    ice: StagedCallSignal[];
  } {
    const call = this.activeCalls.get(callSid);
    if (!call) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no active call',
      );
    }
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    return userId === call.callerId
      ? { answer: call.pendingAnswer ?? null, ice: call.pendingAnswerIce }
      : { offer: call.pendingOffer ?? null, ice: call.pendingOfferIce };
  }

  /** Push a CALL_EVENT lifecycle frame to one user's online devices (SSE is per-user → all of that
   *  user's live connections). */
  private emit(
    userId: number,
    type: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.sse.onCallEvent(userId, {
      event: 'CALL_EVENT',
      type,
      ts: Date.now(),
      ...extra,
    });
  }

  /** Fan a lifecycle event to BOTH participants. LOCAL call → both are on this server (emit to each).
   *  FEDERATED → emit to the one local participant + relay an S2S frame so the peer server emits to its
   *  local participant. `op` doubles as the CALL_EVENT type and the S2S frame op. */
  private notifyBoth(
    call: LiveCall,
    op: RelayedLifecycleOperation,
    extra: Record<string, unknown> = {},
  ): void {
    if (call.peerDomain) {
      this.emit(this.localUserId(call), op, {
        callSid: call.callSid,
        ...extra,
      });
      void this.sendFrame(call, op, extra);
    } else {
      this.emit(call.callerId, op, { callSid: call.callSid, ...extra });
      this.emit(call.calleeId, op, { callSid: call.callSid, ...extra });
    }
  }

  /** Enqueue a lifecycle S2S frame for the peer. FederationService preserves per-call lifecycle order;
   *  a failed delivery is logged and the peer's timeout remains the final cleanup backstop. */
  private sendFrame(
    call: LiveCall,
    op: RelayedLifecycleOperation,
    extra: Record<string, unknown>,
  ): void {
    const common = {
      fromLocalUserId: this.localUserId(call),
      to: this.peerAddress(call),
      callSid: call.callSid,
      callType: call.callType,
    };
    let params: Parameters<FederationService['sendCallFrame']>[0];
    if (op === 'connected') {
      if (typeof extra.startedAt !== 'number') {
        throw new Error('connected call frame requires startedAt');
      }
      params = { ...common, op, startedAt: extra.startedAt };
    } else if (op === 'ended') {
      const endReason = extra.endReason;
      if (
        endReason !== 'completed' &&
        endReason !== 'timeout' &&
        endReason !== 'failed'
      ) {
        throw new Error('ended call frame requires a valid endReason');
      }
      params = { ...common, op, endReason };
    } else {
      params = { ...common, op };
    }
    void this.federation.sendCallFrame(params, call.peerDomain!).catch((e) => {
      if (this.convergePeerTerminal(call, e)) return;
      this.logger.warn(
        `failed to relay call frame ${op} (callSid=${call.callSid}): ${(e as Error).message}`,
      );
    });
  }

  /** A peer tombstone is authoritative evidence that dependent frames must stop. */
  private convergePeerTerminal(call: LiveCall, error: unknown): boolean {
    if (
      !(error instanceof S2sResponseError) ||
      (error.code !== BusinessCode.CALL_CANCELLED &&
        error.code !== BusinessCode.CALL_TERMINATED)
    ) {
      return false;
    }
    if (this.activeCalls.get(call.callSid) === call) {
      this.emit(
        this.localUserId(call),
        error.code === BusinessCode.CALL_CANCELLED ? 'cancelled' : 'ended',
        { callSid: call.callSid },
      );
      this.release(call);
    }
    return true;
  }

  /** The LOCAL participant on this server (only meaningful for a federated call). */
  private localUserId(call: LiveCall): number {
    return call.localRole === 'caller' ? call.callerId : call.calleeId;
  }

  /** The foreign participant's wire address (only meaningful for a federated call). */
  private peerAddress(call: LiveCall): S2SAddress {
    return { account: call.peerAccount!, domain: call.peerDomain! };
  }

  /** Map the advisory endReason to the persisted terminal outcome. */
  private static endOutcome(endReason?: string): CallOutcome {
    return endReason === 'failed' || endReason === 'timeout'
      ? 'failed'
      : 'completed';
  }

  private armRingTimer(call: LiveCall): void {
    this.clearRingTimer(call.callSid);
    // The caller server uses the longer safety-net; local calls and the callee server use 45 seconds.
    const ms =
      call.localRole === 'caller' && call.peerDomain
        ? FED_SAFETY_NET_MS
        : RING_TIMEOUT_MS;
    const timer = setTimeout(() => {
      void this.timeoutMissed(call.callSid);
    }, ms);
    this.ringTimers.set(call.callSid, timer);
  }

  private armConnectTimer(call: LiveCall): void {
    this.clearRingTimer(call.callSid);
    const ms =
      call.localRole === 'caller' && call.peerDomain
        ? FED_CONNECT_SAFETY_NET_MS
        : CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      void this.timeoutMissed(call.callSid);
    }, ms);
    this.ringTimers.set(call.callSid, timer);
  }

  private clearRingTimer(callSid: string): void {
    const t = this.ringTimers.get(callSid);
    if (t) {
      clearTimeout(t);
      this.ringTimers.delete(callSid);
    }
  }

  /** Server-side ring/connect timeout. Federation wire outcomes are role-specific and normative:
   * callee ring → missed; caller safety ring → cancelled; either connect timeout → ended(timeout). */
  private async timeoutMissed(callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call || call.state === 'connected') return; // gone, or connected (timer was cleared — defensive)
    const outcome: CallOutcome = call.state === 'ringing' ? 'missed' : 'failed';
    const timeout = timeoutLifecycle(call.state);
    const eventExtra =
      timeout.endReason === null ? {} : { endReason: timeout.endReason };
    if (call.peerDomain) {
      const terminalOp: TerminalCallOperation =
        timeout.operation === 'missed' && call.localRole === 'caller'
          ? 'cancelled'
          : timeout.operation;
      const endReason = timeout.endReason;
      call.terminal = { op: terminalOp, endReason };
      this.emit(this.localUserId(call), timeout.operation, {
        callSid,
        ...eventExtra,
      });
      await this.saveTombstone(
        call,
        terminalOp,
        endReason,
        Math.floor(Date.now() / 1000) + 300,
      );
      this.release(call);
      this.sendFrame(call, terminalOp, endReason ? { endReason } : {});
      if (call.localRole === 'caller')
        await this.persistTerminal(call, outcome);
    } else {
      call.terminal = {
        op: timeout.operation,
        endReason: timeout.endReason,
      };
      this.notifyBoth(call, timeout.operation, eventExtra);
      this.release(call);
      await this.persistTerminal(call, outcome);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.ringTimers.values()) clearTimeout(t);
    this.ringTimers.clear();
  }
}
