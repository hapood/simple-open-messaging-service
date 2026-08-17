import { Injectable, signal } from '@angular/core';
import {
  IDLE_CALL,
  type CallSnapshot,
  type CallSnapshotListener,
} from '../app/services/call-adapter';

export type PlaygroundCallMode = 'audio' | 'video';
export type PlaygroundCallResponse = 'decline' | 'busy' | 'accept';

function videoPoster(
  label: string,
  initials: string,
  from: string,
  to: string,
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 960">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
    <rect width="640" height="960" fill="url(#bg)"/>
    <rect x="220" y="350" width="200" height="200" rx="40" fill="rgba(255,255,255,.18)"/>
    <text x="320" y="470" text-anchor="middle" fill="white" font-family="system-ui,sans-serif" font-size="72" font-weight="600">${initials}</text>
    <text x="320" y="610" text-anchor="middle" fill="rgba(255,255,255,.82)" font-family="system-ui,sans-serif" font-size="32">${label}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const PEER_VIDEO_POSTER = videoPoster('Alice', 'AL', '#334155', '#0f172a');
const SELF_VIDEO_POSTER = videoPoster('Me', 'ME', '#155e75', '#164e63');

export function readPlaygroundCallMode(
  search: string,
): PlaygroundCallMode | null {
  const mock = new URLSearchParams(search).get('mock');
  if (mock === 'call') return 'audio';
  if (mock === 'video-call') return 'video';
  return null;
}

/** Stable in-memory call state for visual QA. It deliberately never transitions to idle, so the playground
 * remains on the production call screen even when a terminal control is clicked. */
@Injectable({ providedIn: 'root' })
export class PlaygroundCallState {
  private readonly mode = readPlaygroundCallMode(
    typeof window === 'undefined' ? '' : window.location.search,
  );

  readonly callState = signal<CallSnapshot>({
    ...IDLE_CALL,
    phase: this.mode ? 'connected' : 'idle',
    callSid: this.mode ? 'playground-call' : null,
    threadId: this.mode ? 1 : 0,
    peerUserId: this.mode ? 2 : 0,
    callType: this.mode === 'video' ? 'VIDEO' : 'AUDIO',
    isCaller: true,
    mediaState: 'connected',
    startedAt: this.mode ? Date.now() - 83_000 : 0,
    cameraEnabled: this.mode === 'video',
    remoteCameraEnabled: this.mode === 'video',
    peerName: this.mode ? 'Alice' : '',
  });
  readonly opponentResponse = signal<PlaygroundCallResponse>('accept');

  connect(
    peerUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
  ): void {
    this.callState.set({
      ...IDLE_CALL,
      phase: 'ringing',
      callSid,
      threadId: 1,
      peerUserId,
      callType,
      isCaller: true,
      mediaState: 'new',
      startedAt: 0,
      cameraEnabled: callType === 'VIDEO',
      remoteCameraEnabled: callType === 'VIDEO',
      peerName,
      peerAvatar,
    });
    const response = this.opponentResponse();
    setTimeout(() => {
      if (this.callState().callSid !== callSid) return;
      if (response !== 'accept') {
        this.disconnect();
        return;
      }
      this.callState.update((state) => ({
        ...state,
        phase: 'connected',
        mediaState: 'connected',
        startedAt: Date.now(),
      }));
    }, 800);
  }

  setMuted(muted: boolean): void {
    this.callState.update((state) => ({ ...state, muted }));
  }

  disconnect(): void {
    this.callState.set({ ...IDLE_CALL });
  }

  setCameraEnabled(cameraEnabled: boolean): void {
    this.callState.update((state) => ({ ...state, cameraEnabled }));
  }

  upgradeToVideo(): void {
    this.callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: true,
      remoteCameraEnabled: true,
    }));
  }

  swapVideo(): void {
    this.callState.update((state) => ({ ...state, swapped: !state.swapped }));
  }
}

/** Command half of the call mock. Media/network operations are inert; local presentation controls still update
 * the snapshot so mute, camera, and audio-to-video states can be inspected without browser permissions. */
@Injectable({ providedIn: 'root' })
export class PlaygroundCallAdapter {
  readonly supported = true;
  readonly videoSupported = true;
  readonly rendererOwnsVideo = false;
  private remoteVideo: HTMLVideoElement | null = null;
  private selfVideo: HTMLVideoElement | null = null;

  constructor(private readonly state: PlaygroundCallState) {}

  setSnapshotListener(_listener?: CallSnapshotListener): void {}
  initiate(
    calleeUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
  ): void {
    this.state.connect(calleeUserId, callSid, callType, peerName, peerAvatar);
  }
  accept(): void {}
  decline(): void {
    this.state.disconnect();
  }
  cancel(): void {
    this.state.disconnect();
  }
  end(): void {
    this.state.disconnect();
  }
  setMuted(muted: boolean): void {
    this.state.setMuted(muted);
  }
  upgradeToVideo(): void {
    this.state.upgradeToVideo();
  }
  switchCamera(): void {}
  setCameraEnabled(enabled: boolean): void {
    this.state.setCameraEnabled(enabled);
  }
  setVideoRect(): void {}
  setVideoElements(
    remote: HTMLVideoElement | null,
    self: HTMLVideoElement | null,
  ): void {
    this.remoteVideo = remote;
    this.selfVideo = self;
    this.applyVideoPosters();
  }
  setSelfVideoPosition(): void {}
  swapVideo(): void {
    this.state.swapVideo();
    this.applyVideoPosters();
  }
  snapshot(): CallSnapshot {
    return this.state.callState();
  }
  onIncoming(): void {}
  handleSignal(): void {}
  applyLifecycle(): void {}

  private applyVideoPosters(): void {
    const swapped = this.state.callState().swapped;
    if (this.remoteVideo)
      this.remoteVideo.poster = swapped
        ? SELF_VIDEO_POSTER
        : PEER_VIDEO_POSTER;
    if (this.selfVideo)
      this.selfVideo.poster = swapped
        ? PEER_VIDEO_POSTER
        : SELF_VIDEO_POSTER;
  }
}
