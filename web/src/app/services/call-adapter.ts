import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { isAndroidNative } from './runtime';
import { WebCallAdapter } from './web-call.adapter';
import { ToastService } from './toast.service';

/** The UI phase of a 1:1 call, combining lifecycle and media state. `idle` = no live call. */
export type CallPhase =
  | 'idle'
  | 'starting'
  | 'calling'
  | 'ringing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

export type CallTerminalReason =
  | 'declined'
  | 'busy'
  | 'unreachable'
  | 'missed'
  | 'timeout'
  | 'failed'
  | 'cancelled'
  | 'completed';

/** Shared call presentation from the selected adapter. Android forwards the Rust-owned snapshot
 *  through its native bridge; peer display info may also arrive through CALL_EVENT SSE frames. */
export interface CallSnapshot {
  phase: CallPhase;
  callSid: string | null;
  threadId: number;
  peerUserId: number;
  callType: 'AUDIO' | 'VIDEO';
  /** true = this side placed the call (caller); false = rung (callee). */
  isCaller: boolean;
  /** The last advisory media state from the PC (new/gathering/connecting/connected/disconnected/failed). */
  mediaState: string;
  /** Connect epoch-ms (0 until connected) — authoritative value comes from the callee's /calls/connected. */
  startedAt: number;
  muted: boolean;
  /** Whether call audio is explicitly routed to the built-in speaker. */
  speakerEnabled: boolean;
  /** Whether this side is currently capturing/sending camera video. Turning it off never downgrades a
   *  VIDEO call back to AUDIO; it only pauses the local video track. */
  cameraEnabled: boolean;
  /** Whether the peer currently has a camera track enabled. Used to render an intentional avatar state
   *  instead of making a missing remote frame look like a broken black screen. */
  remoteCameraEnabled: boolean;
  /** AUDIO→VIDEO is the only media-type transition. `upgrading` keeps the audio UI stable while camera
   *  permission + SDP renegotiation run; `failed` leaves the audio call intact and allows retry. */
  videoUpgradeState: 'idle' | 'upgrading' | 'failed';
  /** Self↔peer swapped (tap the PiP): true = local camera full-bleed, peer in the PiP. In the snapshot so a
   *  WebView recreate mid-call re-derives the swap state (native owns it; the UI is disposable chrome). */
  swapped: boolean;
  /** Peer display info from the adapter snapshot or CALL_EVENT{incoming}. */
  peerName: string;
  peerAvatar: string;
  /** A finer WebRTC-negotiation step CODE ("offer-sent" / "answer-received" / …) from the native FSM — a
   *  stable code the call UI localizes via the `call` i18n namespace (never display text). Shown when non-empty
   *  (more detail than {@link phase}). */
  step: string;
  /** Present only while the UI briefly holds an ended call on screen before returning to idle. */
  terminalReason: CallTerminalReason | null;
}

/** The no-call snapshot (the callState seed). */
export const IDLE_CALL: CallSnapshot = {
  phase: 'idle',
  callSid: null,
  threadId: 0,
  peerUserId: 0,
  callType: 'AUDIO',
  isCaller: false,
  mediaState: 'new',
  startedAt: 0,
  muted: false,
  speakerEnabled: false,
  cameraEnabled: false,
  remoteCameraEnabled: false,
  videoUpgradeState: 'idle',
  swapped: false,
  peerName: '',
  peerAvatar: '',
  step: '',
  terminalReason: null,
};

export type CallSnapshotListener = (snapshot: CallSnapshot) => void;
export type CallSignalPayload = {
  id: string;
  callSid: string;
  fromUserId: number | null;
  payload: string;
} & (
  | { kind: 'answer'; inReplyTo: string }
  | { kind: 'offer' | 'ice' | 'video-state'; inReplyTo?: never }
);

/**
 * The call command adapter hides platform differences. Android delegates commands through
 * `window.SomsCall` to the Rust-owned lifecycle; Kotlin adapts platform media and OS capabilities.
 * Capable browser/desktop hosts use {@link WebCallAdapter}. Hosts without either implementation
 * use {@link UnsupportedCallAdapter}, and the UI hides the call controls.
 *
 * The EVENT direction is separate: CALL_EVENT/CALL_SIGNAL ride the existing `window.__SOMS_EVENT__` SSE
 * channel + the native `window.__SOMS_CALL_EVENT__` snapshot push, consumed by {@link CallEventService}.
 */
