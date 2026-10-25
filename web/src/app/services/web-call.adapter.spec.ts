import { HttpClient, HttpContext } from '@angular/common/http';
import { of, Subject } from 'rxjs';
import { IDLE_CALL, type CallSnapshot } from './call-adapter';
import { BusinessCode } from './biz-code';
import {
  WebCallAdapter,
  callMediaErrorStep,
  iceServersFromResponse,
  localTrackEndAction,
  webReconnectDecision,
} from './web-call.adapter';

import {
  WebCallNegotiation,
  RemoteIceGenerations,
  negotiatedVideo,
} from './web-call-negotiation';

const audioSdp =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=ice-ufrag:remote1\r\n';
const videoSdp =
  audioSdp +
  'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendrecv\r\na=ice-ufrag:remote1\r\n';
function answeringPc(sdp = audioSdp) {
  const pc = {
    signalingState: 'have-local-offer' as RTCSignalingState,
    localDescription: { type: 'offer', sdp },
    remoteDescription: null as RTCSessionDescriptionInit | null,
    setRemoteDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        pc.remoteDescription = description;
        pc.signalingState =
          description.type === 'answer' ? 'stable' : 'have-remote-offer';
      },
    ),
    setLocalDescription: vi.fn(async () => {
      pc.signalingState = 'stable';
    }),
    createAnswer: vi.fn().mockResolvedValue({ sdp }),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  return pc;
}
function activeLane(video = false) {
  const lane = new WebCallNegotiation(async () => {}, vi.fn());
  lane.active = {
    id: 'local-offer',
    video,
    restart: false,
    sendVideo: video,
    receiveVideo: false,
  };
  return lane;
}

