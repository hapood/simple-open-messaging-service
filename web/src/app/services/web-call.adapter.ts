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
import {
  WebCallNegotiation,
  RemoteIceGenerations,
  negotiatedVideo,
} from './web-call-negotiation';

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
  answer: { id: string; payload: string; inReplyTo: string } | null;
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
  private pendingOffer?: { id: string; payload: string; callSid: string };
  private readonly pendingIce: string[] = [];
  private generation = 0;
  private negotiation?: WebCallNegotiation;
  private remoteIce = new RemoteIceGenerations();
  private remoteOfferTail: Promise<void> = Promise.resolve();
  private remoteOfferBusy = false;
  private serverConnected = false;
  private pendingVideoState?: boolean;
  private pendingVideoOffer = false;
  private applyingAnswer = false;
  private cameraBusy = false;
  private outgoingBusy = false;
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
    if (this.outgoingBusy || this.state.phase !== 'idle') return;
    this.outgoingBusy = true;
    const generation = this.generation;
    let registered = false;
    try {
      // Request the mic directly from the click chain. Waiting for the HTTP round-trip first loses browser
      // user activation, which makes Tauri WebView/browser permission prompts reject getUserMedia.
      await this.acquireLocalMedia(callType === 'VIDEO');
      if (generation !== this.generation) return;
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
      if (generation !== this.generation) {
        if (response.code === BusinessCode.OK)
          await this.bestEffortPost('calls/cancel', { callSid });
        return;
      }
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
      if (generation !== this.generation) return;
      this.negotiation?.request('initial');
    } catch (error) {
      if (generation !== this.generation) return;
      console.error('[call:web] outgoing setup failed', error);
      if (!registered) this.notifyMediaError?.(callMediaErrorStep(error));
      this.finish('failed');
      if (registered) void this.bestEffortPost('calls/cancel', { callSid });
    } finally {
      if (generation === this.generation) this.outgoingBusy = false;
    }
  }

  async onIncoming(snapshot: CallSnapshot): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.callSid !== snapshot.callSid)
      return;
    if (this.pendingOffer && this.pendingOffer.callSid !== snapshot.callSid) {
      this.pendingOffer = undefined;
      this.pendingIce.length = 0;
      this.seenSignalIds.clear();
    }
    this.update(snapshot);
    await this.bestEffortPost('calls/ringing', { callSid: snapshot.callSid });
  }

  accept(callSid: string): void {
    void this.acceptIncoming(callSid);
  }

  private async acceptIncoming(callSid: string): Promise<void> {
    if (this.acceptingLocally || this.state.callSid !== callSid) return;
    const generation = this.generation;
    this.acceptingLocally = true;
    this.update({ step: '' });
    let acceptedOnServer = false;
    try {
      await this.acquireLocalMedia(this.state.callType === 'VIDEO');
      if (generation !== this.generation) return;
      await this.post('calls/accept', { callSid });
      if (generation !== this.generation) return;
      acceptedOnServer = true;
      this.update({ phase: 'connecting', step: '' });
      this.armNegotiationBackstop();
      await this.createPeerConnection();
      if (generation !== this.generation) return;
      if (this.pendingOffer?.callSid === callSid) {
        const offer = this.pendingOffer;
        this.pendingOffer = undefined;
        await this.applyOffer(offer);
      } else {
        const staged = await this.get<StagedSignaling>(
          `calls/${callSid}/signaling`,
        );
        if (generation !== this.generation) return;
        if (staged?.offer && !this.seenSignalIds.has(staged.offer.id)) {
          this.seenSignalIds.add(staged.offer.id);
          await this.applyOffer({ ...staged.offer, callSid });
        }
        for (const candidate of staged?.ice ?? []) {
          if (generation !== this.generation) return;
          if (this.seenSignalIds.has(candidate.id)) continue;
          this.seenSignalIds.add(candidate.id);
          await this.applyIce(candidate.payload);
        }
      }
      if (generation !== this.generation) return;
      await this.flushPendingIce();
    } catch (error) {
      if (generation !== this.generation) return;
      console.error('[call:web] accept failed', error);
      if (acceptedOnServer) {
        this.finish();
        void this.bestEffortPost('calls/end', {
          callSid,
          endReason: 'failed',
        });
      } else {
        this.acceptingLocally = false;
        // The incoming call remains retryable. Received setup has not yet been
        // applied to a peer connection, so retain it alongside its dedup IDs.
        this.releaseMedia(true);
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
    void this.publishVideoState(enabled);
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
    if (signal.kind !== 'answer' && signal.inReplyTo !== undefined) return;
    if (signal.kind === 'answer' && !signal.inReplyTo) return;
    if (signal.callSid !== this.state.callSid) {
      if (this.state.phase !== 'idle') return;
      if (this.pendingOffer && this.pendingOffer.callSid !== signal.callSid)
        return;
      if (this.seenSignalIds.has(signal.id)) return;
      this.seenSignalIds.add(signal.id);
      // An offer commonly arrives immediately before CALL_EVENT{incoming}.
      if (signal.kind === 'offer') this.pendingOffer = signal;
      else if (signal.kind === 'ice' && this.pendingIce.length < 128)
        this.pendingIce.push(signal.payload);
      return;
    }
    if (this.seenSignalIds.has(signal.id)) return;
    this.seenSignalIds.add(signal.id);
    if (signal.kind === 'offer') {
      const generation = this.generation;
      if (!this.pc) this.pendingOffer = signal;
      else {
        try {
          await this.applyOffer(signal);
        } catch (error) {
          if (generation === this.generation)
            this.failNegotiation('remote offer', error);
        }
      }
    } else if (signal.kind === 'answer' && this.pc) {
      await this.applyAnswer(signal);
    } else if (signal.kind === 'ice') {
      if (!this.pc && this.pendingIce.length < 128)
        this.pendingIce.push(signal.payload);
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
    // Late lifecycle progress must not move an established transport back into setup.
    this.update(
      this.state.phase === 'connected' &&
        (snapshot.phase === 'connecting' || snapshot.phase === 'ringing')
        ? {
            ...snapshot,
            phase: 'connected',
            startedAt: this.state.startedAt,
            step: '',
          }
        : snapshot,
    );
    if (shouldFetchAnswer) {
      if (this.answerBackstop) clearTimeout(this.answerBackstop);
      this.answerBackstop = setTimeout(
        () => void this.fetchStagedAnswer(snapshot.callSid!),
        1_500,
      );
    }
    if (snapshot.phase === 'connected' && !this.serverConnected) {
      this.serverConnected = true;
      void this.flushVideoRequests();
    }
    if (snapshot.phase === 'idle') this.releaseMedia();
  }

  private async fetchStagedAnswer(callSid: string): Promise<void> {
    if (!this.pc || this.pc.remoteDescription || this.state.callSid !== callSid)
      return;
    const generation = this.generation;
    try {
      const staged = await this.get<StagedSignaling>(
        `calls/${callSid}/signaling`,
      );
      if (generation !== this.generation) return;
      if (staged?.answer && !this.seenSignalIds.has(staged.answer.id)) {
        await this.handleSignal({
          ...staged.answer,
          callSid,
          kind: 'answer',
          fromUserId: null,
        });
      }
      for (const candidate of staged?.ice ?? []) {
        if (generation !== this.generation) return;
        if (this.seenSignalIds.has(candidate.id)) continue;
        this.seenSignalIds.add(candidate.id);
        await this.applyIce(candidate.payload);
      }
    } catch (error) {
      console.warn('[call:web] staged answer fetch failed', error);
    }
  }

  private async createPeerConnection(): Promise<void> {
    const generation = this.generation;
    await this.acquireLocalMedia(this.state.callType === 'VIDEO');
    if (generation !== this.generation) return;
    const iceServers = iceServersFromResponse(
      await this.get<IceConfigurationResponse>('calls/ice-servers'),
    );
    if (generation !== this.generation) return;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.negotiation = new WebCallNegotiation(
      (intent) => this.produceOffer(pc, generation, intent),
      (error) => this.failNegotiation('local offer', error),
    );
    for (const track of this.localStream!.getTracks())
      pc.addTrack(track, this.localStream!);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.pc !== pc || generation !== this.generation)
        return;
      const data = candidate.toJSON();
      // Use the candidate's own generation, never the current local SDP credentials.
      data.usernameFragment ??= candidate.usernameFragment;
      if (!this.isIceCandidateInit(data)) return;
      void this.signal('ice', JSON.stringify(data));
    };
    pc.ontrack = (event) => {
      if (this.pc === pc) this.attachRemoteTrack(event);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc) this.onConnectionState(pc.connectionState);
    };
  }

  private async acquireLocalMedia(withVideo: boolean): Promise<void> {
    if (
      this.localStream?.active &&
      (!withVideo || this.localStream.getVideoTracks().length > 0)
    )
      return;
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
      video: withVideo ? { facingMode: this.facingMode } : false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.localStream = stream;
    for (const track of this.localStream.getTracks())
      this.bindLocalTrackLifecycle(track);
    this.update({ cameraEnabled: withVideo });
    if (this.selfVideo) this.selfVideo.srcObject = this.localStream;
  }

  private async applyOffer(offer: {
    id: string;
    payload: string;
    callSid: string;
  }): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      this.pendingOffer = offer;
      return;
    }
    const generation = this.generation;
    // The caller may receive our answer before its POST response reaches us.
    // Queue the next offer instead of confusing transport acknowledgement with JSEP overlap.
    const operation = this.remoteOfferTail.then(() =>
      this.answerOffer(offer, pc, generation),
    );
    this.remoteOfferTail = operation.catch(() => undefined);
    return operation;
  }

  private async answerOffer(
    offer: { id: string; payload: string; callSid: string },
    pc: RTCPeerConnection,
    generation: number,
  ): Promise<void> {
    const live = () =>
      generation === this.generation &&
      this.pc === pc &&
      this.state.callSid === offer.callSid;
    if (!live()) return;
    if (this.state.isCaller || pc.signalingState !== 'stable')
      throw new Error('unexpected remote offer');
    this.armNegotiationBackstop();
    this.remoteOfferBusy = true;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.payload });
      if (!live()) return;
      this.remoteIce.setDescription(offer.payload);
      await this.flushPendingIce();
      if (!live()) return;
      const answer = await pc.createAnswer();
      if (!live()) return;
      await pc.setLocalDescription(answer);
      if (!live()) return;
      await this.signal('answer', answer.sdp ?? '', uuid(), offer.id);
      if (!live()) return;
      this.cancelNegotiationBackstop();
      this.completeNegotiation('answer-sent');
      if (this.state.callType === 'VIDEO')
        this.update({ videoUpgradeState: 'idle' });
    } finally {
      if (live()) this.remoteOfferBusy = false;
    }
  }

  private async produceOffer(
    pc: RTCPeerConnection,
    generation: number,
    intent: { video: boolean; restart: boolean },
  ): Promise<void> {
    const live = () => this.pc === pc && generation === this.generation;
    if (!live() || !this.state.isCaller) return;
    if (pc.signalingState !== 'stable')
      throw new Error('offer requires stable JSEP');
    if (
      intent.video &&
      !pc
        .getTransceivers()
        .some(
          (t) =>
            t.direction !== 'stopped' &&
            (t.sender.track?.kind === 'video' ||
              t.receiver.track.kind === 'video'),
        )
    ) {
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    const lane = this.negotiation!;
    const id = uuid();
    lane.active = {
      id,
      ...intent,
      sendVideo: this.state.cameraEnabled,
      receiveVideo:
        intent.video &&
        (!this.state.cameraEnabled || this.state.remoteCameraEnabled),
    };
    this.armNegotiationBackstop();
    if (intent.restart) pc.restartIce();
    const offer = await pc.createOffer(
      intent.restart ? { iceRestart: true } : undefined,
    );
    if (!live()) return;
    await pc.setLocalDescription(offer);
    if (!live()) return;
    this.armNegotiationBackstop();
    await this.signal('offer', offer.sdp ?? '', id);
    if (!live() || lane.active?.id !== id) return;
    this.update({ step: this.state.phase === 'connected' ? '' : 'offer-sent' });
    if (intent.restart) this.armReconnectBackstop();
  }

  private async applyAnswer(signal: CallSignalPayload): Promise<void> {
    const pc = this.pc,
      lane = this.negotiation;
    if (!pc || !lane || !this.state.isCaller) return;
    const reference = signal.inReplyTo;
    if (reference && lane.isCompleted(reference)) return;
    if (
      !reference ||
      lane.active?.id !== reference ||
      pc.signalingState !== 'have-local-offer' ||
      this.applyingAnswer
    )
      return;
    const generation = this.generation;
    const live = () => generation === this.generation && this.pc === pc;
    const active = lane.active;
    this.applyingAnswer = true;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.payload });
      if (!live()) return;
      if ((pc.signalingState as RTCSignalingState) !== 'stable')
        throw new Error('answer did not stabilize JSEP');
      this.remoteIce.setDescription(signal.payload);
      await this.flushPendingIce();
      if (!live()) return;
      if (this.answerBackstop) clearTimeout(this.answerBackstop);
      this.cancelNegotiationBackstop();
      this.completeNegotiation('answer-received');
      if (active.video) {
        if (
          negotiatedVideo(
            pc.localDescription?.sdp ?? '',
            signal.payload,
            active.sendVideo,
            active.receiveVideo,
          )
        )
          await this.completeVideoUpgrade();
        else this.update({ videoUpgradeState: 'failed' });
      }
      if (!live()) return;
      this.applyingAnswer = false;
      lane.complete(reference);
    } catch (error) {
      if (live()) this.failNegotiation('remote answer', error);
    } finally {
      if (live()) this.applyingAnswer = false;
    }
  }

  private completeNegotiation(step: 'answer-sent' | 'answer-received'): void {
    // Renegotiation need not change the peer connection's transport state. Keep an
    // established call connected rather than waiting for another connected event.
    if (this.state.phase === 'connected') this.update({ step: '' });
    else if (step === 'answer-received' && this.state.phase !== 'reconnecting')
      this.update({ phase: 'connecting', step });
    else this.update({ step });
  }

  private async applyIce(payload: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!this.isIceCandidateInit(parsed)) return;
      const ready = this.remoteIce.take(parsed);
      if (ready) await this.pc?.addIceCandidate(ready);
    } catch (error) {
      console.warn('[call:web] ignored invalid ICE candidate', error);
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc?.remoteDescription) return;
    const pc = this.pc;
    const ice = this.remoteIce;
    for (const payload of this.pendingIce.splice(0)) {
      if (this.pc !== pc) return;
      await this.applyIce(payload);
    }
    if (this.pc !== pc) return;
    for (const candidate of ice.flush()) {
      if (this.pc !== pc) return;
      await pc.addIceCandidate(candidate);
    }
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
      if (!this.negotiation?.active && !this.remoteOfferBusy)
        this.cancelNegotiationBackstop();
      this.cancelReconnectBackstop();
      this.iceRestartTried = false;
      this.connectedReported = true;
      void this.bestEffortPost('calls/connected', {
        callSid: this.state.callSid,
      });
    } else if (state === 'connected') {
      if (!this.negotiation?.active && !this.remoteOfferBusy)
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
        !this.negotiation?.active &&
        !this.remoteOfferBusy &&
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
    this.negotiation?.request('restart');
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
      if (this.state.callType === 'AUDIO') {
        const pc = this.pc;
        if (
          this.state.isCaller &&
          this.serverConnected &&
          pc.signalingState === 'stable' &&
          negotiatedVideo(
            pc.localDescription?.sdp ?? '',
            pc.remoteDescription?.sdp ?? '',
            true,
            this.state.remoteCameraEnabled,
          )
        ) {
          this.update({ videoUpgradeState: 'upgrading' });
          await this.completeVideoUpgrade();
        } else if (this.state.isCaller) await this.createVideoOffer();
      }
      return;
    }
    if (this.cameraBusy) return;
    const pc = this.pc;
    const generation = this.generation;
    const live = () => generation === this.generation && this.pc === pc;
    this.cameraBusy = true;
    this.update({ videoUpgradeState: 'upgrading' });
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facingMode },
        audio: false,
      });
      if (!live()) {
        camera.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = camera.getVideoTracks()[0];
      if (!track) throw new Error('camera returned no video track');
      this.localStream ??= new MediaStream();
      this.localStream.addTrack(track);
      this.bindLocalTrackLifecycle(track);
      const transceiver = pc
        .getTransceivers()
        .find(
          (t) => t.direction !== 'stopped' && t.receiver.track.kind === 'video',
        );
      if (transceiver) {
        await transceiver.sender.replaceTrack(track);
        if (!live()) {
          track.stop();
          return;
        }
        transceiver.direction = 'sendrecv';
      } else pc.addTrack(track, this.localStream);
      if (this.selfVideo) this.selfVideo.srcObject = this.localStream;
      this.update({ cameraEnabled: true });
      await this.publishVideoState(true);
      if (live() && this.state.isCaller) await this.createVideoOffer();
    } catch (error) {
      if (!live()) return;
      console.error('[call:web] video upgrade failed', error);
      this.update({ videoUpgradeState: 'failed', cameraEnabled: false });
    } finally {
      if (live()) this.cameraBusy = false;
    }
  }

  private async createVideoOffer(): Promise<void> {
    if (!this.pc || !this.state.isCaller) return;
    this.update({ videoUpgradeState: 'upgrading' });
    if (!this.serverConnected) {
      this.pendingVideoOffer = true;
      return;
    }
    this.negotiation?.request('video');
  }

  private async publishVideoState(enabled: boolean): Promise<void> {
    if (!this.serverConnected) {
      this.pendingVideoState = enabled;
      return;
    }
    await this.signal('video-state', JSON.stringify({ enabled }));
  }

  private async flushVideoRequests(): Promise<void> {
    const generation = this.generation;
    const enabled = this.pendingVideoState;
    this.pendingVideoState = undefined;
    try {
      if (enabled !== undefined) await this.publishVideoState(enabled);
      if (generation !== this.generation) return;
      if (this.pendingVideoOffer) {
        this.pendingVideoOffer = false;
        await this.createVideoOffer();
      }
    } catch (error) {
      if (generation === this.generation) {
        console.error('[call:web] deferred media intent failed', error);
        this.update({ videoUpgradeState: 'failed' });
      }
    }
  }

  private async completeVideoUpgrade(): Promise<void> {
    const callSid = this.state.callSid;
    if (!callSid) return;
    // Adding a camera to an existing video call is media renegotiation, not a
    // server-side call-type upgrade. Either participant can complete it locally.
    if (this.state.callType === 'VIDEO') {
      this.update({ videoUpgradeState: 'idle' });
      return;
    }
    if (!this.state.isCaller) return;
    const generation = this.generation;
    try {
      const response = await this.postResponse('calls/upgrade-video', {
        callSid,
      });
      if (generation !== this.generation) return;
      if (response.code !== BusinessCode.OK)
        throw new Error(`video upgrade rejected: ${response.code}`);
      this.update({ callType: 'VIDEO', videoUpgradeState: 'idle' });
    } catch (error) {
      if (generation !== this.generation) return;
      console.error('[call:web] video upgrade persistence failed', error);
      this.update({ videoUpgradeState: 'failed' });
    }
  }

  private async replaceCamera(): Promise<void> {
    const oldTrack = this.localStream?.getVideoTracks()[0];
    if (!oldTrack || !this.pc) return;
    const pc = this.pc;
    const generation = this.generation;
    const nextFacing = this.facingMode === 'user' ? 'environment' : 'user';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: nextFacing } },
        audio: false,
      });
      if (generation !== this.generation || this.pc !== pc) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const nextTrack = stream.getVideoTracks()[0];
      const sender = pc
        .getSenders()
        .find((item) => item.track?.kind === 'video');
      await sender?.replaceTrack(nextTrack);
      if (generation !== this.generation || this.pc !== pc) {
        nextTrack.stop();
        return;
      }
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
          (candidate['sdpMLineIndex'] as number) >= 0 &&
          (candidate['sdpMLineIndex'] as number) <= 65535)) &&
      typeof candidate['usernameFragment'] === 'string' &&
      /^[A-Za-z0-9+/]{4,256}$/.test(candidate['usernameFragment'])
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
      void this.publishVideoState(false);
    };
  }

  private async signal(
    kind: string,
    payload: string,
    id = uuid(),
    inReplyTo?: string,
  ): Promise<void> {
    const { callSid } = this.state;
    if (!callSid) return;
    await this.post('calls/signal', {
      id,
      callSid,
      kind,
      payload,
      ...(kind === 'answer' ? { inReplyTo } : {}),
    });
  }

  private update(patch: Partial<CallSnapshot> | CallSnapshot): void {
    this.state = { ...this.state, ...patch };
    this.listener?.({ ...this.state });
  }

  private finish(reason?: CallTerminalReason): void {
    const ownsCall = !!this.state.callSid;
    if (ownsCall)
      this.update({ phase: 'ended', terminalReason: reason ?? null });
    this.releaseMedia();
    this.seenSignalIds.clear();
    this.state = { ...this.idle };
    // Media acquisition may fail before a call is owned. Publish the cleaned idle
    // state so the renderer can retry; there is no call to show as ended.
    if (!ownsCall) this.listener?.({ ...this.state });
  }

  private releaseMedia(preservePendingSetup = false): void {
    this.generation++;
    this.negotiation?.dispose();
    this.negotiation = undefined;
    this.remoteIce = new RemoteIceGenerations();
    this.remoteOfferBusy =
      this.applyingAnswer =
      this.cameraBusy =
      this.outgoingBusy =
        false;
    this.remoteOfferTail = Promise.resolve();
    this.serverConnected = false;
    this.pendingVideoState = undefined;
    this.pendingVideoOffer = false;
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
    if (!preservePendingSetup) {
      this.pendingOffer = undefined;
      this.pendingIce.length = 0;
    }
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
    const response = await this.postResponse<T>(path, body);
    if (response.code !== BusinessCode.OK)
      throw new Error(`${path} rejected: ${response.code}`);
    return response.data;
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
