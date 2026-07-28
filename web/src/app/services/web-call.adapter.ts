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
  private remoteAudio?: HTMLAudioElement;
  private pendingOffer?: string;
  private readonly pendingIce: string[] = [];
  private connectedReported = false;
  private answerBackstop?: ReturnType<typeof setTimeout>;
  private acceptingLocally = false;

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
      await this.acquireLocalAudio();
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
      await this.acquireLocalAudio();
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

  upgradeToVideo(): void {}
  switchCamera(): void {}
  setCameraEnabled(): void {}
  setVideoRect(): void {}
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
    } else if (signal.kind === 'ice') {
      if (!this.pc?.remoteDescription) this.pendingIce.push(signal.payload);
      else await this.applyIce(signal.payload);
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
    await this.acquireLocalAudio();
    const iceServers =
      (await this.get<IceServerResponse[]>('calls/ice-servers')) ?? [];
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of this.localStream!.getTracks())
      pc.addTrack(track, this.localStream!);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      void this.signal('ice', JSON.stringify(candidate.toJSON()));
    };
    pc.ontrack = ({ streams }) => this.playRemote(streams[0]);
    pc.onconnectionstatechange = () =>
      this.onConnectionState(pc.connectionState);
  }

  private async acquireLocalAudio(): Promise<void> {
    if (this.localStream?.active) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
      video: false,
    });
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
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.remoteAudio = undefined;
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