describe('approved call signaling correlation', () => {
  const signal = (id: string, inReplyTo: string, payload = videoSdp) => ({
    id,
    inReplyTo,
    payload,
    callSid: 'correlated',
    kind: 'answer' as const,
    fromUserId: 7,
  });
  function fixture(code = 0, video = true) {
    const post = vi.fn().mockReturnValue(of({ code, message: '' }));
    const adapter = new WebCallAdapter(
      { post } as unknown as HttpClient,
      IDLE_CALL,
    );
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'correlated',
      isCaller: true,
      startedAt: 1234,
      cameraEnabled: true,
      videoUpgradeState: 'upgrading',
    });
    const pc = answeringPc(videoSdp),
      lane = activeLane(video);
    Object.assign(adapter, { pc, negotiation: lane });
    return { adapter, pc, lane, post };
  }

  afterEach(() => {
    window.dispatchEvent(new Event('soms-call-session-ending'));
    vi.unstubAllGlobals();
  });

  it('does not apply unrelated answers, unlock, or persist video; absorbs old completions', async () => {
    const { adapter, pc, lane, post } = fixture();
    await adapter.handleSignal(signal('wrong', 'other-offer'));
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(lane.active?.id).toBe('local-offer');
    expect(post).not.toHaveBeenCalled();
    await adapter.handleSignal(signal('right', 'local-offer'));
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(lane.active).toBeUndefined();
    expect(adapter.snapshot()).toMatchObject({
      phase: 'connected',
      startedAt: 1234,
      callType: 'VIDEO',
    });
    lane.active = {
      id: 'new-offer',
      video: false,
      restart: true,
      sendVideo: false,
      receiveVideo: false,
    };
    pc.signalingState = 'have-local-offer';
    await adapter.handleSignal(signal('old-new-id', 'local-offer'));
    await adapter.handleSignal(signal('right', 'local-offer'));
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(lane.active?.id).toBe('new-offer');
    expect(post).toHaveBeenCalledOnce();
  });

  it('requires JSEP have-local-offer and has no legacy answer fallback', async () => {
    const { adapter, pc, lane } = fixture();
    pc.signalingState = 'stable';
    await adapter.handleSignal(signal('stable-answer', 'local-offer'));
    pc.signalingState = 'have-local-offer';
    await adapter.handleSignal(
      signal('missing-reference', undefined as unknown as string),
    );
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(lane.active?.id).toBe('local-offer');
  });

  it.each([
    ['rejected-video', audioSdp, 0],
    ['business-error', videoSdp, 999],
  ])('does not persist successful video for %s', async (_, payload, code) => {
    const { adapter, post } = fixture(code);
    await adapter.handleSignal(signal('answer', 'local-offer', payload));
    expect(adapter.snapshot()).toMatchObject({
      callType: 'AUDIO',
      videoUpgradeState: 'failed',
    });
    if (payload === audioSdp) expect(post).not.toHaveBeenCalled();
  });

  it('a matching ICE restart answer alone is not a video completion', async () => {
    const { adapter, post } = fixture(0, false);
    await adapter.handleSignal(signal('restart-answer', 'local-offer'));
    expect(post).not.toHaveBeenCalled();
    expect(adapter.snapshot().callType).toBe('AUDIO');
  });

  it('uses the same correlated completion path for staged answers', async () => {
    const { adapter, pc, post } = fixture();
    Object.assign(adapter, {
      get: vi.fn().mockResolvedValue({
        answer: { id: 'staged', inReplyTo: 'local-offer', payload: videoSdp },
        ice: [],
      }),
    });
    await (
      adapter as unknown as { fetchStagedAnswer(id: string): Promise<void> }
    ).fetchStagedAnswer('correlated');
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(adapter.snapshot()).toMatchObject({
      callType: 'VIDEO',
      startedAt: 1234,
    });
    expect(post).toHaveBeenCalledOnce();
  });

  it('queues the next remote offer while the previous answer HTTP acknowledgement is delayed', async () => {
    const { adapter, pc, post } = fixture(0, false);
    adapter.applyLifecycle({ ...adapter.snapshot(), isCaller: false });
    pc.signalingState = 'stable';
    const ack = new Subject<{ code: number; message: string }>();
    let answerCount = 0;
    post.mockImplementation((_url, body) =>
      body.kind === 'answer' && ++answerCount === 1
        ? ack
        : of({ code: 0, message: '' }),
    );
    const first = adapter.handleSignal({
      id: 'remote-first',
      callSid: 'correlated',
      fromUserId: 7,
      kind: 'offer',
      payload: audioSdp,
    });
    await vi.waitFor(() => expect(answerCount).toBe(1));
    const second = adapter.handleSignal({
      id: 'remote-second',
      callSid: 'correlated',
      fromUserId: 7,
      kind: 'offer',
      payload: audioSdp,
    });
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(pc.close).not.toHaveBeenCalled();
    ack.next({ code: 0, message: '' });
    await Promise.all([first, second]);
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(2);
    expect(
      post.mock.calls
        .filter(([, body]) => body.kind === 'answer')
        .map(([, body]) => body.inReplyTo),
    ).toEqual(['remote-first', 'remote-second']);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it('compensates late successful admission after cancellation without touching a newer call', async () => {
    const admission = new Subject<{
      code: number;
      data: { threadId: number };
    }>();
    const post = vi.fn((url: string, _body: Record<string, unknown>) =>
      url.endsWith('/calls/initiate') ? admission : of({ code: 0 }),
    );
    const adapter = new WebCallAdapter(
      { post } as unknown as HttpClient,
      IDLE_CALL,
    );
    const track = { kind: 'audio', stop: vi.fn(), onended: null };
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          active: true,
          getTracks: () => [track],
          getVideoTracks: () => [],
        }),
      },
    });
    const create = vi.fn();
    Object.assign(adapter, { createPeerConnection: create });
    adapter.initiate(1, 'old-admission', 'AUDIO', 'peer', 0);
    await vi.waitFor(() => expect(adapter.snapshot().phase).toBe('starting'));
    adapter.cancel('old-admission');
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'new-call',
      startedAt: 987,
    });
    const newPc = answeringPc();
    Object.assign(adapter, { pc: newPc });
    admission.next({ code: 0, data: { threadId: 1 } });
    await vi.waitFor(() =>
      expect(
        post.mock.calls.filter(([url]) => url.endsWith('/calls/cancel')),
      ).toHaveLength(2),
    );
    expect(
      post.mock.calls
        .filter(([url]) => url.endsWith('/calls/cancel'))
        .map(([, body]) => body['callSid']),
    ).toEqual(['old-admission', 'old-admission']);
    expect(create).not.toHaveBeenCalled();
    expect(newPc.close).not.toHaveBeenCalled();
    expect(adapter.snapshot()).toMatchObject({
      callSid: 'new-call',
      phase: 'connected',
      startedAt: 987,
    });
  });

  it.each(['outgoing', 'incoming'] as const)(
    'cleans %s setup failure before its delayed terminal report can affect a new call',
    async (role) => {
      const report = new Subject<{ code: number }>();
      const path = role === 'outgoing' ? '/calls/cancel' : '/calls/end';
      const post = vi.fn((url: string, _body: Record<string, unknown>) =>
        url.endsWith(path) ? report : of({ code: 0, data: { threadId: 1 } }),
      );
      const adapter = new WebCallAdapter(
        { post } as unknown as HttpClient,
        IDLE_CALL,
      );
      const track = { kind: 'audio', stop: vi.fn(), onended: null };
      vi.stubGlobal('navigator', {
        ...navigator,
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            active: true,
            getTracks: () => [track],
            getVideoTracks: () => [],
          }),
        },
      });
      Object.assign(adapter, {
        createPeerConnection: vi
          .fn()
          .mockRejectedValue(new Error('setup failed')),
      });
      if (role === 'outgoing')
        adapter.initiate(1, 'old-setup', 'AUDIO', 'peer', 0);
      else {
        await adapter.onIncoming({
          ...IDLE_CALL,
          phase: 'incoming',
          callSid: 'old-setup',
        });
        adapter.accept('old-setup');
      }
      await vi.waitFor(() =>
        expect(post.mock.calls.some(([url]) => url.endsWith(path))).toBe(true),
      );
      expect(adapter.snapshot()).toEqual(IDLE_CALL);
      adapter.applyLifecycle({
        ...IDLE_CALL,
        phase: 'connected',
        callSid: 'replacement',
        startedAt: 1234,
      });
      const pc = answeringPc();
      Object.assign(adapter, { pc });
      report.next({ code: 0 });
      await Promise.resolve();
      await Promise.resolve();
      expect(pc.close).not.toHaveBeenCalled();
      expect(adapter.snapshot()).toMatchObject({
        callSid: 'replacement',
        phase: 'connected',
        startedAt: 1234,
      });
    },
  );

  it.each(['rejected-video', 'persistence-failed'] as const)(
    'retries %s with the existing camera without another capture',
    async (reason) => {
      const { adapter, pc, lane, post } = fixture(
        reason === 'persistence-failed' ? 999 : 0,
      );
      const track = {
        kind: 'video',
        enabled: true,
        stop: vi.fn(),
        onended: null,
      };
      Object.assign(adapter, {
        localStream: {
          getVideoTracks: () => [track],
          getTracks: () => [track],
        },
      });
      await adapter.handleSignal(
        signal(
          'first-answer',
          'local-offer',
          reason === 'rejected-video' ? audioSdp : videoSdp,
        ),
      );
      expect(adapter.snapshot().videoUpgradeState).toBe('failed');
      post.mockReset();
      post.mockReturnValue(of({ code: 0 }));
      const request = vi.spyOn(lane, 'request');
      const getUserMedia = vi.fn();
      vi.stubGlobal('navigator', {
        ...navigator,
        mediaDevices: { getUserMedia },
      });
      adapter.upgradeToVideo();
      if (reason === 'rejected-video')
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith('video'));
      else {
        await vi.waitFor(() =>
          expect(adapter.snapshot()).toMatchObject({
            callType: 'VIDEO',
            videoUpgradeState: 'idle',
          }),
        );
        expect(request).not.toHaveBeenCalled();
        expect(
          post.mock.calls.some(([url]) => url.endsWith('/calls/upgrade-video')),
        ).toBe(true);
      }
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(adapter.snapshot()).toMatchObject({
        phase: 'connected',
        startedAt: 1234,
      });
      expect(pc.close).not.toHaveBeenCalled();
    },
  );

  it('defers video signaling until server connected confirmation, not merely local PC connected', async () => {
    const { adapter, lane, post } = fixture(0, false);
    Object.assign(adapter, {
      serverConnected: false,
      localStream: {
        getVideoTracks: () => [{ enabled: true, stop: vi.fn() }],
        getTracks: () => [],
      },
    });
    const request = vi.spyOn(lane, 'request');
    adapter.upgradeToVideo();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    adapter.applyLifecycle({ ...adapter.snapshot(), phase: 'connected' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('video'));
    expect(
      post.mock.calls.some(([, body]) => body.kind === 'video-state'),
    ).toBe(true);
  });

  it('buffers pre-SDP ICE, rejects absent/invalid ufrag and never applies obsolete generations', async () => {
    const { adapter, pc } = fixture(0, false);
    const ice = async (id: string, ufrag?: string, mid = '0') =>
      adapter.handleSignal({
        id,
        callSid: 'correlated',
        fromUserId: 7,
        kind: 'ice',
        payload: JSON.stringify({
          candidate: `candidate:${id}`,
          sdpMid: mid,
          usernameFragment: ufrag,
        }),
      });
    await ice('early', 'remote1');
    await ice('missing');
    await ice('invalid', 'white space');
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    await adapter.handleSignal(signal('initial', 'local-offer', audioSdp));
    expect(pc.addIceCandidate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ usernameFragment: 'remote1' }),
    );
    const remoteIce = (
      adapter as unknown as { remoteIce: RemoteIceGenerations }
    ).remoteIce;
    remoteIce.setDescription(audioSdp.replace('remote1', 'remote2'));
    await ice('old', 'remote1');
    await ice('wrong-mid', 'remote2', '1');
    await ice('new', 'remote2');
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate.mock.calls.at(-1)?.[0]).toMatchObject({
      usernameFragment: 'remote2',
    });
  });

  it('serializes/coalesces video and restart requests during async offer creation and awaiting answer', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let lane!: WebCallNegotiation;
    const produce = vi.fn(
      async (intent: { video: boolean; restart: boolean }) => {
        lane.active = {
          id: `offer-${produce.mock.calls.length}`,
          ...intent,
          sendVideo: false,
          receiveVideo: intent.video,
        };
        await waiting;
      },
    );
    lane = new WebCallNegotiation(produce, vi.fn());
    lane.request('initial');
    lane.request('video');
    lane.request('video');
    lane.request('restart');
    expect(produce).toHaveBeenCalledOnce();
    finish();
    await waiting;
    await Promise.resolve();
    expect(produce).toHaveBeenCalledOnce();
    lane.complete('unrelated');
    expect(produce).toHaveBeenCalledOnce();
    lane.complete('offer-1');
    expect(produce).toHaveBeenCalledTimes(2);
    expect(produce.mock.calls[1][0]).toEqual({ video: true, restart: true });
    lane.request('video');
    lane.dispose();
    lane.complete('offer-2');
    await Promise.resolve();
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('callee-first video creates receive capacity without capturing caller camera', async () => {
    const { adapter, pc } = fixture(0, false);
    pc.signalingState = 'stable';
    const addTransceiver = vi.fn();
    const createOffer = vi.fn().mockResolvedValue({ sdp: videoSdp });
    Object.assign(pc, {
      getTransceivers: () => [],
      addTransceiver,
      createOffer,
    });
    const generation = (adapter as unknown as { generation: number })
      .generation;
    Object.assign(adapter, {
      negotiation: new WebCallNegotiation(
        (intent) =>
          (
            adapter as unknown as {
              produceOffer(
                pc: unknown,
                gen: number,
                intent: unknown,
              ): Promise<void>;
            }
          ).produceOffer(pc, generation, intent),
        vi.fn(),
      ),
    });
    adapter.applyLifecycle({ ...adapter.snapshot(), cameraEnabled: false });
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    await adapter.handleSignal({
      id: 'callee-camera',
      callSid: 'correlated',
      fromUserId: 7,
      kind: 'video-state',
      payload: '{"enabled":true}',
    });
    await vi.waitFor(() => expect(createOffer).toHaveBeenCalledOnce());
    expect(addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'recvonly',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(adapter.snapshot()).toMatchObject({
      phase: 'connected',
      startedAt: 1234,
      cameraEnabled: false,
    });
  });

  it('stops media returned after teardown and does not resurrect setup', async () => {
    let resolve!: (value: unknown) => void;
    const getUserMedia = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    const post = vi.fn().mockReturnValue(of({ code: 0 }));
    const adapter = new WebCallAdapter(
      { post } as unknown as HttpClient,
      IDLE_CALL,
    );
    adapter.initiate(1, 'late-media', 'AUDIO', 'peer', 0);
    adapter.initiate(1, 'duplicate-click', 'AUDIO', 'peer', 0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    adapter.cancel('late-media');
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(adapter.snapshot()).toEqual(IDLE_CALL);
    expect(
      post.mock.calls.some(([url]) => url.endsWith('/calls/initiate')),
    ).toBe(false);
  });

  it('reuses the receive transceiver when the caller later enables its camera', async () => {
    const { adapter, pc } = fixture();
    const track = { kind: 'video', stop: vi.fn(), onended: null };
    const replaceTrack = vi.fn().mockResolvedValue(undefined);
    const addTrack = vi.fn();
    const transceiver = {
      receiver: { track: { kind: 'video' } },
      sender: { replaceTrack },
      direction: 'recvonly',
    };
    Object.assign(pc, { getTransceivers: () => [transceiver], addTrack });
    const localTracks: unknown[] = [];
    Object.assign(adapter, {
      localStream: {
        getVideoTracks: () => localTracks,
        addTrack: (t: unknown) => localTracks.push(t),
        getTracks: () => localTracks,
      },
    });
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
          getVideoTracks: () => [track],
        }),
      },
    });
    adapter.upgradeToVideo();
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledWith(track));
    await vi.waitFor(() => expect(transceiver.direction).toBe('sendrecv'));
    expect(addTrack).not.toHaveBeenCalled();
  });

  it('a negotiation timeout terminates rather than replacing an outstanding offer', () => {
    vi.useFakeTimers();
    try {
      const { adapter, lane, pc } = fixture();
      const request = vi.spyOn(lane, 'request');
      (
        adapter as unknown as { armNegotiationBackstop(): void }
      ).armNegotiationBackstop();
      lane.request('video');
      lane.request('restart');
      vi.advanceTimersByTime(45_000);
      expect(adapter.snapshot()).toEqual(IDLE_CALL);
      expect(pc.close).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(lane.active).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('teardown during async offer creation suppresses local SDP and signaling', async () => {
    const { adapter, pc, post } = fixture();
    pc.signalingState = 'stable';
    let resolve!: (sdp: unknown) => void;
    Object.assign(pc, {
      createOffer: vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    });
    const generation = (adapter as unknown as { generation: number })
      .generation;
    const offer = (
      adapter as unknown as {
        produceOffer(pc: unknown, gen: number, intent: unknown): Promise<void>;
      }
    ).produceOffer(pc, generation, { video: false, restart: false });
    adapter.end('correlated');
    resolve({ sdp: audioSdp });
    await offer;
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([url]) => url.endsWith('/calls/signal'))).toBe(
      false,
    );
    expect(adapter.snapshot()).toEqual(IDLE_CALL);
  });

  it('sends a delayed candidate with its actual ufrag, never the latest local SDP ufrag', async () => {
    const { adapter, post } = fixture();
    const mediaTrack = { kind: 'audio', stop: vi.fn(), onended: null };
    Object.assign(adapter, {
      localStream: {
        active: true,
        getTracks: () => [mediaTrack],
        getVideoTracks: () => [],
      },
      get: vi.fn().mockResolvedValue({ iceServers: [] }),
    });
    const pc = {
      addTrack: vi.fn(),
      close: vi.fn(),
      localDescription: { sdp: audioSdp.replace('remote1', 'latest') },
      onicecandidate: undefined as unknown as (event: {
        candidate: unknown;
      }) => void,
    };
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          return pc;
        }
      },
    );
    await (
      adapter as unknown as { createPeerConnection(): Promise<void> }
    ).createPeerConnection();
    pc.onicecandidate({
      candidate: {
        usernameFragment: 'actualOld',
        toJSON: () => ({ candidate: 'candidate:old', sdpMid: '0' }),
      },
    });
    pc.onicecandidate({
      candidate: {
        usernameFragment: null,
        toJSON: () => ({ candidate: 'candidate:missing', sdpMid: '0' }),
      },
    });
    expect(post).toHaveBeenCalledOnce();
    expect(JSON.parse(post.mock.calls[0][1].payload)).toMatchObject({
      usernameFragment: 'actualOld',
    });
    expect(post.mock.calls[0][1]).not.toHaveProperty('inReplyTo');
  });

  it('does not drain a replacement call ICE buffer when an old candidate await completes', async () => {
    const { adapter, pc } = fixture(0, false);
    pc.remoteDescription = { type: 'answer', sdp: audioSdp };
    const oldIce = new RemoteIceGenerations();
    oldIce.setDescription(audioSdp);
    let done!: () => void;
    pc.addIceCandidate.mockReturnValue(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    Object.assign(adapter, {
      remoteIce: oldIce,
      pendingIce: [
        JSON.stringify({
          candidate: 'old-candidate',
          sdpMid: '0',
          usernameFragment: 'remote1',
        }),
      ],
    });
    const flush = (
      adapter as unknown as { flushPendingIce(): Promise<void> }
    ).flushPendingIce();
    expect(pc.addIceCandidate).toHaveBeenCalledOnce();
    adapter.end('correlated');
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'replacement',
    });
    const nextPc = answeringPc(),
      nextIce = new RemoteIceGenerations();
    nextIce.take({
      candidate: 'new-candidate',
      sdpMid: '0',
      usernameFragment: 'remote1',
    });
    nextIce.setDescription(audioSdp);
    Object.assign(adapter, { pc: nextPc, remoteIce: nextIce });
    done();
    await flush;
    expect(nextPc.addIceCandidate).not.toHaveBeenCalled();
    expect(nextIce.flush()).toHaveLength(1);
    expect(adapter.snapshot().callSid).toBe('replacement');
  });

  it('inherits bundled ICE credentials and rejects candidate extension generation conflicts', () => {
    const generations = new RemoteIceGenerations();
    generations.setDescription(
      audioSdp.replace('v=0\r\n', 'v=0\r\na=group:BUNDLE 0 1\r\n') +
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n',
    );
    expect(
      generations.take({
        candidate: 'candidate:1 ufrag old1',
        sdpMid: '1',
        usernameFragment: 'remote1',
      }),
    ).toBeUndefined();
    expect(
      generations.take({
        candidate: 'candidate:2 ufrag remote1',
        sdpMid: '1',
        sdpMLineIndex: 1,
        usernameFragment: 'remote1',
      }),
    ).toBeDefined();
  });

  it('honors session-level video direction and media-level overrides before persistence', () => {
    const inheritedInactive = videoSdp
      .replace('v=0\r\n', 'v=0\r\na=inactive\r\n')
      .replace('a=sendrecv\r\n', '');
    expect(negotiatedVideo(videoSdp, inheritedInactive, true, false)).toBe(
      false,
    );
    const override = videoSdp.replace('v=0\r\n', 'v=0\r\na=inactive\r\n');
    expect(negotiatedVideo(videoSdp, override, true, false)).toBe(true);
  });

  it('bounds pre-description candidate buffering and routes media section credentials', () => {
    const generations = new RemoteIceGenerations();
    for (let i = 0; i < 200; i++)
      generations.take({
        candidate: `${i}`,
        sdpMid: '0',
        usernameFragment: 'remote1',
      });
    generations.setDescription(audioSdp);
    expect(generations.flush()).toHaveLength(128);
    expect(
      generations.take({
        candidate: 'wrong',
        sdpMid: '1',
        usernameFragment: 'remote1',
      }),
    ).toBeUndefined();
    generations.setDescription(
      audioSdp +
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=ice-ufrag:video2\r\n',
    );
    expect(
      generations.take({
        candidate: 'correct',
        sdpMid: '1',
        sdpMLineIndex: 1,
        usernameFragment: 'video2',
      }),
    ).toBeDefined();
    expect(
      generations.take({
        candidate: 'conflict',
        sdpMid: '1',
        sdpMLineIndex: 0,
        usernameFragment: 'video2',
      }),
    ).toBeUndefined();
    expect(
      negotiatedVideo(
        videoSdp,
        videoSdp.replace('a=sendrecv', 'a=inactive'),
        true,
        false,
      ),
    ).toBe(false);
  });
});

