import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Subject, Subscription, filter } from 'rxjs';
import { WebsocketService } from './websocket.service';
import {
  CallAdapterService,
  IDLE_CALL,
  type CallPhase,
  type CallSnapshot,
  type CallTerminalReason,
  type CallSignalPayload,
} from './call-adapter';

/**
 * The payload shape of a CALL_EVENT SSE frame. `type` is the lifecycle
 * (incoming | accepted | connected | declined | cancelled | ended | missed | ringing); the rest are
 * type-specific (only `incoming` carries the caller's display name/avatar).
 */
interface CallEventPayload {
  type: string;
  callSid: string;
  threadId?: number;
  callerUserId?: number | null;
  callerName?: string;
  callerAvatar?: string;
  callType?: 'AUDIO' | 'VIDEO';
  startedAt?: number;
  endReason?: string;
}

const TERMINAL_DISPLAY_MS = 1400;
const BUSY_TERMINAL_DISPLAY_MS = 1800;
const CALL_TERMINAL_REASON: Record<string, CallTerminalReason> = {
  declined: 'declined',
  cancelled: 'cancelled',
  missed: 'missed',
};

const CALL_END_REASON: Record<string, CallTerminalReason> = {
  completed: 'completed',
  timeout: 'timeout',
  failed: 'failed',
};

