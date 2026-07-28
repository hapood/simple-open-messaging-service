import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';
import type {
  CallAdapter,
  CallSnapshot,
  CallSnapshotListener,
  CallSignalPayload,
} from './call-adapter';

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
  offer: string | null;
  answer: string | null;
  ice: string[];
}

/**
 * Browser/desktop WebRTC owner. It deliberately implements audio only in this first phase; the shared
 * call UI and server lifecycle are identical to Android, while media ownership stays inside the renderer.
 */
export class WebCallAdapter implements CallAdapter {
  private state: CallSnapshot;
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
  private acceptingLocally = false;
  private facingMode: 'user' | 'environment' = 'user';

  constructor(
    private readonly http: HttpClient,
    private readonly idle: CallSnapshot,
  ) {
    this.state = { ...idle };
  }

  setSnapshotListener(listener?: CallSnapshotListener): void {
    this.listener = listener;
  }

  initiate(
    calleeUserId: number,
    callSid: string,
    callType: 'AUDIO' | 'VIDEO',
    peerName: string,
    peerAvatar: string,
  ): void {
    void this.startOutgoing(
      calleeUserId,
      callSid,
      callType,
      peerName,
      peerAvatar,
    );
  }

  private async startOutgoing(
    calleeUserId: number,
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
      const response = await this.post<{ threadId: number }>('calls/initiate', {
        callSid,
        calleeUserId,
        callType,
      });
      registered = true;
      this.update({
        ...this.idle,
        phase: 'calling',
        callSid,
        threadId: response?.threadId ?? 0,
        peerUserId: calleeUserId,
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
    } catch (error) {
      console.error('[call:web] outgoing setup failed', error);
      if (registered) await this.bestEffortPost('calls/cancel', { callSid });
      this.finish();
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
      await this.createPeerConnection();
      if (this.pendingOffer) {
        const offer = this.pendingOffer;
        this.pendingOffer = undefined;
        await this.applyOffer(offer);
      } else {
        const staged = await this.get<StagedSignaling>(
          `calls/${callSid}/signaling`,
        );
        if (staged?.offer) await this.applyOffer(staged.offer);
        for (const candidate of staged?.ice ?? [])
          await this.applyIce(candidate);
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
        this.update({ phase: 'incoming', step: 'microphone-failed' });
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

  private async terminate(path: string, body: object): Promise<void> {
    await this.bestEffortPost(path, body);
    this.finish();
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
      // An offer commonly arrives immediately before CALL_EVENT{incoming}.
      if (signal.kind === 'offer') this.pendingOffer = signal.payload;
      else if (signal.kind === 'ice') this.pendingIce.push(signal.payload);
      return;
    }
    if (signal.kind === 'offer') {
      if (!this.pc) this.pendingOffer = signal.payload;
      else await this.applyOffer(signal.payload);
    } else if (signal.kind === 'answer' && this.pc) {
      if (this.answerBackstop) clearTimeout(this.answerBackstop);
      await this.pc.setRemoteDescription({
        type: 'answer',
        sdp: signal.payload,
      });
      this.update({ phase: 'connecting', step: 'answer-received' });
      if (this.state.videoUpgradeState === 'upgrading')
        await this.completeVideoUpgrade();
    } else if (signal.kind === 'ice') {
      if (!this.pc?.remoteDescription) this.pendingIce.push(signal.payload);
      else await this.applyIce(signal.payload);
    } else if (signal.kind === 'video-state') {
      const enabled = this.readVideoEnabled(signal.payload);
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
      if (staged?.answer) {
        await this.pc.setRemoteDescription({
          type: 'answer',
          sdp: staged.answer,
        });
        this.update({ phase: 'connecting', step: 'answer-received' });
      }
      for (const candidate of staged?.ice ?? []) await this.applyIce(candidate);
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
    const candidate = JSON.parse(payload) as RTCIceCandidateInit;
    await this.pc?.addIceCandidate(candidate);
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc?.remoteDescription) return;
    for (const payload of this.pendingIce.splice(0))
      await this.applyIce(payload);
  }

  private onConnectionState(state: RTCPeerConnectionState): void {
    this.update({
      mediaState: state,
      phase:
        state === 'connected'
          ? 'connected'
          : state === 'disconnected'
            ? 'reconnecting'
            : this.state.phase,
    });
    if (state === 'connected' && !this.connectedReported) {
      this.connectedReported = true;
      void this.bestEffortPost('calls/connected', {
        callSid: this.state.callSid,
      });
    } else if (state === 'failed') {
      const callSid = this.state.callSid;
      if (callSid)
        void this.terminate('calls/end', { callSid, endReason: 'failed' });
    }
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
    if (event.track.kind === 'video')
      this.update({ remoteCameraEnabled: event.track.enabled });
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
    if (!callSid) return;
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
      this.facingMode = nextFacing;
      if (this.selfVideo) this.selfVideo.srcObject = this.localStream!;
    } catch (error) {
      console.warn('[call:web] switch camera failed', error);
    }
  }

  private readVideoEnabled(payload: string): boolean {
    try {
      return !!(JSON.parse(payload) as { enabled?: boolean }).enabled;
    } catch {
      return false;
    }
  }

  private async signal(kind: string, payload: string): Promise<void> {
    const { callSid, peerUserId } = this.state;
    if (!callSid || !peerUserId) return;
    await this.post('calls/signal', {
      callSid,
      toUserId: peerUserId,
      kind,
      payload,
    });
  }

  private update(patch: Partial<CallSnapshot> | CallSnapshot): void {
    this.state = { ...this.state, ...patch };
    this.listener?.({ ...this.state });
  }

  private finish(): void {
    this.update({ phase: 'ended' });
    this.releaseMedia();
    this.state = { ...this.idle };
  }

  private releaseMedia(): void {
    this.pc?.close();
    this.pc = undefined;
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = undefined;
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
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
    this.acceptingLocally = false;
    if (this.answerBackstop) clearTimeout(this.answerBackstop);
    this.answerBackstop = undefined;
  }

  private async post<T = unknown>(
    path: string,
    body: object,
  ): Promise<T | undefined> {
    const response = await firstValueFrom(
      this.http.post<StandardResponse<T>>(`${apiPrefix()}/${path}`, body),
    );
    return response.data;
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