describe('WebCallAdapter multi-device ownership', () => {
  it('ends a server-rejected outgoing call as busy and releases the microphone', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', stop, onended: null };
    const getUserMedia = vi.fn().mockResolvedValue({
      active: true,
      getTracks: () => [track],
      getVideoTracks: () => [],
    });
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    try {
      const post = vi
        .fn()
        .mockReturnValue(
          of({ code: BusinessCode.CALL_BUSY, message: 'busy', data: null }),
        );
      const mediaError = vi.fn();
      const adapter = new WebCallAdapter(
        { post } as unknown as HttpClient,
        IDLE_CALL,
        mediaError,
      );
      const snapshots: CallSnapshot[] = [];
      adapter.setSnapshotListener((snapshot) => snapshots.push(snapshot));

      adapter.initiate(12, 'busy-call', 'AUDIO', 'b', 0);
      await vi.waitFor(() =>
        expect(snapshots.at(-1)?.terminalReason).toBe('busy'),
      );

      expect(snapshots).toContainEqual(
        expect.objectContaining({ phase: 'starting', callSid: 'busy-call' }),
      );
      expect(snapshots.at(-1)).toEqual(
        expect.objectContaining({ phase: 'ended', callSid: 'busy-call' }),
      );
      expect(adapter.snapshot()).toEqual(IDLE_CALL);
      expect(stop).toHaveBeenCalledOnce();
      expect(mediaError).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    ['NotAllowedError', 'media-permission-denied'],
    ['NotFoundError', 'media-device-not-found'],
  ] as const)(
    'returns to idle and permits retry after %s before call admission',
    async (name, step) => {
      const stop = vi.fn();
      const track = { kind: 'audio', stop, onended: null };
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(new DOMException('Media unavailable', name))
        .mockResolvedValueOnce({
          active: true,
          getTracks: () => [track],
          getVideoTracks: () => [],
        });
      vi.stubGlobal('navigator', {
        ...navigator,
        mediaDevices: { getUserMedia },
      });
      try {
        const post = vi
          .fn()
          .mockReturnValue(
            of({ code: BusinessCode.CALL_BUSY, message: 'busy', data: null }),
          );
        const notify = vi.fn();
        const adapter = new WebCallAdapter(
          { post } as unknown as HttpClient,
          IDLE_CALL,
          notify,
        );
        const snapshots: CallSnapshot[] = [];
        adapter.setSnapshotListener((snapshot) => snapshots.push(snapshot));

        adapter.initiate(12, 'failed-call', 'AUDIO', 'b', 0);
        await vi.waitFor(() => expect(snapshots).toHaveLength(1));

        expect(notify).toHaveBeenCalledWith(step);
        expect(post).not.toHaveBeenCalled();
        expect(adapter.snapshot()).toEqual(IDLE_CALL);
        expect(snapshots).toEqual([IDLE_CALL]);

        adapter.initiate(12, 'retry-call', 'AUDIO', 'b', 0);
        await vi.waitFor(() =>
          expect(snapshots.at(-1)?.terminalReason).toBe('busy'),
        );
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        expect(post).toHaveBeenCalledOnce();
        expect(snapshots).toContainEqual(
          expect.objectContaining({ phase: 'starting', callSid: 'retry-call' }),
        );
        expect(snapshots.at(-1)).toEqual(
          expect.objectContaining({
            phase: 'ended',
            callSid: 'retry-call',
            terminalReason: 'busy',
          }),
        );
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    ['NotAllowedError', 'before'],
    ['NotAllowedError', 'after'],
    ['NotFoundError', 'before'],
    ['NotFoundError', 'after'],
  ] as const)(
    'retries incoming media failure %s with setup received %s failure',
    async (name, timing) => {
      const track = { kind: 'audio', stop: vi.fn(), onended: null };
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(new DOMException('Media unavailable', name))
        .mockResolvedValueOnce({
          active: true,
          getTracks: () => [track],
          getVideoTracks: () => [],
        });
      vi.stubGlobal('navigator', {
        ...navigator,
        mediaDevices: { getUserMedia },
      });
      const post = vi
        .fn()
        .mockReturnValue(of({ code: 0, message: '', data: {} }));
      const adapter = new WebCallAdapter(
        { post } as unknown as HttpClient,
        IDLE_CALL,
      );
      const snapshots: CallSnapshot[] = [];
      adapter.setSnapshotListener((snapshot) => snapshots.push(snapshot));
      const pc = {
        signalingState: 'stable',
        remoteDescription: null as RTCSessionDescriptionInit | null,
        setRemoteDescription: vi.fn(
          async (description: RTCSessionDescriptionInit) => {
            pc.remoteDescription = description;
          },
        ),
        createAnswer: vi.fn().mockResolvedValue({ sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      Object.assign(adapter, {
        createPeerConnection: async () => {
          Object.assign(adapter, { pc });
        },
      });
      const offer = {
        id: 'retry-offer',
        callSid: 'incoming-retry',
        fromUserId: 7,
        kind: 'offer' as const,
        payload: audioSdp,
      };
      const ice = {
        id: 'retry-ice',
        callSid: 'incoming-retry',
        fromUserId: 7,
        kind: 'ice' as const,
        payload:
          '{"candidate":"candidate:fixture","usernameFragment":"remote1","sdpMid":"0"}',
      };
      const receiveSetup = async () => {
        await adapter.handleSignal(offer);
        await adapter.handleSignal(ice);
      };
      try {
        await adapter.onIncoming({
          ...IDLE_CALL,
          phase: 'incoming',
          callSid: 'incoming-retry',
        });
        if (timing === 'before') await receiveSetup();
        post.mockClear();
        adapter.accept('incoming-retry');
        await vi.waitFor(() =>
          expect(adapter.snapshot().step).toMatch(/^media-/),
        );
        expect(adapter.snapshot().phase).toBe('incoming');
        expect(post).not.toHaveBeenCalled();
        if (timing === 'after') await receiveSetup();

        adapter.accept('incoming-retry');
        expect(adapter.snapshot().step).toBe('');
        await vi.waitFor(() => expect(pc.createAnswer).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(adapter.snapshot().step).toBe('answer-sent'),
        );
        expect(pc.setRemoteDescription).toHaveBeenCalledWith({
          type: 'offer',
          sdp: audioSdp,
        });
        expect(pc.addIceCandidate).toHaveBeenCalledWith({
          candidate: 'candidate:fixture',
          usernameFragment: 'remote1',
          sdpMid: '0',
        });
        expect(post).toHaveBeenCalledWith(
          expect.stringMatching(/\/calls\/signal$/),
          expect.objectContaining({
            kind: 'answer',
            payload: 'answer-sdp',
            inReplyTo: 'retry-offer',
          }),
          expect.anything(),
        );
        await receiveSetup();
        expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
        expect(pc.addIceCandidate).toHaveBeenCalledOnce();
        expect(adapter.snapshot().phase).toBe('connecting');
      } finally {
        window.dispatchEvent(new Event('soms-call-session-ending'));
        vi.unstubAllGlobals();
      }
    },
  );

  it('unwraps the backend RTC configuration before constructing a peer connection', () => {
    expect(
      iceServersFromResponse({
        iceServers: [
          { urls: 'stun:stun.example.test:3478' },
          {
            urls: ['turn:turn.example.test:3478'],
            username: 'user',
            credential: 'secret',
          },
        ],
      }),
    ).toEqual([
      { urls: 'stun:stun.example.test:3478' },
      {
        urls: ['turn:turn.example.test:3478'],
        username: 'user',
        credential: 'secret',
      },
    ]);
  });

  it('dismisses this renderer when a sibling device accepts the incoming call', async () => {
    const http = {
      post: () => of({ code: 0, message: '' }),
    } as unknown as HttpClient;
    const adapter = new WebCallAdapter(http, IDLE_CALL);
    const snapshots: CallSnapshot[] = [];
    adapter.setSnapshotListener((snapshot) => snapshots.push(snapshot));
    const incoming: CallSnapshot = {
      ...IDLE_CALL,
      phase: 'incoming',
      callSid: 'call-1',
      peerUserId: 7,
    };
    await adapter.onIncoming(incoming);

    adapter.applyLifecycle({ ...incoming, phase: 'connecting' });

    expect(snapshots.at(-1)?.phase).toBe('ended');
    expect(adapter.snapshot().phase).toBe('idle');
  });

  it('gives the caller one ICE restart before failing the call', () => {
    expect(webReconnectDecision(true, false)).toEqual({
      delayMs: 15000,
      action: 'restart',
    });
    expect(webReconnectDecision(true, true)).toEqual({
      delayMs: 10000,
      action: 'fail',
    });
  });

  it('applies the first endpoint delivery of a signal ID only once', async () => {
    const adapter = new WebCallAdapter(
      { post: () => of({ code: 0, message: '' }) } as unknown as HttpClient,
      IDLE_CALL,
    );
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-1',
      callType: 'VIDEO',
    });
    await adapter.handleSignal({
      id: 'signal-1',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'video-state',
      payload: '{"enabled":true}',
    });
    await adapter.handleSignal({
      id: 'signal-1',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'video-state',
      payload: '{"enabled":false}',
    });

    expect(adapter.snapshot().remoteCameraEnabled).toBe(true);
  });

  it('ignores malformed or non-closed video-state payloads', async () => {
    const adapter = new WebCallAdapter(
      { post: () => of({ code: 0, message: '' }) } as unknown as HttpClient,
      IDLE_CALL,
    );
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-1',
      callType: 'VIDEO',
      remoteCameraEnabled: true,
    });

    await adapter.handleSignal({
      id: 'bad-json',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'video-state',
      payload: '{',
    });
    await adapter.handleSignal({
      id: 'bad-shape',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'video-state',
      payload: '{"enabled":false,"extra":true}',
    });

    expect(adapter.snapshot().remoteCameraEnabled).toBe(true);
  });

  it.each(['calling', 'connected', 'reconnecting'] as const)(
    'handles an answer without regressing the %s phase',
    async (phase) => {
      const adapter = new WebCallAdapter(
        { post: () => of({ code: 0, message: '' }) } as unknown as HttpClient,
        IDLE_CALL,
      );
      adapter.applyLifecycle({
        ...IDLE_CALL,
        callSid: 'answer-call',
        phase,
        startedAt: phase === 'calling' ? 0 : 1234,
        isCaller: true,
      });
      const pc = answeringPc();
      const setRemoteDescription = pc.setRemoteDescription;
      Object.assign(adapter, { pc, negotiation: activeLane() });

      await adapter.handleSignal({
        id: 'answer-1',
        inReplyTo: 'local-offer',
        callSid: 'answer-call',
        fromUserId: 7,
        kind: 'answer',
        payload: 'answer-sdp',
      });

      expect(setRemoteDescription).toHaveBeenCalledOnce();
      expect(adapter.snapshot()).toEqual(
        expect.objectContaining({
          phase: phase === 'calling' ? 'connecting' : phase,
          startedAt: phase === 'calling' ? 0 : 1234,
          step: phase === 'connected' ? '' : 'answer-received',
        }),
      );
    },
  );

  it.each([false])(
    'clears camera renegotiation progress on a connected video callee (caller=%s)',
    async (isCaller) => {
      const post = vi.fn().mockReturnValue(of({ code: 0, message: '' }));
      const adapter = new WebCallAdapter(
        { post } as unknown as HttpClient,
        IDLE_CALL,
      );
      adapter.applyLifecycle({
        ...IDLE_CALL,
        phase: 'connected',
        callSid: 'video-call',
        callType: 'VIDEO',
        isCaller,
        startedAt: 1234,
        videoUpgradeState: 'upgrading',
      });
      const pc = answeringPc();
      pc.signalingState = 'stable';
      Object.assign(adapter, { pc });

      await adapter.handleSignal({
        id: 'offer-1',
        callSid: 'video-call',
        fromUserId: 7,
        kind: 'offer',
        payload: 'offer-sdp',
      });

      expect(adapter.snapshot()).toEqual(
        expect.objectContaining({
          phase: 'connected',
          startedAt: 1234,
          step: '',
          videoUpgradeState: 'idle',
        }),
      );
      expect(post).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledWith(
        expect.stringMatching(/\/calls\/signal$/),
        expect.objectContaining({ kind: 'answer' }),
        expect.anything(),
      );
    },
  );

  it('completes a caller-led audio-to-video upgrade without losing connected duration', async () => {
    const post = vi.fn().mockReturnValue(of({ code: 0, message: '' }));
    const adapter = new WebCallAdapter(
      { post } as unknown as HttpClient,
      IDLE_CALL,
    );
    adapter.applyLifecycle({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'upgrade-call',
      isCaller: true,
      startedAt: 1234,
      videoUpgradeState: 'upgrading',
    });
    Object.assign(adapter, {
      pc: answeringPc(videoSdp),
      negotiation: activeLane(true),
    });

    await adapter.handleSignal({
      id: 'upgrade-answer',
      inReplyTo: 'local-offer',
      callSid: 'upgrade-call',
      fromUserId: 7,
      kind: 'answer',
      payload: videoSdp,
    });

    expect(adapter.snapshot()).toEqual(
      expect.objectContaining({
        phase: 'connected',
        startedAt: 1234,
        callType: 'VIDEO',
        step: '',
        videoUpgradeState: 'idle',
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/calls\/upgrade-video$/),
      { callSid: 'upgrade-call' },
      expect.anything(),
    );
  });

  it('lets the callee wait for the caller-owned ICE restart', () => {
    expect(webReconnectDecision(false, false)).toEqual({
      delayMs: 30000,
      action: 'fail',
    });
  });

  it('classifies browser media failures into actionable UI states', () => {
    expect(callMediaErrorStep({ name: 'NotAllowedError' })).toBe(
      'media-permission-denied',
    );
    expect(callMediaErrorStep({ name: 'NotFoundError' })).toBe(
      'media-device-not-found',
    );
    expect(callMediaErrorStep({ name: 'NotReadableError' })).toBe(
      'media-device-busy',
    );
    expect(callMediaErrorStep(new Error('unknown'))).toBe('media-failed');
  });

  it('ends on microphone loss but keeps audio alive when only the camera is lost', () => {
    expect(localTrackEndAction('audio')).toBe('end-call');
    expect(localTrackEndAction('video')).toBe('disable-video');
  });

  it('ends an active renderer-owned call before the session credential is cleared', async () => {
    const post = vi
      .fn()
      .mockName('post')
      .mockReturnValue(of({ code: 0, message: '' }));
    const adapter = new WebCallAdapter(
      { post } as unknown as HttpClient,
      IDLE_CALL,
    );
    await adapter.onIncoming({
      ...IDLE_CALL,
      phase: 'incoming',
      callSid: 'call-session-exit',
      peerUserId: 7,
    });
    post.mockClear();

    window.dispatchEvent(new Event('soms-call-session-ending'));

    expect(adapter.snapshot().phase).toBe('idle');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/calls\/end$/),
      {
        callSid: 'call-session-exit',
        endReason: 'completed',
      },
      {
        context: expect.any(HttpContext),
      },
    );
  });
});
