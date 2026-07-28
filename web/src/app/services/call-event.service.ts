import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Subject, Subscription, filter } from 'rxjs';
import { WebsocketService } from './websocket.service';
import {
  CallAdapterService,
  IDLE_CALL,
  type CallPhase,
  type CallSnapshot,
} from './call-adapter';

/**
 * The payload shape of a CALL_EVENT SSE frame (docs/android-calls-client.md §1). `type` is the lifecycle
 * (incoming | accepted | connected | declined | cancelled | ended | missed | ringing); the rest are
 * type-specific (only `incoming` carries the caller's display name/avatar).
 */
interface CallEventPayload {
  type: string;
  callSid: string;
  threadId?: number;
  callerUserId?: number;
  callerName?: string;
  callerAvatar?: string;
  callType?: 'AUDIO' | 'VIDEO';
  startedAt?: number;
  endReason?: string;
}

/** Maps a CALL_EVENT `type` to the UI {@link CallPhase}. Terminal types (declined/cancelled/missed/ended)
 *  map to `'ended'`, which {@link commit} normalizes back to `'idle'` — the terminal CALL bubble in the
 *  thread is the user-visible record, so the call overlay simply dismisses on terminal. `incoming` is
 *  handled specially (it seeds the whole snapshot); the caller's `ringing` only applies to the caller. */
const PHASE_BY_EVENT: Record<string, CallPhase> = {
  ringing: 'ringing',
  accepted: 'connecting',
  connected: 'connected',
  declined: 'ended',
  cancelled: 'ended',
  missed: 'ended',
  ended: 'ended',
};

/**
 * Routes the call's realtime events into ONE {@link callState} signal the call UI reads — the Angular half
 * of "native owns the call, the WebView is disposable chrome" (mirrors how {@link GroupEventService} routes
 * GROUP_* and how {@link WebsocketService} self-starts).
 *
 * Two feeds merge into `callState`:
 *  - the SSE `CALL_EVENT` lifecycle (the incoming frame carries the peer's display name/avatar, which the
 *    native snapshot does NOT);
 *  - the native `window.__SOMS_CALL_EVENT__` snapshot push (authoritative for phase/mediaState/startedAt/
 *    muted — the native CallController FSM owns the RTCPeerConnection).
 * Last-write-wins per field; peerName + peerAvatar prefer the native value when present (the caller passes
 * the callee's at initiate; the callee's come from the FCM push / SSE frame), else keep the SSE-set one.
 * On Android the WebRTC signaling (CALL_SIGNAL) is handled entirely natively, so this
 * service consumes CALL_EVENT only.
 *
 * `callState` is normalized to be either an ACTIVE phase or `'idle'`: a terminal ('ended') is folded to
 * `'idle'` (the call overlay dismisses; the terminal record is the CALL bubble). So the overlay gates on
 * `phase !== 'idle'`.
 *
 * Root singleton, subscribes in its constructor. Injected for the app's lifetime so an incoming ring is
 * never missed (AppComponent injects it eagerly). On a WebView re-attach it re-seeds `callState` from the
 * native snapshot so a call live across the reclaim re-binds.
 */
@Injectable({ providedIn: 'root' })
export class CallEventService implements OnDestroy {
  private readonly ws = inject(WebsocketService);
  private readonly adapter = inject(CallAdapterService);

  /** The merged live-call state. `phase === 'idle'` when no call. The call overlay reads this signal. */
  readonly callState = signal<CallSnapshot>(IDLE_CALL);

  /** Fired (with the snapshot) when an incoming ring arrives — the shell mounts the incoming-call UI. */
  readonly incoming$ = new Subject<CallSnapshot>();

  private readonly sub: Subscription;