/** Maps a CALL_EVENT `type` to the UI phase. Terminal events briefly show their result before
 *  returning to idle; the system notice remains in the thread. `incoming` seeds the snapshot,
 *  and advisory `ringing` applies only to the caller. */
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
 * of "native owns the call, the WebView is disposable chrome" (mirrors how the thread repository routes
 * GROUP_* and how {@link WebsocketService} self-starts).
 *
 * The UI merges SSE lifecycle events with snapshots from the selected call adapter. Android forwards
 * Rust-owned snapshots through `window.__SOMS_CALL_EVENT__`; browser/desktop uses the adapter listener.
 * Native peer display info takes precedence when present. On Android, Rust consumes WebRTC signaling
 * and Kotlin adapts platform media; the renderer only presents the call state.
 *
 * `callState` holds active phases, a brief `'ended'` result, or `'idle'`. The overlay remains visible
 * through the terminal display interval; the system notice is the persistent call record.
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

  private terminalDisplayTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOwnedCallSid: string | null = null;
  private lastOwnedSnapshot: CallSnapshot | null = null;

  private readonly sub: Subscription;

  constructor() {
    // Seed from native (re-derive on boot / WebView reclaim — a call may already be live). On web/desktop
    // (no native bridge) this returns idle.
    this.callState.set(this.adapter.snapshot());
    this.adapter.setSnapshotListener((snap) => this.applyAdapter(snap));
    // Rust-owned native snapshot forwarded by the Android media adapter.
    window.__SOMS_CALL_EVENT__ = (snap) => this.applyNative(snap);
    // SSE CALL_EVENT lifecycle (the incoming frame carries the peer display info).
    this.sub = this.ws.eventSubject
      .pipe(
        filter(
          (m) =>
            (m.event === 'CALL_EVENT' || m.event === 'CALL_SIGNAL') &&
            m.data !== undefined,
        ),
      )
      .subscribe((m) => {
        if (m.event === 'CALL_SIGNAL') {
          this.adapter.handleSignal(m.data as CallSignalPayload);
        } else {
          this.handleCallEvent(m.data as CallEventPayload);
        }
      });
  }

  /** Commit lifecycle state and notify the adapter. Terminal presentation uses showTerminal instead. */
  private commit(next: CallSnapshot): void {
    this.rememberOwnedCall(next);
    this.callState.set(next);
    this.adapter.applyLifecycle(next);
  }

  private applyAdapter(next: CallSnapshot): void {
    // A pre-call media failure has no identity or terminal notice. Do not mount
    // terminal chrome or disable retry for a call that never existed.
    if (next.phase === 'ended' && !next.callSid) {
      this.callState.set({ ...IDLE_CALL });
      return;
    }
    this.rememberOwnedCall(next);
    if (next.phase === 'ended' && next.callSid) {
      this.showTerminal(next.callSid, next.terminalReason ?? 'completed');
      return;
    }
    if (this.callState().phase === 'ended' && next.phase === 'idle') return;
    this.callState.set(next);
  }

  private rememberOwnedCall(next: CallSnapshot): void {
    if (next.phase !== 'idle' && next.callSid) {
      this.lastOwnedCallSid = next.callSid;
      this.lastOwnedSnapshot = next;
    }
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
    swapped?: boolean;
    peerName?: string;
    peerAvatar?: string;
    step?: string;
    terminalReason?: CallTerminalReason | null;
  }): void {
    if (snap.phase === 'ended' && snap.callSid) {
      this.showTerminal(snap.callSid, snap.terminalReason ?? 'completed');
      return;
    }
    if (this.callState().phase === 'ended' && snap.phase === 'idle') return;
    const cur = this.callState();
    this.commit({
      ...cur,
      ...snap,
      phase: (snap.phase as CallPhase) ?? cur.phase,
      peerName: snap.peerName || cur.peerName,
      peerAvatar: snap.peerAvatar || cur.peerAvatar,
      step: snap.step ?? cur.step,
      cameraEnabled: snap.cameraEnabled ?? cur.cameraEnabled,
      remoteCameraEnabled: snap.remoteCameraEnabled ?? cur.remoteCameraEnabled,
    });
  }

  /** Apply one CALL_EVENT lifecycle frame. `incoming` seeds the full snapshot (callee side) + fires
   *  {@link incoming$}; the rest map to a phase via {@link PHASE_BY_EVENT}. */
  private handleCallEvent(p: CallEventPayload): void {
    const cur = this.callState();
    if (p.type === 'video-upgraded') {
      if (
        cur.callSid !== p.callSid ||
        cur.phase === 'idle' ||
        cur.phase === 'ended'
      )
        return;
      this.commit({
        ...cur,
        callType: 'VIDEO',
        videoUpgradeState: 'idle',
      });
      return;
    }
    if (p.type === 'incoming') {
      if (cur.phase === 'ended') this.clearTerminalDisplay();
      else if (cur.phase !== 'idle') return;
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
      this.adapter.onIncoming(snap);
      this.incoming$.next(snap);
      return;
    }
    const phase = PHASE_BY_EVENT[p.type];
    if (!phase) return;
    // Account-wide lifecycle events also reach sibling devices. A renderer with no matching local call
    // must not materialize a phantom connecting/connected overlay.
    const ownsActiveCall = cur.phase !== 'idle' && cur.callSid === p.callSid;
    const ownsRecentlyEndedCall =
      phase === 'ended' && this.lastOwnedCallSid === p.callSid;
    if (!ownsActiveCall && !ownsRecentlyEndedCall) return;
    // The caller's `ringing` (server Phase 1) only applies to the caller; the callee is already `incoming`.
    if (p.type === 'ringing' && !cur.isCaller) return;
    const terminalReason = this.terminalReason(p.type, p.endReason);
    if (terminalReason) {
      this.showTerminal(p.callSid, terminalReason);
      return;
    }
    if (ownsActiveCall) {
      this.commit({
        ...cur,
        phase:
          cur.phase === 'connected' &&
          (phase === 'connecting' || phase === 'ringing')
            ? 'connected'
            : phase,
        ...(p.type === 'connected' && p.startedAt
          ? { startedAt: p.startedAt }
          : {}),
      });
    }
  }

  private terminalReason(
    type: string,
    endReason?: string,
  ): CallTerminalReason | null {
    const reason = CALL_TERMINAL_REASON[type];
    if (reason) return reason;

    if (type === 'ended' && endReason) {
      return CALL_END_REASON[endReason] ?? null;
    }

    return null;
  }

  private showTerminal(
    callSid: string,
    terminalReason: CallTerminalReason,
  ): void {
    const current = this.callState();
    const base = current.callSid === callSid ? current : this.lastOwnedSnapshot;
    if (!base || base.callSid !== callSid) return;

    this.clearTerminalDisplay();
    this.adapter.applyLifecycle({ ...IDLE_CALL });
    this.callState.set({
      ...base,
      phase: 'ended',
      mediaState: 'new',
      step: '',
      terminalReason,
    });
    this.terminalDisplayTimer = setTimeout(
      () => {
        this.terminalDisplayTimer = null;
        if (this.callState().callSid === callSid) {
          this.callState.set({ ...IDLE_CALL });
        }
      },
      terminalReason === 'busy'
        ? BUSY_TERMINAL_DISPLAY_MS
        : TERMINAL_DISPLAY_MS,
    );
  }

  private clearTerminalDisplay(): void {
    if (this.terminalDisplayTimer) clearTimeout(this.terminalDisplayTimer);
    this.terminalDisplayTimer = null;
  }

  ngOnDestroy(): void {
    this.clearTerminalDisplay();
    this.sub.unsubscribe();
    this.adapter.setSnapshotListener(undefined);
    window.__SOMS_CALL_EVENT__ = undefined;
  }
}
