import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { REPLAY_SAFE } from '../request-context';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';
import { BusinessCode } from './biz-code';
import type {
  CallAdapter,
  CallSnapshot,
  CallSnapshotListener,
  CallSignalPayload,
  CallTerminalReason,
} from './call-adapter';
import { uuid } from '../lib/uuid';

interface IceServerResponse {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface IceConfigurationResponse {
  iceServers: IceServerResponse[];
}

/** Keep the backend wire shape explicit: GET /calls/ice-servers returns `{ iceServers: [...] }`, not the
 * array directly. Exported only so the boundary contract can be regression-tested without constructing a PC. */
export function iceServersFromResponse(
  response: IceConfigurationResponse | undefined,
): RTCIceServer[] {
  return response?.iceServers ?? [];
}

interface StagedSignaling {
  offer: { id: string; payload: string } | null;
  answer: { id: string; payload: string } | null;
  ice: Array<{ id: string; payload: string }>;
}

const WEB_RECONNECT_BACKSTOP_MS = 15_000;
const WEB_RECONNECT_BACKSTOP_SHORT_MS = 10_000;
const WEB_CALLEE_RECONNECT_BACKSTOP_MS = 30_000;
export const CALL_SESSION_ENDING_EVENT = 'soms-call-session-ending';

type WebReconnectAction = 'restart' | 'fail';
export type CallMediaErrorStep =
  | 'media-permission-denied'
  | 'media-device-not-found'
  | 'media-device-busy'
  | 'media-device-lost'
  | 'media-failed';

type LocalTrackEndAction = 'end-call' | 'disable-video';

export function localTrackEndAction(
  kind: MediaStreamTrack['kind'],
): LocalTrackEndAction {
  return kind === 'audio' ? 'end-call' : 'disable-video';
}

export function callMediaErrorStep(error: unknown): CallMediaErrorStep {
  const name =
    typeof error === 'object' && error && 'name' in error
      ? String(error.name)
      : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'media-permission-denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'media-device-not-found';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'media-device-busy';
  return 'media-failed';
}

/** Keep the browser reconnect policy aligned with Android: the caller owns the single ICE-restart attempt,
 * while the callee waits long enough for that re-offer to arrive before giving up. */
export function webReconnectDecision(
  isCaller: boolean,
  iceRestartTried: boolean,
): { delayMs: number; action: WebReconnectAction } {
  if (isCaller && !iceRestartTried) {
    return { delayMs: WEB_RECONNECT_BACKSTOP_MS, action: 'restart' };
  }
  return {
    delayMs: isCaller
      ? WEB_RECONNECT_BACKSTOP_SHORT_MS
      : WEB_CALLEE_RECONNECT_BACKSTOP_MS,
    action: 'fail',
  };
}

/**
 * Browser/desktop WebRTC owner. The shared call UI and server lifecycle are identical to Android, while
 * media ownership stays inside the renderer.
 */
export class WebCallAdapter implements CallAdapter {
  private state: CallSnapshot;
  private readonly seenSignalIds = new Set<string>();
  private listener?: CallSnapshotListener;
  private pc?: RTCPeerConnection;
  private localStream?: MediaStream;
  private remoteStream?: MediaStream;
  private remoteAudio?: HTMLAudioElement;
  private remoteVideo?: HTMLVideoElement;
  private selfVideo?: HTMLVideoElement;
  private pendingOffer?: string;
  private readonly pendingIce: string[] = [];
  private connectedReported = false;
  private answerBackstop?: ReturnType<typeof setTimeout>;
  private negotiationBackstop?: ReturnType<typeof setTimeout>;
  private reconnectBackstop?: ReturnType<typeof setTimeout>;
  private iceRestartTried = false;
  private acceptingLocally = false;
  private facingMode: 'user' | 'environment' = 'user';
  private readonly onPageHide = () => this.finishForLifecycle('completed');
  private readonly onSessionEnding = () => this.finishForLifecycle('completed');

