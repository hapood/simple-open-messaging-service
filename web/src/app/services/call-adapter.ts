import { Injectable } from '@angular/core';
import { isAndroidNative } from './runtime';

/** The UI phase of a 1:1 call — the merged call-FSM ∪ RTCPeerConnection state (Phase 5 refines the labels
 *  + the reconnecting/weak UX). `idle` = no live call. */
export type CallPhase =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

/** The live call snapshot. Shape mirrors the native `CallController.snapshotJson()` (the authoritative
 *  source — the native FSM owns the RTCPeerConnection state); `peerName`/`peerAvatar` are added here from
 *  the CALL_EVENT{incoming} SSE frame (the native snapshot carries only ids, not display info). */
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
  /** Connect epoch-ms (0 until connected) — the timer starts here (== POST /calls/connected). */
  startedAt: number;
  muted: boolean;
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
  /** Display info from CALL_EVENT{incoming}; empty until then. */
  peerName: string;
  peerAvatar: string;
  /** A finer WebRTC-negotiation step CODE ("offer-sent" / "answer-received" / …) from the native FSM — a
   *  stable code the call UI localizes via the `call` i18n namespace (never display text). Shown when non-empty
   *  (more detail than {@link phase}). */
  step: string;
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
  cameraEnabled: false,
  remoteCameraEnabled: false,
  videoUpgradeState: 'idle',
  swapped: false,
  peerName: '',
  peerAvatar: '',
  step: '',
};

/**
 * The call COMMAND adapter — hides platform differences behind one polymorphic surface (mirrors
 * {@link NotificationAdapter}). On Android the RTCPeerConnection + the call lifecycle FSM live in NATIVE
 * Kotlin (CallController); this adapter delegates each command to the `window.SomsCall` `@JavascriptInterface`.
 * The web/desktop builds have no native call layer (calling is deferred there), so they use the no-op
 * {@link UnsupportedCallAdapter} — `CallAdapterService.supported` is false, and the UI hides the call path.
 *
 * The EVENT direction is separate: CALL_EVENT/CALL_SIGNAL ride the existing `window.__SOMS_EVENT__` SSE
 * channel + the native `window.__SOMS_CALL_EVENT__` snapshot push, consumed by {@link CallEventService}.
 */
export abstract class CallAdapter {
  /** Caller begins a call (POST /calls/initiate + createOffer happen natively). `callType` ∈ AUDIO|VIDEO.
   *  `peerName` + `peerAvatar` (a /uploads path) are the callee's display info for the call UI.
   *  `peerAvatarDataUrl` is the callee's avatar as a base64 data URL (read from the IDB cache by the caller)
   *  so the native call notification (CallStyle Person) decodes it directly — NO /uploads fetch (the bytes
   *  are on-device). Empty when uncached → the notification is name-only. */
  abstract initiate(
    calleeUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
    peerAvatarDataUrl: string,
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
  /** Swap which video is full-bleed vs PiP (tap the self PiP) — the local camera ↔ the peer's swap renderers
   *  (mirrors follow). No-op on an AUDIO call. */
  abstract swapVideo(): void;
  /** Synchronous snapshot of the live call (re-derive on boot / WebView reclaim). */
  abstract snapshot(): CallSnapshot;
}

/** Android: delegates to the Kotlin `window.SomsCall` bridge. Per the native-bridge rule, runs only on
 *  Android so `window.SomsCall` is guaranteed present — call with `!`. */
class AndroidCallAdapter extends CallAdapter {
  initiate(
    calleeUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
    peerAvatarDataUrl: string,
  ): void {
    window.SomsCall!.initiate(
      calleeUserId,
      callSid,
      callType,
      peerName,
      peerAvatar,
      peerAvatarDataUrl,
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
  swapVideo(): void {
    window.SomsCall!.swapVideo();
  }
  snapshot(): CallSnapshot {
    // Merge the native JSON over the idle defaults so a partial/older snapshot can't drop required fields.
    const raw = window.SomsCall!.getSnapshot();
    try {
      const parsed = JSON.parse(raw) as Partial<CallSnapshot>;
      const legacyVideo = parsed.callType === 'VIDEO';
      return {
        ...IDLE_CALL,
        ...parsed,
        cameraEnabled: parsed.cameraEnabled ?? legacyVideo,
        remoteCameraEnabled: parsed.remoteCameraEnabled ?? legacyVideo,
      };
    } catch {
      return { ...IDLE_CALL };
    }
  }
}

/** Web/desktop: no native call layer (calling is deferred on those platforms). Commands are no-ops;
 *  `snapshot()` returns idle. The UI gates the call button on `CallAdapterService.supported`. */
class UnsupportedCallAdapter extends CallAdapter {
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
  swapVideo(): void {}
  snapshot(): CallSnapshot {
    return { ...IDLE_CALL };
  }
}

/**
 * The single app-wide call-command surface. Selects ONE adapter by platform at construction (mirrors how
 * WebsocketService selects its transport) and delegates. Call sites inject this, never a concrete adapter.
 *
 * `supported` is the gate the UI uses to show/hide the call affordance: calling works only in the Android
 * native shell; web/desktop show no call button (the unsupported adapter is a defensive no-op so an
 * accidental call site can't throw).
 */
@Injectable({ providedIn: 'root' })
export class CallAdapterService {
  private readonly adapter: CallAdapter = isAndroidNative()
    ? new AndroidCallAdapter()
    : new UnsupportedCallAdapter();

  /** Whether 1:1 calling is supported on this platform (Android native only, for now). */
  readonly supported = isAndroidNative();

  initiate(
    calleeUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
    peerAvatarDataUrl: string,
  ): void {
    this.adapter.initiate(
      calleeUserId,
      callSid,
      callType,
      peerName,
      peerAvatar,
      peerAvatarDataUrl,
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
  swapVideo(): void {
    this.adapter.swapVideo();
  }
  snapshot(): CallSnapshot {
    return this.adapter.snapshot();
  }
}
