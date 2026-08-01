import {
  Injectable,
  Logger,
  HttpStatus,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { user } from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { CallStateRegistry } from '../gateway/call-state.registry.js';
import { PushService } from '../push/push.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { FederationService } from '../federation/federation.service.js';
import type {
  S2SCallFrame,
  S2SCallOp,
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

/** Server-side ringing timeout on the CALLEE's server: a RINGING call flips to MISSED if the callee
 *  does not answer. The caller's client also has its own (UI) timeout; this is the authoritative
 *  server-side backstop so an unanswered call never lingers live. Used for LOCAL calls AND the federated
 *  MIRROR (the callee's server — the only side that knows whether the callee answered). */
const RING_TIMEOUT_MS = 45_000;
/** Federated ORIGIN (caller's server) safety-net. Strictly longer than the callee's RING_TIMEOUT_MS +
 *  S2S RTT, so the callee's `accepted`/terminal frames land first. Fires only on partition/crash (no
 *  terminal frame arrived from the peer) → writes a `missed` bubble. Avoids the accept-after-missed race
 *  a symmetric-timer design would create. */
const FED_SAFETY_NET_MS = 60_000;

/** The live (in-memory) state of one in-flight call. Only `ringing` / `accepted` are live; every
 *  terminal transition writes a CALL Message bubble (the persisted record, on the ORIGIN server only)
 *  and drops this entry. */
interface LiveCall {
  /** Client-generated ULID/UUID — the call's idempotency key + the address every frame carries.
   *  Becomes the terminal bubble's clientMessageId (idempotent terminal write). */
  callSid: string;
  threadId: number;
  /** The caller. LOCAL on the origin server; a foreigner STUB on the mirror server. */
  callerId: number;
  /** The callee. LOCAL on the mirror server; a foreigner STUB on the origin server. */
  calleeId: number;
  callType: CallMediaType;
  state: 'ringing' | 'accepted' | 'connected';
  /** Connect epoch-ms (set when the media leg connects — NOT on accept). Null until connected. */
  startedAt: number | null;
  /** True once the callee side has acked that it is alerting the user. Set by the LOCAL {@link ringing}
   *  method (a callee device POSTed /calls/ringing) OR by {@link onInboundRinging} (a federated ORIGIN
   *  received the S2S `ringing` relay from the mirror). Guards the `ringing` fan-out so a multi-device
   *  double-ack / a replayed S2S frame emits CALL_EVENT{ringing} exactly once. The call does NOT transition
   *  on a ring ack, so this bit — not the state — is the idempotency key. */
  ringingAcked?: boolean;
  /** true on the CALLER's server (the origin — it alone authors the terminal bubble); false on the
   *  callee's server (the mirror — it pulls the bubble via the message-sync). For a LOCAL call both
   *  participants are on this server, so origin is true and peerAccount/peerDomain are null. */
  origin: boolean;
  /** The foreign participant's account; null for a local call. */
  peerAccount: string | null;
  /** The foreign participant's home domain (the S2S POST target); null for a local call. */
  peerDomain: string | null;
  /** Server-authoritative setup signaling (store-and-forward). The caller's offer + ICE are staged for the
   *  CALLEE to fetch; the callee's answer + ICE for the CALLER. Each server stages for its LOCAL participant
   *  (origin for the caller, mirror for the callee), so a callee that was OFFLINE when the offer trickled over
   *  SSE still gets it on accept via GET /calls/:sid/signaling — no client-side re-offer hack. Cleared on
   *  `connected` (media up → setup consumed) and on release (call ends). ICE payloads are stored as the raw
   *  client JSON strings, deduped. */
  pendingOffer?: string;
  pendingAnswer?: string;
  pendingOfferIce: string[];
  pendingAnswerIce: string[];
}

/** The payload FederationService emits on 'call.frame.inbound' (the inbound bridge — see the
 *  FederationService→CallsService event edge). Identities are already resolved to LOCAL ids by the
 *  federation layer; CallsService applies the frame to its in-memory state machine. */
export interface InboundCallFramePayload {
  /** The LOCAL user this frame is for (the callee for `incoming`; the local participant otherwise). */
  localUserId: number;
  /** The foreign sender's LOCAL stub id (the caller's stub on the mirror; used as CALL_EVENT/CALL_SIGNAL
   *  `fromUserId` so the client renders the peer from the localized stub). */
  peerStubId: number;
  /** The LOCAL P2P thread between the local user and the peer stub. */
  threadId: number;
  frame: S2SCallFrame;
}

/**
 * 1:1 WebRTC call lifecycle + signaling relay. The server is the signaling COORDINATOR and the
 * lifecycle OWNER — it never carries media (P2P DTLS-SRTP; coturn is the TURN relay fallback, OFF in
 * current SOMS).
 *
 * LIVE state is a single-instance in-memory map (one active call per user — the busy-line invariant).
 * The PERSISTED record is a {@link ContentType.CALL} Message bubble, authored at the call's TERMINAL
 * state by the ORIGIN (caller's) server only — so BOTH participants see every call record (the callee's
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
   *  STUB also occupies a slot on the origin — correct: the foreign user can be in only one call.) */
  private readonly activeByUser = new Map<number, string>();
  /** Per-call ringing timers (ringing → missed), keyed by callSid. Cleared on any earlier terminal
   *  transition + on shutdown. */
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
    private readonly push: PushService,
    private readonly participants: ThreadParticipantService,
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
    // impossible in practice (client-generated ULID, globally unique); refuse rather than leak.
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
      columns: { isForeigner: true, account: true, domain: true },
    });
    const federated = !!callee?.isForeigner;

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
      state: 'ringing',
      startedAt: null,
      origin: true, // the caller's server is always the origin (authors the terminal bubble)
      peerAccount: federated ? callee!.account : null,
      peerDomain: federated ? callee!.domain : null,
      pendingOfferIce: [],
      pendingAnswerIce: [],
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
   *  calls + the federated MIRROR (where callerId is the localized foreigner stub → same-origin avatar). */
  private async ring(call: LiveCall): Promise<void> {
    const caller = await this.database.db.query.user.findFirst({
      where: eq(user.id, call.callerId),
      columns: { name: true, avatar: true },
    });
    this.emit(call.calleeId, 'incoming', {
      callSid: call.callSid,
      threadId: call.threadId,
      callerUserId: call.callerId,
      callerName: caller?.name ?? '',
      callerAvatar: caller?.avatar ?? '',
      callType: call.callType,
    });
    void this.push.dispatchForCall(call.calleeId, {
      callSid: call.callSid,
      callerUserId: call.callerId,
      // The caller's display name rides inline so a COLD-STARTED callee (no live SSE → it never received the
      // CALL_EVENT{incoming} frame that carries name/avatar) can render the incoming UI with no extra fetch.
      // Calls are ephemeral coordination, not identity-only, so this matches the CALL_EVENT payload shape.
      callerName: caller?.name ?? '',
      callerAvatar: caller?.avatar ?? '',
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
    if (!call || call.state !== 'ringing') {
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
    call.state = 'accepted';
    this.notifyBoth(call, 'accepted', { threadId: call.threadId });
  }

  /** The callee's device acknowledges it is alerting the user (it received the `incoming` ring and is now
   *  ringing the UI). This is NOT progress toward connect — the call stays `ringing`, the ringing timer
   *  keeps running, and `startedAt` is untouched (the real connect marker is {@link connected}). Fans a
   *  `ringing` event so the caller's UI flips "Calling…" → "Ringing…"; the server cannot otherwise know the
   *  callee device is alerting (receiving the SSE `incoming` only proves the socket arrived). Idempotent
   *  across the callee's devices (a second device's ack is a no-op). Structurally a twin of {@link accept}
   *  MINUS the state transition + timer clear. For a federated call, notifyBoth relays an S2S `ringing`
   *  frame to the origin (handled inbound by {@link onInboundRinging}). */
  async ringing(calleeId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call || call.state !== 'ringing') {
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
    if (call.ringingAcked) return; // another of the callee's devices already acked — no-op
    call.ringingAcked = true;
    this.notifyBoth(call, 'ringing', { threadId: call.threadId });
  }

  /** Either client reports the media leg is actually up (DTLS-SRTP connected): accepted → connected,
   *  stamping `startedAt` (the REAL connect authority — the basis for the bubble's duration) + disarming
   *  the ringing timer. Idempotent: a second report (the other party) is a no-op. The first to report
   *  wins; for a federated call the frame carries `startedAt` so the origin stamps the same value. */
  async connected(userId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call || call.state === 'connected') return; // gone, or the other party already reported connect
    if (call.state !== 'accepted') {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'call not answered',
      );
    }
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
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
    if (!call || call.state !== 'connected') {
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
    if (call.callType === 'VIDEO') return;
    call.callType = 'VIDEO';
    this.syncCallState(call);
    this.notifyBoth(call, 'video-upgraded', {
      callType: 'VIDEO',
      upgradedBy: userId,
    });
  }

  /** The callee declines a ringing call: fans `declined`, then writes the terminal bubble on the ORIGIN.
   *  Idempotent on an already-terminal call (no live entry → no-op). */
  async decline(calleeId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] decline calleeId=${calleeId} sid=${callSid} state=${call?.state ?? 'null'}`,
    );
    if (!call || call.state !== 'ringing') return; // already resolved — idempotent no-op
    if (call.calleeId !== calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the callee can decline',
      );
    }
    this.notifyBoth(call, 'declined');
    this.release(call);
    await this.persistTerminal(call, 'declined');
  }

  /** The caller cancels a ringing call before the callee answers: fans `cancelled`, then writes the
   *  `cancelled` bubble on the ORIGIN. Idempotent on an already-terminal call. */
  async cancel(callerId: number, callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] cancel callerId=${callerId} sid=${callSid} state=${call?.state ?? 'null'}`,
    );
    if (!call || call.state !== 'ringing') return; // already resolved — idempotent no-op
    if (call.callerId !== callerId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'only the caller can cancel',
      );
    }
    this.notifyBoth(call, 'cancelled');
    this.release(call);
    await this.persistTerminal(call, 'cancelled');
  }

  /** Either party ends an answered/connected call: fans `ended`, then writes the terminal bubble on
   *  the ORIGIN. The persisted outcome is `completed` only if the media actually connected; an
   *  answered-but-never-connected call is `failed` (a connection failure, no duration). `endReason` failed/timeout on
   *  a connected call → `failed` (connected-then-failed, with duration). */
  async end(
    userId: number,
    callSid: string,
    endReason?: string,
  ): Promise<void> {
    const call = this.activeCalls.get(callSid);
    this.logger.debug(
      `[call] end userId=${userId} sid=${callSid} state=${call?.state ?? 'null'} reason=${endReason ?? ''}`,
    );
    if (!call || (call.state !== 'accepted' && call.state !== 'connected')) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_FOUND,
        'no answered call to end',
      );
    }
    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_PARTICIPANT,
        'not a party to this call',
      );
    }
    const status: CallOutcome =
      call.state === 'connected'
        ? CallsService.endStatus(endReason) // connected → completed, or failed if endReason says so
        : 'failed'; // accepted-but-never-connected → connection failure (persistTerminal omits startedAt/duration)
    this.notifyBoth(call, 'ended', { endReason });
    this.release(call);
    await this.persistTerminal(call, status);
  }

  // ── signaling relay ───────────────────────────────────────────────────────────

  /** Relay one WebRTC frame to the peer. Authorize the sender is a participant, the target is the
   *  OTHER participant, and the call is live — then forward inline over SSE (local call) or via an S2S
   *  `signal` frame (federated call). The payload is opaque to the server: never inspected/stored. */
  async signal(
    fromUserId: number,
    dto: { callSid: string; toUserId: number; kind: string; payload: string },
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
    this.stage(call, fromUserId, dto.kind, dto.payload); // store-and-forward: a peer offline now can GET it later
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
            kind: dto.kind,
            payload: dto.payload,
          },
          call.peerDomain,
        )
        .catch((e) => {
          this.logger.warn(
            `failed to relay call signal (callSid=${call.callSid}): ${(e as Error).message}`,
          );
        });
    } else {
      this.sse.onCallSignal(dto.toUserId, {
        event: 'CALL_SIGNAL',
        callSid: dto.callSid,
        fromUserId,
        kind: dto.kind,
        payload: dto.payload,
      });
    }
  }

  // ── inbound S2S frames (the FederationService→CallsService event bridge) ──────

  /** Apply one inbound federated call frame to the local mirror state machine. Invoked by the
   *  'call.frame.inbound' event (FederationService.handleCallFrame resolved the wire identities first).
   *  Throws on a federated callee-busy (`incoming`) so emitAsync rejects → the caller's server gets a
   *  non-demoting 422 → writes an `unreachable` bubble. */
  @OnEvent('call.frame.inbound')
  async onInboundCallFrame(payload: InboundCallFramePayload): Promise<void> {
    const { localUserId, peerStubId, threadId, frame } = payload;
    switch (frame.op) {
      case 'incoming':
        return this.onInboundIncoming(localUserId, peerStubId, threadId, frame);
      case 'accepted':
        return this.onInboundAccepted(frame);
      case 'ringing':
        return this.onInboundRinging(frame);
      case 'connected':
        return this.onInboundConnected(frame);
      case 'video-upgraded':
        return this.onInboundVideoUpgraded(localUserId, frame);
      case 'signal':
        return this.onInboundSignal(localUserId, peerStubId, frame);
      case 'declined':
      case 'cancelled':
      case 'ended':
      case 'missed':
        return this.onInboundTerminal(frame);
    }
  }

  /** Inbound `incoming`: the peer server is ringing OUR local user. Register a MIRROR live call (origin
   *  false — this server never authors the bubble) + ring the local user, unless the local user is busy
   *  (→ throw 422, non-demoting) or it is a duplicate ring (→ no-op). Quota `tick` runs HERE, after the
   *  mirror-state guard, so a busy reject / duplicate burns no quota. */
  private async onInboundIncoming(
    localUserId: number,
    peerStubId: number,
    threadId: number,
    frame: S2SCallFrame,
  ): Promise<void> {
    if (this.activeCalls.has(frame.callSid)) return; // duplicate ring (retry) — already ringing here
    if (this.activeByUser.has(localUserId)) {
      // 422 is outside postSigned's success-set (200|202|204|409) AND demote-set (401|403|≥500) → the
      // caller's server throws without demoting a healthy peer.
      throw new BusinessException(
        BusinessCode.CALL_BUSY,
        'callee busy',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // Register the mirror SYNCHRONOUSLY (before any await) so two concurrent `incoming` frames for the
    // same callee can't both pass the busy check across an await boundary and each register — the second
    // would overwrite the first's busy slot, double-ringing the callee and breaking the one-active-call
    // invariant. (The local initiate is already race-free: its check→register is synchronous.)
    const mirror: LiveCall = {
      callSid: frame.callSid,
      threadId,
      callerId: peerStubId, // the foreign caller → local stub (ring() reads its localized name/avatar)
      calleeId: localUserId,
      callType: frame.callType,
      state: 'ringing',
      startedAt: null,
      origin: false,
      peerAccount: frame.from.account,
      peerDomain: frame.from.domain,
      pendingOfferIce: [],
      pendingAnswerIce: [],
    };
    this.activeCalls.set(mirror.callSid, mirror);
    this.activeByUser.set(localUserId, mirror.callSid);
    this.armRingTimer(mirror);
    this.syncCallState(mirror);
    // Best-effort quota tick: handleCallFrame already peek-gated the hard limit BEFORE the emitAsync.
    // A race-loss here (the budget consumed between peek and tick) must NOT unwind the ring — the caller
    // already got its 202 and the callee is ringing. Logged, never thrown.
    await this.quota
      .tick(frame.origin, 'requests')
      .catch((e) =>
        this.logger.warn(
          `quota tick lost for inbound call (callSid=${frame.callSid}): ${(e as Error).message}`,
        ),
      );
    await this.ring(mirror);
  }

  /** Inbound `accepted`: the peer (callee) answered → ringing → accepted (negotiating, NOT connected).
   *  No startedAt, no timer clear (media may still fail). Idempotent. */
  private async onInboundAccepted(frame: S2SCallFrame): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call || call.state !== 'ringing') return; // already resolved / accepted
    call.state = 'accepted';
    this.emit(this.localUserId(call), 'accepted', {
      callSid: call.callSid,
      threadId: call.threadId,
    });
  }

  /** Inbound `ringing` (federated): the mirror relayed that the callee's device is alerting → emit
   *  `ringing` to the ORIGIN's local participant (the caller) so its UI shows "Ringing…". No state
   *  transition, no timer change (the inbound twin of {@link ringing}). Idempotent via `ringingAcked`
   *  (a replayed frame is a no-op). */
  private async onInboundRinging(frame: S2SCallFrame): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call || call.state !== 'ringing') return; // already resolved
    if (call.ringingAcked) return; // already relayed — idempotent
    call.ringingAcked = true;
    this.emit(this.localUserId(call), 'ringing', {
      callSid: call.callSid,
      threadId: call.threadId,
    });
  }

  /** Inbound `connected`: the peer reports the media leg is up → stamp startedAt (the real connect marker,
   *  from the frame so origin + mirror agree) + transition accepted → connected + disarm the timer.
   *  Idempotent; a frame before the call is `accepted` is a no-op (race — the local client will report). */
  private onInboundConnected(frame: S2SCallFrame): void {
    const call = this.activeCalls.get(frame.callSid);
    if (!call || call.state === 'connected') return; // gone / already connected
    if (call.state !== 'accepted') return; // not answered yet — race, drop
    call.state = 'connected';
    call.startedAt = frame.startedAt ?? Date.now();
    this.clearStaged(call); // the origin clears its staged signaling on connect too
    this.syncCallState(call);
    this.clearRingTimer(frame.callSid);
    this.emit(this.localUserId(call), 'connected', { callSid: call.callSid });
  }

  /** Federated peer permanently upgraded the live call to video. The frame is idempotent and carries no
   *  media; clients perform SDP renegotiation separately over the ordinary signaling relay. */
  private onInboundVideoUpgraded(
    localUserId: number,
    frame: S2SCallFrame,
  ): void {
    const call = this.activeCalls.get(frame.callSid);
    if (!call || call.state !== 'connected') return;
    call.callType = 'VIDEO';
    this.syncCallState(call);
    this.emit(localUserId, 'video-upgraded', {
      callSid: call.callSid,
      callType: 'VIDEO',
    });
  }

  /** Inbound `signal`: relay one WebRTC frame from the peer to the local participant. No authorization
   *  beyond the mirror's existence (the S2S frame is already signature + trust bound). A dropped frame
   *  (no mirror) is a no-op — the client re-gathers ICE. */
  private onInboundSignal(
    localUserId: number,
    peerStubId: number,
    frame: S2SCallFrame,
  ): void {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return; // race — client will retry
    this.stage(call, peerStubId, frame.kind!, frame.payload!); // mirror stages for its local participant
    this.sse.onCallSignal(localUserId, {
      event: 'CALL_SIGNAL',
      callSid: frame.callSid,
      fromUserId: peerStubId,
      kind: frame.kind!,
      payload: frame.payload!,
    });
  }

  /** Inbound terminal (declined/cancelled/ended/missed): release the mirror + emit the event to the
   *  local participant. The ORIGIN authors the bubble (the non-origin pulls it). CRITICAL idempotency:
   *  if the mirror is already gone (the local path / a prior frame resolved it) → no-op, avoiding a
   *  double bubble + double fanout. */
  private async onInboundTerminal(frame: S2SCallFrame): Promise<void> {
    const call = this.activeCalls.get(frame.callSid);
    if (!call) return; // already resolved — idempotent no-op
    this.emit(this.localUserId(call), frame.op, { callSid: call.callSid });
    this.release(call);
    if (call.origin) {
      const status: CallOutcome =
        frame.op === 'ended'
          ? CallsService.endStatus(frame.endReason)
          : (frame.op as CallOutcome);
      await this.persistTerminal(call, status);
    }
  }

  // ── terminal persist + bookkeeping ───────────────────────────────────────────

  /** Write the call's terminal record as a CALL Message bubble into the P2P thread and fan it out
   *  exactly like a normal send. ORIGIN-only — the non-origin (callee's server) never writes (it pulls
   *  the origin's bubble via the message sync). `callSid` is the message's clientMessageId → the write
   *  is idempotent. `startedAt`/`durationMs` are included only when the call connected. */
  private async persistTerminal(
    call: LiveCall,
    status: CallOutcome,
  ): Promise<void> {
    if (!call.origin) return; // the callee's server pulls the origin's bubble — never author one
    const endedAt = Date.now();
    const content = buildCallContent(
      call.startedAt !== null
        ? {
            callType: call.callType,
            status,
            callerId: call.callerId,
            calleeId: call.calleeId,
            startedAt: call.startedAt,
            endedAt,
            durationMs: endedAt - call.startedAt,
          }
        : {
            callType: call.callType,
            status,
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
      // missed-message pull backstop, never a lost record. (For a federated origin, dispatch's
      // notifyOnSend marks the conversation dirty so the peer pulls the bubble.)
      void this.fanout.dispatch(msg);
    } catch (e) {
      // The in-memory call is already released; a persist failure forfeits this one record (the
      // CDR-at-end trade-off). Log and swallow — never leave an unhandled rejection.
      this.logger.error(
        `failed to persist terminal call record (callSid=${call.callSid}, status=${status}): ${(e as Error).message}`,
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
      isCaller: true,
    });
    this.callState.set(call.calleeId, {
      ...base,
      peerUserId: call.callerId,
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
    kind: string,
    payload: string,
  ): void {
    if (kind === 'offer') {
      call.pendingOffer = payload;
    } else if (kind === 'answer') {
      call.pendingAnswer = payload;
    } else if (kind === 'ice') {
      const list =
        senderId === call.callerId
          ? call.pendingOfferIce
          : call.pendingAnswerIce;
      if (!list.includes(payload)) list.push(payload);
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
  ): { offer?: string | null; answer?: string | null; ice: string[] } {
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
    op: string,
    extra: Record<string, unknown> = {},
  ): void {
    if (call.peerDomain) {
      this.emit(this.localUserId(call), op, {
        callSid: call.callSid,
        ...extra,
      });
      void this.sendFrame(call, op as S2SCallOp, extra);
    } else {
      this.emit(call.callerId, op, { callSid: call.callSid, ...extra });
      this.emit(call.calleeId, op, { callSid: call.callSid, ...extra });
    }
  }

  /** Relay a lifecycle S2S frame to the peer server, fire-and-forget (a lost frame is covered by the
   *  peer's own timeout / the origin's safety-net). Carries endReason/startedAt when present. */
  private sendFrame(
    call: LiveCall,
    op: S2SCallOp,
    extra: Record<string, unknown>,
  ): void {
    void this.federation
      .sendCallFrame(
        {
          fromLocalUserId: this.localUserId(call),
          to: this.peerAddress(call),
          callSid: call.callSid,
          op,
          callType: call.callType,
          ...(typeof extra.endReason === 'string'
            ? { endReason: extra.endReason }
            : {}),
          ...(typeof extra.startedAt === 'number'
            ? { startedAt: extra.startedAt }
            : {}),
        },
        call.peerDomain!,
      )
      .catch((e) => {
        this.logger.warn(
          `failed to relay call frame ${op} (callSid=${call.callSid}): ${(e as Error).message}`,
        );
      });
  }

  /** The LOCAL participant on this server (only meaningful for a federated call): the caller on the
   *  origin, the callee on the mirror. */
  private localUserId(call: LiveCall): number {
    return call.origin ? call.callerId : call.calleeId;
  }

  /** The foreign participant's wire address (only meaningful for a federated call). */
  private peerAddress(call: LiveCall): S2SAddress {
    return { account: call.peerAccount!, domain: call.peerDomain! };
  }

  /** Map the advisory endReason to the persisted terminal outcome. */
  private static endStatus(endReason?: string): CallOutcome {
    return endReason === 'failed' || endReason === 'timeout'
      ? 'failed'
      : 'completed';
  }

  private armRingTimer(call: LiveCall): void {
    this.clearRingTimer(call.callSid);
    // The federated ORIGIN (caller's server) uses the longer safety-net; everything else (local calls +
    // the federated mirror) uses the 45s ringing timeout.
    const ms =
      call.origin && call.peerDomain ? FED_SAFETY_NET_MS : RING_TIMEOUT_MS;
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

  /** Server-side ringing/answer timeout backstop. By the call's state at fire time:
   *   - `ringing` (callee never answered) → `missed`;
   *   - `accepted` (callee answered but the media leg never came up) → `failed` (a connection failure);
   *   - `connected` → no-op (the timer was cleared on connect; defensive).
   *  The federated ORIGIN authors the bubble; the MIRROR tells the origin to (a `missed` frame for the
   *  ringing case, an `ended`+failed frame for the answered case); a LOCAL call authors + notifies. */
  private async timeoutMissed(callSid: string): Promise<void> {
    const call = this.activeCalls.get(callSid);
    if (!call || call.state === 'connected') return; // gone, or connected (timer was cleared — defensive)
    const status: CallOutcome = call.state === 'ringing' ? 'missed' : 'failed';
    if (call.origin && call.peerDomain) {
      this.emit(call.callerId, status, { callSid });
      this.release(call);
      await this.persistTerminal(call, status);
    } else if (call.peerDomain) {
      this.release(call);
      // missed → 'missed' frame; answered-then-no-media → 'ended' with failed reason (origin maps to failed).
      this.sendFrame(
        call,
        status === 'missed' ? 'missed' : 'ended',
        status === 'failed' ? { endReason: 'failed' } : {},
      );
    } else {
      this.emit(call.callerId, status, { callSid });
      this.release(call);
      await this.persistTerminal(call, status);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.ringTimers.values()) clearTimeout(t);
    this.ringTimers.clear();
  }
}