  constructor(
    private readonly http: HttpClient,
    private readonly idle: CallSnapshot,
    private readonly notifyMediaError?: (step: CallMediaErrorStep) => void,
  ) {
    this.state = { ...idle };
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener(CALL_SESSION_ENDING_EVENT, this.onSessionEnding);
  }

  setSnapshotListener(listener?: CallSnapshotListener): void {
    this.listener = listener;
  }

  initiate(
    threadId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
  ): void {
    void this.startOutgoing(threadId, callSid, callType, peerName, peerAvatar);
  }

  private async startOutgoing(
    threadId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
  ): Promise<void> {
    let registered = false;
    try {
      // Request the mic directly from the click chain. Waiting for the HTTP round-trip first loses browser
      // user activation, which makes Tauri WebView/browser permission prompts reject getUserMedia.
      await this.acquireLocalMedia(callType === 'VIDEO');
      // Own the pending call before the response arrives so a rejection has a callSid to display.
      this.update({
        ...this.idle,
        phase: 'starting',
        callSid,
        threadId,
        callType,
        isCaller: true,
        peerName,
        peerAvatar,
      });
      const response = await this.postResponse<{ threadId: number }>(
        'calls/initiate',
        { callSid, threadId, callType },
      );
      if (response.code === BusinessCode.CALL_BUSY) {
        this.finish('busy');
        return;
      }
      if (response.code !== BusinessCode.OK)
        throw new Error(`calls/initiate rejected: ${response.code}`);
      registered = true;
      this.update({
        ...this.idle,
        phase: 'calling',
        callSid,
        threadId: response.data?.threadId ?? 0,
        peerUserId: 0,
        callType,
        isCaller: true,
        peerName,
        peerAvatar,
      });
      await this.createPeerConnection();
      const offer = await this.pc!.createOffer();
      await this.pc!.setLocalDescription(offer);
      await this.signal('offer', offer.sdp ?? '');
      this.update({ step: 'offer-sent' });
      this.armNegotiationBackstop();
    } catch (error) {
      console.error('[call:web] outgoing setup failed', error);
      if (registered) await this.bestEffortPost('calls/cancel', { callSid });
      else this.notifyMediaError?.(callMediaErrorStep(error));
      this.finish('failed');
    }
  }

