import { HttpClient, HttpContext } from '@angular/common/http';
import { of } from 'rxjs';
import { IDLE_CALL, type CallSnapshot } from './call-adapter';
import { BusinessCode } from './biz-code';
import {
  WebCallAdapter,
  callMediaErrorStep,
  iceServersFromResponse,
  localTrackEndAction,
  webReconnectDecision,
} from './web-call.adapter';

describe('WebCallAdapter multi-device ownership', () => {
  it('ends a server-rejected outgoing call as busy and releases the microphone', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', stop, onended: null };
    const getUserMedia = vi.fn().mockResolvedValue({
      active: true,
      getTracks: () => [track],
      getVideoTracks: () => [],
    });
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    try {
      const post = vi.fn().mockReturnValue(
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

      adapter.initiate(12, 'busy-call', 'AUDIO', 'B', '');
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