  constructor() {
    // Seed from native (re-derive on boot / WebView reclaim — a call may already be live). On web/desktop
    // (no native bridge) this returns idle.
    this.callState.set(this.adapter.snapshot());
    // Native snapshot push — authoritative for phase/mediaState (CallController.pushSnapshot).
    window.__SOMS_CALL_EVENT__ = (snap) => this.applyNative(snap);
    // SSE CALL_EVENT lifecycle (the incoming frame carries the peer display info).
    this.sub = this.ws.eventSubject
      .pipe(filter((m) => m.event === 'CALL_EVENT' && m.data !== undefined))
      .subscribe((m) => this.handleCallEvent(m.data as CallEventPayload));
  }

  /** Set the call state, folding a terminal ('ended') to 'idle' so the overlay dismisses and the state is
   *  clean for the next call. The terminal CALL bubble in the thread is the user-visible record. */
  private commit(next: CallSnapshot): void {
    this.callState.set(next.phase === 'ended' ? { ...IDLE_CALL } : next);
  }

  /** Merge a native snapshot push. The native snapshot carries peerName + peerAvatar (the caller passes the
   *  callee's at initiate; the callee gets the caller's from the CALL_INCOMING FCM push or the SSE frame) —
   *  prefer the native value when present, else keep the SSE-set one (the foreground incoming path). */
  private applyNative(snap: {
    phase: string;
    callSid: string | null;
    threadId: number;
    peerUserId: number;
    callType: 'AUDIO' | 'VIDEO';
    isCaller: boolean;
    mediaState: string;
    startedAt: number;
    muted: boolean;
    cameraEnabled?: boolean;
    remoteCameraEnabled?: boolean;
    videoUpgradeState?: 'idle' | 'upgrading' | 'failed';
    peerName?: string;
    peerAvatar?: string;
    step?: string;
  }): void {
    const cur = this.callState();
    const legacyVideo = snap.callType === 'VIDEO';
    this.commit({
      ...cur,
      ...snap,
      phase: (snap.phase as CallPhase) ?? cur.phase,
      peerName: snap.peerName || cur.peerName,
      peerAvatar: snap.peerAvatar || cur.peerAvatar,
      step: snap.step ?? cur.step,
      cameraEnabled:
        snap.cameraEnabled ?? (legacyVideo ? true : cur.cameraEnabled),
      remoteCameraEnabled:
        snap.remoteCameraEnabled ??
        (legacyVideo ? true : cur.remoteCameraEnabled),
    });
  }

  /** Apply one CALL_EVENT lifecycle frame. `incoming` seeds the full snapshot (callee side) + fires
   *  {@link incoming$}; the rest map to a phase via {@link PHASE_BY_EVENT}. */
  private handleCallEvent(p: CallEventPayload): void {
    const cur = this.callState();
    if (p.type === 'video-upgraded') {
      this.commit({
        ...cur,
        callType: 'VIDEO',
        videoUpgradeState: 'idle',
      });
      return;
    }
    if (p.type === 'incoming') {
      const snap: CallSnapshot = {
        ...IDLE_CALL,
        phase: 'incoming',
        callSid: p.callSid,
        threadId: p.threadId ?? cur.threadId,
        peerUserId: p.callerUserId ?? cur.peerUserId,
        callType: p.callType ?? cur.callType,
        cameraEnabled: p.callType === 'VIDEO',
        remoteCameraEnabled: p.callType === 'VIDEO',
        isCaller: false,
        peerName: p.callerName ?? '',
        peerAvatar: p.callerAvatar ?? '',
      };
      this.commit(snap);
      // Ignore a stray incoming for a call we're already in (race / multi-device echo).
      if (cur.phase === 'idle') this.incoming$.next(snap);
      return;
    }
    const phase = PHASE_BY_EVENT[p.type];
    if (!phase) return;
    // The caller's `ringing` (server Phase 1) only applies to the caller; the callee is already `incoming`.
    if (p.type === 'ringing' && !cur.isCaller) return;
    this.commit({
      ...cur,
      phase,
      ...(p.type === 'connected' && p.startedAt
        ? { startedAt: p.startedAt }
        : {}),
    });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    window.__SOMS_CALL_EVENT__ = undefined;
  }
}