  async onIncoming(snapshot: CallSnapshot): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.callSid !== snapshot.callSid)
      return;
    this.update(snapshot);
    await this.bestEffortPost('calls/ringing', { callSid: snapshot.callSid });
  }

  accept(callSid: string): void {
    void this.acceptIncoming(callSid);
  }

  private async acceptIncoming(callSid: string): Promise<void> {
    this.acceptingLocally = true;
    let acceptedOnServer = false;
    try {
      await this.acquireLocalMedia(this.state.callType === 'VIDEO');
      await this.post('calls/accept', { callSid });
      acceptedOnServer = true;
      this.update({ phase: 'connecting' });
      this.armNegotiationBackstop();
      await this.createPeerConnection();
      if (this.pendingOffer) {
        const offer = this.pendingOffer;
        this.pendingOffer = undefined;
        await this.applyOffer(offer);
      } else {
        const staged = await this.get<StagedSignaling>(
          `calls/${callSid}/signaling`,
        );
        if (staged?.offer && !this.seenSignalIds.has(staged.offer.id)) {
          this.seenSignalIds.add(staged.offer.id);
          await this.applyOffer(staged.offer.payload);
        }
        for (const candidate of staged?.ice ?? []) {
          if (this.seenSignalIds.has(candidate.id)) continue;
          this.seenSignalIds.add(candidate.id);
          await this.applyIce(candidate.payload);
        }
      }
      await this.flushPendingIce();
    } catch (error) {
      console.error('[call:web] accept failed', error);
      if (acceptedOnServer) {
        await this.bestEffortPost('calls/end', {
          callSid,
          endReason: 'failed',
        });
        this.finish();
      } else {
        this.acceptingLocally = false;
        this.releaseMedia();
        this.update({ phase: 'incoming', step: callMediaErrorStep(error) });
      }
    }
  }

  decline(callSid: string): void {
    void this.terminate('calls/decline', { callSid });
  }

  cancel(callSid: string): void {
    void this.terminate('calls/cancel', { callSid });
  }

  end(callSid: string, reason = 'completed'): void {
    void this.terminate('calls/end', { callSid, endReason: reason });
  }

  private terminate(path: string, body: object): void {
    // Ending media is a local user action and must not wait for a slow or unreachable server. Publish the
    // terminal snapshot and release devices synchronously; the idempotent lifecycle report continues in the
    // background and the peer learns the result through its server/SSE path.
    this.finish();
    void this.bestEffortPost(path, body);
  }

  setMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? [])
      track.enabled = !muted;
    this.update({ muted });
  }

  upgradeToVideo(): void {
    void this.enableVideo();
  }

  switchCamera(): void {
    void this.replaceCamera();
  }

  setCameraEnabled(enabled: boolean): void {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track && enabled) {
      void this.enableVideo();
      return;
    }
    if (!track) return;
    track.enabled = enabled;
    this.update({ cameraEnabled: enabled });
    void this.signal('video-state', JSON.stringify({ enabled }));
  }
  setVideoRect(): void {}
  setVideoElements(
    remote: HTMLVideoElement | null,
    self: HTMLVideoElement | null,
  ): void {
    this.remoteVideo = remote ?? undefined;
    this.selfVideo = self ?? undefined;
    if (this.remoteVideo) {
      this.remoteVideo.srcObject = this.remoteStream ?? null;
      void this.remoteVideo.play().catch(() => undefined);
    }
    if (this.selfVideo) {
      this.selfVideo.srcObject = this.localStream ?? null;
      void this.selfVideo.play().catch(() => undefined);
    }
  }
  setSelfVideoPosition(): void {}
  swapVideo(): void {}

  snapshot(): CallSnapshot {
    return { ...this.state };
  }

  async handleSignal(signal: CallSignalPayload): Promise<void> {
    if (signal.callSid !== this.state.callSid) {
      if (this.state.phase !== 'idle') return;
      if (this.seenSignalIds.has(signal.id)) return;
      this.seenSignalIds.add(signal.id);
      // An offer commonly arrives immediately before CALL_EVENT{incoming}.
      if (signal.kind === 'offer') this.pendingOffer = signal.payload;
      else if (signal.kind === 'ice') this.pendingIce.push(signal.payload);
      return;
    }
    if (this.seenSignalIds.has(signal.id)) return;
    this.seenSignalIds.add(signal.id);
    if (signal.kind === 'offer') {
      if (!this.pc) this.pendingOffer = signal.payload;
      else {
        try {
          await this.applyOffer(signal.payload);
        } catch (error) {
          this.failNegotiation('remote offer', error);
        }
      }
    } else if (signal.kind === 'answer' && this.pc) {
      try {
        await this.pc.setRemoteDescription({
          type: 'answer',
          sdp: signal.payload,
        });
        if (this.answerBackstop) clearTimeout(this.answerBackstop);
        this.update({ phase: 'connecting', step: 'answer-received' });
        if (this.state.videoUpgradeState === 'upgrading')
          await this.completeVideoUpgrade();
      } catch (error) {
        this.failNegotiation('remote answer', error);
      }
    } else if (signal.kind === 'ice') {
      if (!this.pc?.remoteDescription) this.pendingIce.push(signal.payload);
      else await this.applyIce(signal.payload);
    } else if (signal.kind === 'video-state') {
      const enabled = this.readVideoEnabled(signal.payload);
      if (enabled === undefined) return;
      this.update({
        remoteCameraEnabled: enabled,
        ...(enabled && this.state.callType === 'AUDIO'
          ? { videoUpgradeState: 'upgrading' as const }
          : {}),
      });
      if (enabled && this.state.isCaller) await this.createVideoOffer();
    }
  }

  applyLifecycle(snapshot: CallSnapshot): void {
    if (
      snapshot.callSid &&
      this.state.callSid &&
      snapshot.callSid !== this.state.callSid
    )
      return;
    if (
      this.state.phase === 'incoming' &&
      snapshot.phase === 'connecting' &&
      !this.acceptingLocally
    ) {
      // Lifecycle events are account-wide. Only the renderer whose user pressed Accept owns media;
      // sibling devices dismiss the incoming overlay when that accepted event arrives.
      this.finish();
      return;
    }
    const shouldFetchAnswer =
      this.state.isCaller &&
      snapshot.phase === 'connecting' &&
      !this.pc?.remoteDescription &&
      !!snapshot.callSid;
    this.update(snapshot);
    if (shouldFetchAnswer) {
      if (this.answerBackstop) clearTimeout(this.answerBackstop);
      this.answerBackstop = setTimeout(
        () => void this.fetchStagedAnswer(snapshot.callSid!),
        1_500,
      );
    }
    if (snapshot.phase === 'idle') this.releaseMedia();
  }

  private async fetchStagedAnswer(callSid: string): Promise<void> {
    if (!this.pc || this.pc.remoteDescription || this.state.callSid !== callSid)
      return;
    try {
      const staged = await this.get<StagedSignaling>(
        `calls/${callSid}/signaling`,
      );
      if (staged?.answer && !this.seenSignalIds.has(staged.answer.id)) {
        this.seenSignalIds.add(staged.answer.id);
        await this.pc.setRemoteDescription({
          type: 'answer',
          sdp: staged.answer.payload,
        });
        this.update({ phase: 'connecting', step: 'answer-received' });
      }
      for (const candidate of staged?.ice ?? []) {
        if (this.seenSignalIds.has(candidate.id)) continue;
        this.seenSignalIds.add(candidate.id);
        await this.applyIce(candidate.payload);
      }
    } catch (error) {
      console.warn('[call:web] staged answer fetch failed', error);
    }
  }

  private async createPeerConnection(): Promise<void> {
    await this.acquireLocalMedia(this.state.callType === 'VIDEO');
    const iceServers = iceServersFromResponse(
      await this.get<IceConfigurationResponse>('calls/ice-servers'),
    );
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of this.localStream!.getTracks())
      pc.addTrack(track, this.localStream!);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      void this.signal('ice', JSON.stringify(candidate.toJSON()));
    };
    pc.ontrack = (event) => this.attachRemoteTrack(event);
    pc.onconnectionstatechange = () =>
      this.onConnectionState(pc.connectionState);
  }

  private async acquireLocalMedia(withVideo: boolean): Promise<void> {
    if (
      this.localStream?.active &&
      (!withVideo || this.localStream.getVideoTracks().length > 0)
    )
      return;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
      video: withVideo ? { facingMode: this.facingMode } : false,
    });
    for (const track of this.localStream.getTracks())
      this.bindLocalTrackLifecycle(track);
    this.update({ cameraEnabled: withVideo });
    if (this.selfVideo) this.selfVideo.srcObject = this.localStream;
  }

  private async applyOffer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      this.pendingOffer = sdp;
      return;
    }
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signal('answer', answer.sdp ?? '');
    this.update({ step: 'answer-sent' });
    if (this.state.videoUpgradeState === 'upgrading')
      await this.completeVideoUpgrade();
  }

  private async applyIce(payload: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!this.isIceCandidateInit(parsed)) return;
      await this.pc?.addIceCandidate(parsed);
    } catch (error) {
      console.warn('[call:web] ignored invalid ICE candidate', error);
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc?.remoteDescription) return;
    for (const payload of this.pendingIce.splice(0))
      await this.applyIce(payload);
  }

  private onConnectionState(state: RTCPeerConnectionState): void {
    this.update({
      mediaState: state,
      ...(state === 'connected' || state === 'disconnected'
        ? { step: '' }
        : {}),
      phase:
        state === 'connected'
          ? 'connected'
          : state === 'disconnected'
            ? 'reconnecting'
            : this.state.phase,
    });
    if (
      state === 'connected' &&
      !this.state.isCaller &&
      !this.connectedReported
    ) {
      this.cancelNegotiationBackstop();
      this.cancelReconnectBackstop();
      this.iceRestartTried = false;
      this.connectedReported = true;
      void this.bestEffortPost('calls/connected', {
        callSid: this.state.callSid,
      });
    } else if (state === 'connected') {
      this.cancelNegotiationBackstop();
      this.cancelReconnectBackstop();
      this.iceRestartTried = false;
    } else if (state === 'disconnected') {
      this.armReconnectBackstop();
    } else if (state === 'failed') {
      const callSid = this.state.callSid;
      if (callSid)
        void this.terminate('calls/end', { callSid, endReason: 'failed' });
    }
  }

  private armReconnectBackstop(): void {
    if (this.reconnectBackstop || !this.state.callSid) return;
    const decision = webReconnectDecision(
      this.state.isCaller,
      this.iceRestartTried,
    );
    this.reconnectBackstop = setTimeout(() => {
      this.reconnectBackstop = undefined;
      if (this.pc?.connectionState !== 'disconnected') return;
      if (decision.action === 'restart') {
        void this.restartIce();
      } else {
        const callSid = this.state.callSid;
        if (callSid)
          void this.terminate('calls/end', { callSid, endReason: 'failed' });
      }
    }, decision.delayMs);
  }

  private armNegotiationBackstop(): void {
    if (this.negotiationBackstop || !this.state.callSid) return;
    this.negotiationBackstop = setTimeout(() => {
      this.negotiationBackstop = undefined;
      if (
        this.state.phase !== 'calling' &&
        this.state.phase !== 'ringing' &&
        this.state.phase !== 'connecting'
      )
        return;
      const callSid = this.state.callSid;
      if (callSid)
        void this.terminate('calls/end', { callSid, endReason: 'timeout' });
    }, 45_000);
  }

  private cancelNegotiationBackstop(): void {
    if (this.negotiationBackstop) clearTimeout(this.negotiationBackstop);
    this.negotiationBackstop = undefined;
  }

  /** Renderer-owned media cannot survive a page/session transition. Start the server end request while the
   * credential and document are still alive, then release devices synchronously; pagehide may terminate JS
   * before the request resolves, so cleanup must not await it. Android never constructs this adapter and its
   * native call intentionally survives a disposable WebView reload. */
  private finishForLifecycle(reason: string): void {
    const callSid = this.state.callSid;
    if (!callSid || this.state.phase === 'idle') return;
    void this.bestEffortPost('calls/end', {
      callSid,
      endReason: reason,
    });
    this.finish();
  }

  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.state.isCaller || this.iceRestartTried) return;
    this.iceRestartTried = true;
    try {
      pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await this.signal('offer', offer.sdp ?? '');
      this.update({ step: 'offer-sent' });
      this.armReconnectBackstop();
    } catch (error) {
      console.warn('[call:web] ICE restart failed', error);
      const callSid = this.state.callSid;
      if (callSid)
        void this.terminate('calls/end', { callSid, endReason: 'failed' });
    }
  }

  private cancelReconnectBackstop(): void {
    if (this.reconnectBackstop) clearTimeout(this.reconnectBackstop);
    this.reconnectBackstop = undefined;
  }

  private playRemote(stream?: MediaStream): void {
    if (!stream) return;
    const audio = this.remoteAudio ?? document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    this.remoteAudio = audio;
    void audio.play().catch(() => {
      // accept/initiate are user gestures in normal use; browser autoplay policy may still defer playback.
    });
  }

  private attachRemoteTrack(event: RTCTrackEvent): void {
    const stream = event.streams[0] ?? this.remoteStream ?? new MediaStream();
    if (!event.streams[0] && !stream.getTracks().includes(event.track))
      stream.addTrack(event.track);
    this.remoteStream = stream;
    if (event.track.kind === 'video') {
      const syncRemoteVideoState = () =>
        this.update({
          remoteCameraEnabled:
            event.track.readyState === 'live' && !event.track.muted,
        });
      event.track.onmute = syncRemoteVideoState;
      event.track.onunmute = syncRemoteVideoState;
      event.track.onended = syncRemoteVideoState;
      syncRemoteVideoState();
    }
    if (this.remoteVideo) {
      this.remoteVideo.srcObject = stream;
      void this.remoteVideo.play().catch(() => undefined);
    }
    this.playRemote(stream);
  }

  private async enableVideo(): Promise<void> {
    if (
      !this.pc ||
      (this.state.phase !== 'connected' && this.state.phase !== 'reconnecting')
    )
      return;
    if (this.localStream?.getVideoTracks().length) {
      this.setCameraEnabled(true);
      return;
    }
    this.update({ videoUpgradeState: 'upgrading' });
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facingMode },
        audio: false,
      });
      const track = camera.getVideoTracks()[0];
      if (!track) throw new Error('camera returned no video track');
      this.localStream ??= new MediaStream();
      this.localStream.addTrack(track);
      this.bindLocalTrackLifecycle(track);
      this.pc.addTrack(track, this.localStream);
      if (this.selfVideo) this.selfVideo.srcObject = this.localStream;
      this.update({ cameraEnabled: true });
      await this.signal('video-state', JSON.stringify({ enabled: true }));
      if (this.state.isCaller) await this.createVideoOffer();
    } catch (error) {
      console.error('[call:web] video upgrade failed', error);
      this.update({ videoUpgradeState: 'failed', cameraEnabled: false });
    }
  }

  private async createVideoOffer(): Promise<void> {
    if (!this.pc || this.pc.signalingState !== 'stable') return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signal('offer', offer.sdp ?? '');
    this.update({ step: 'offer-sent', videoUpgradeState: 'upgrading' });
  }

  private async completeVideoUpgrade(): Promise<void> {
    const callSid = this.state.callSid;
    if (!callSid || !this.state.isCaller) return;
    try {
      await this.post('calls/upgrade-video', { callSid });
      this.update({ callType: 'VIDEO', videoUpgradeState: 'idle' });
    } catch (error) {
      console.error('[call:web] video upgrade persistence failed', error);
      this.update({ videoUpgradeState: 'failed' });
    }
  }

  private async replaceCamera(): Promise<void> {
    const oldTrack = this.localStream?.getVideoTracks()[0];
    if (!oldTrack || !this.pc) return;
    const nextFacing = this.facingMode === 'user' ? 'environment' : 'user';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: nextFacing } },
        audio: false,
      });
      const nextTrack = stream.getVideoTracks()[0];
      const sender = this.pc
        .getSenders()
        .find((item) => item.track?.kind === 'video');
      await sender?.replaceTrack(nextTrack);
      this.localStream!.removeTrack(oldTrack);
      oldTrack.stop();
      this.localStream!.addTrack(nextTrack);
      this.bindLocalTrackLifecycle(nextTrack);
      this.facingMode = nextFacing;
      if (this.selfVideo) this.selfVideo.srcObject = this.localStream!;
    } catch (error) {
      console.warn('[call:web] switch camera failed', error);
    }
  }

  private readVideoEnabled(payload: string): boolean | undefined {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !('enabled' in parsed) ||
        typeof parsed.enabled !== 'boolean'
      )
        return undefined;
      return parsed.enabled;
    } catch {
      return undefined;
    }
  }

  private isIceCandidateInit(value: unknown): value is RTCIceCandidateInit {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false;
    const candidate = value as Record<string, unknown>;
    const allowed = new Set([
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) return false;
    return (
      (candidate['candidate'] === undefined ||
        typeof candidate['candidate'] === 'string') &&
      (candidate['sdpMid'] === undefined ||
        candidate['sdpMid'] === null ||
        typeof candidate['sdpMid'] === 'string') &&
      (candidate['sdpMLineIndex'] === undefined ||
        candidate['sdpMLineIndex'] === null ||
        (Number.isInteger(candidate['sdpMLineIndex']) &&
          (candidate['sdpMLineIndex'] as number) >= 0)) &&
      (candidate['usernameFragment'] === undefined ||
        candidate['usernameFragment'] === null ||
        typeof candidate['usernameFragment'] === 'string')
    );
  }

  private failNegotiation(context: string, error: unknown): void {
    console.error(`[call:web] ${context} failed`, error);
    const callSid = this.state.callSid;
    if (callSid) this.terminate('calls/end', { callSid, endReason: 'failed' });
  }

  private bindLocalTrackLifecycle(track: MediaStreamTrack): void {
    track.onended = () => {
      if (!this.localStream?.getTracks().includes(track)) return;
      this.notifyMediaError?.('media-device-lost');
      if (localTrackEndAction(track.kind) === 'end-call') {
        const callSid = this.state.callSid;
        if (callSid)
          void this.terminate('calls/end', {
            callSid,
            endReason: 'failed',
          });
        return;
      }
      this.localStream.removeTrack(track);
      this.update({ cameraEnabled: false });
      void this.signal('video-state', JSON.stringify({ enabled: false }));
    };
  }

  private async signal(kind: string, payload: string): Promise<void> {
    const { callSid } = this.state;
    if (!callSid) return;
    await this.post('calls/signal', {
      id: uuid(),
      callSid,
      kind,
      payload,
    });
  }

  private update(patch: Partial<CallSnapshot> | CallSnapshot): void {
    this.state = { ...this.state, ...patch };
    this.listener?.({ ...this.state });
  }

  private finish(reason?: CallTerminalReason): void {
    this.update({ phase: 'ended', terminalReason: reason ?? null });
    this.releaseMedia();
    this.seenSignalIds.clear();
    this.state = { ...this.idle };
  }

  private releaseMedia(): void {
    this.pc?.close();
    this.pc = undefined;
    for (const track of this.localStream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.localStream = undefined;
    for (const track of this.remoteStream?.getTracks() ?? []) {
      track.onmute = null;
      track.onunmute = null;
      track.onended = null;
      track.stop();
    }
    this.remoteStream = undefined;
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.remoteAudio = undefined;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;
    if (this.selfVideo) this.selfVideo.srcObject = null;
    this.remoteVideo = undefined;
    this.selfVideo = undefined;
    this.pendingOffer = undefined;
    this.pendingIce.length = 0;
    this.connectedReported = false;
    this.cancelNegotiationBackstop();
    this.cancelReconnectBackstop();
    this.iceRestartTried = false;
    this.acceptingLocally = false;
    if (this.answerBackstop) clearTimeout(this.answerBackstop);
    this.answerBackstop = undefined;
  }

  private async post<T = unknown>(
    path: string,
    body: object,
  ): Promise<T | undefined> {
    return (await this.postResponse<T>(path, body)).data;
  }

  private async postResponse<T>(
    path: string,
    body: object,
  ): Promise<StandardResponse<T>> {
    return firstValueFrom(
      this.http.post<StandardResponse<T>>(`${apiPrefix()}/${path}`, body, {
        context:
          'callSid' in body
            ? new HttpContext().set(REPLAY_SAFE, true)
            : undefined,
      }),
    );
  }

  private async get<T>(path: string): Promise<T | undefined> {
    const response = await firstValueFrom(
      this.http.get<StandardResponse<T>>(`${apiPrefix()}/${path}`),
    );
    return response.data;
  }

  private async bestEffortPost(path: string, body: object): Promise<void> {
    try {
      await this.post(path, body);
    } catch (error) {
      console.warn(`[call:web] ${path} failed`, error);
    }
  }
}