export abstract class CallAdapter {
  abstract setSnapshotListener(listener?: CallSnapshotListener): void;
  /** Caller begins a call. Native presentation resolves the selected profile from the thread identity. */
  abstract initiate(
    threadId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerAccount: string,
    peerNamespaceId: number,
  ): void;
  /** Callee accepts the incoming ring (POST /calls/accept + createAnswer natively). */
  abstract accept(callSid: string): void;
  abstract decline(callSid: string): void;
  abstract cancel(callSid: string): void;
  /** Either party hangs up (POST /calls/end; `reason` ∈ completed|timeout|failed). */
  abstract end(callSid: string, reason?: string): void;
  /** Mute/unmute the local mic. */
  abstract setMuted(muted: boolean): void;
  /** Upgrade an established AUDIO call to VIDEO. The transition is one-way for the call lifetime. */
  abstract upgradeToVideo(): void;
  /** Toggle the capture between front (self-view) + back cameras (WhatsApp/FaceTime). AUDIO call: no-op. */
  abstract switchCamera(): void;
  /** Camera on/off (mute video, keep audio). */
  abstract setCameraEnabled(enabled: boolean): void;
  /** Report the remote + self video "hole" rects (JSON `{x,y,w,h}` CSS px) so native positions its surface
   *  overlays; nulls hide the surfaces. */
  abstract setVideoRect(remote: string | null, self: string | null): void;
  /** Browser media elements for renderer-owned video. Native adapters ignore these and use surface rects. */
  abstract setVideoElements(
    remote: HTMLVideoElement | null,
    self: HTMLVideoElement | null,
  ): void;
  /** High-frequency self-view drag position in absolute CSS px; native applies translation only. */
  abstract setSelfVideoPosition(x: number, y: number): void;
  /** Swap which video is full-bleed vs PiP (tap the self PiP) — the local camera ↔ the peer's swap renderers
   *  (mirrors follow). No-op on an AUDIO call. */
  abstract swapVideo(): void;
  /** Synchronous snapshot of the live call (re-derive on boot / WebView reclaim). */
  abstract snapshot(): CallSnapshot;
  abstract onIncoming(snapshot: CallSnapshot): void | Promise<void>;
  abstract handleSignal(signal: CallSignalPayload): void | Promise<void>;
  abstract applyLifecycle(snapshot: CallSnapshot): void;
}

/** Android: delegates to the Kotlin `window.SomsCall` bridge. Per the native-bridge rule, runs only on
 *  Android so `window.SomsCall` is guaranteed present — call with `!`. */
class AndroidCallAdapter extends CallAdapter {
  setSnapshotListener(): void {}
  initiate(
    threadId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerAccount: string,
    peerNamespaceId: number,
  ): void {
    window.SomsCall!.initiate(
      threadId,
      callSid,
      callType,
      peerAccount,
      peerNamespaceId,
    );
  }
  accept(callSid: string): void {
    window.SomsCall!.accept(callSid);
  }
  decline(callSid: string): void {
    window.SomsCall!.decline(callSid);
  }
  cancel(callSid: string): void {
    window.SomsCall!.cancel(callSid);
  }
  end(callSid: string, reason?: string): void {
    window.SomsCall!.end(callSid, reason);
  }
  setMuted(muted: boolean): void {
    window.SomsCall!.setMuted(muted);
  }
  upgradeToVideo(): void {
    window.SomsCall!.upgradeToVideo?.();
  }
  switchCamera(): void {
    window.SomsCall!.switchCamera();
  }
  setCameraEnabled(enabled: boolean): void {
    window.SomsCall!.setCameraEnabled(enabled);
  }
  setVideoRect(remote: string | null, self: string | null): void {
    window.SomsCall!.setVideoRect(remote, self);
  }
  setVideoElements(): void {}
  setSelfVideoPosition(x: number, y: number): void {
    window.SomsCall!.setSelfVideoPosition(x, y);
  }
  swapVideo(): void {
    window.SomsCall!.swapVideo();
  }
  snapshot(): CallSnapshot {
    // Merge the native JSON over the idle defaults so a partial/older snapshot can't drop required fields.
    const raw = window.SomsCall!.getSnapshot();
    try {
      const parsed = JSON.parse(raw) as Partial<CallSnapshot>;
      return {
        ...IDLE_CALL,
        ...parsed,
      };
    } catch {
      return { ...IDLE_CALL };
    }
  }
  onIncoming(): void {}
  handleSignal(): void {}
  applyLifecycle(): void {}
}

/** Fallback for hosts without native calling or renderer WebRTC support. Commands are no-ops;
 *  `snapshot()` returns idle. The UI gates the call button on `CallAdapterService.supported`. */
class UnsupportedCallAdapter extends CallAdapter {
  setSnapshotListener(): void {}
  initiate(): void {}
  accept(): void {}
  decline(): void {}
  cancel(): void {}
  end(): void {}
  setMuted(): void {}
  upgradeToVideo(): void {}
  switchCamera(): void {}
  setCameraEnabled(): void {}
  setVideoRect(): void {}
  setVideoElements(): void {}
  setSelfVideoPosition(): void {}
  swapVideo(): void {}
  snapshot(): CallSnapshot {
    return { ...IDLE_CALL };
  }
  onIncoming(): void {}
  handleSignal(): void {}
  applyLifecycle(): void {}
}

/**
 * The single app-wide call-command surface. Selects ONE adapter by platform at construction (mirrors how
 * WebsocketService selects its transport) and delegates. Call sites inject this, never a concrete adapter.
 *
 * `supported` enables call controls on Android and WebRTC-capable browser/desktop hosts.
 * The unsupported adapter is a defensive no-op for other environments.
 */
@Injectable({ providedIn: 'root' })
export class CallAdapterService {
  private readonly adapter: CallAdapter;

  /** WebRTC is native-owned on Android and renderer-owned in capable browser/desktop builds. */
  readonly supported: boolean;
  /** Both native and renderer-owned adapters support video when calling is available. */
  readonly videoSupported: boolean;
  /** Browser/desktop video needs an HTMLVideoElement first-frame gate; Android renders into native surfaces. */
  readonly rendererOwnsVideo: boolean;

  constructor(
    http: HttpClient,
    toast: ToastService,
    transloco: TranslocoService,
  ) {
    const webRtcSupported =
      typeof RTCPeerConnection !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia;
    this.adapter = isAndroidNative()
      ? new AndroidCallAdapter()
      : webRtcSupported
        ? new WebCallAdapter(http, IDLE_CALL, (step) =>
            toast.warn(transloco.translate(`call.${step}`)),
          )
        : new UnsupportedCallAdapter();
    this.supported = isAndroidNative() || webRtcSupported;
    this.videoSupported = this.supported;
    this.rendererOwnsVideo = !isAndroidNative() && webRtcSupported;
  }

  setSnapshotListener(listener?: CallSnapshotListener): void {
    this.adapter.setSnapshotListener(listener);
  }

  initiate(
    threadId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerAccount: string,
    peerNamespaceId: number,
  ): void {
    this.adapter.initiate(
      threadId,
      callSid,
      callType,
      peerAccount,
      peerNamespaceId,
    );
  }
  accept(callSid: string): void {
    this.adapter.accept(callSid);
  }
  decline(callSid: string): void {
    this.adapter.decline(callSid);
  }
  cancel(callSid: string): void {
    this.adapter.cancel(callSid);
  }
  end(callSid: string, reason?: string): void {
    this.adapter.end(callSid, reason);
  }
  setMuted(muted: boolean): void {
    this.adapter.setMuted(muted);
  }
  setSpeakerEnabled(enabled: boolean): void {
    if (isAndroidNative()) window.SomsCall!.setSpeakerEnabled(enabled);
  }
  upgradeToVideo(): void {
    this.adapter.upgradeToVideo();
  }
  switchCamera(): void {
    this.adapter.switchCamera();
  }
  setCameraEnabled(enabled: boolean): void {
    this.adapter.setCameraEnabled(enabled);
  }
  setVideoRect(remote: string | null, self: string | null): void {
    this.adapter.setVideoRect(remote, self);
  }
  setVideoElements(
    remote: HTMLVideoElement | null,
    self: HTMLVideoElement | null,
  ): void {
    this.adapter.setVideoElements(remote, self);
  }
  setSelfVideoPosition(x: number, y: number): void {
    this.adapter.setSelfVideoPosition(x, y);
  }
  swapVideo(): void {
    this.adapter.swapVideo();
  }
  snapshot(): CallSnapshot {
    return this.adapter.snapshot();
  }
  onIncoming(snapshot: CallSnapshot): void {
    void this.adapter.onIncoming(snapshot);
  }
  handleSignal(signal: CallSignalPayload): void {
    void this.adapter.handleSignal(signal);
  }
  applyLifecycle(snapshot: CallSnapshot): void {
    this.adapter.applyLifecycle(snapshot);
  }
}
