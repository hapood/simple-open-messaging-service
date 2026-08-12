import { HttpClient, HttpContext } from '@angular/common/http';
import { of } from 'rxjs';
import { IDLE_CALL, type CallSnapshot } from './call-adapter';
import {
  WebCallAdapter,
  callMediaErrorStep,
  iceServersFromResponse,
  localTrackEndAction,
  webReconnectDecision,
} from './web-call.adapter';

describe('WebCallAdapter multi-device ownership', () => {
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
      delayMs: 15_000,
      action: 'restart',
    });
    expect(webReconnectDecision(true, true)).toEqual({
      delayMs: 10_000,
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

    expect(adapter.snapshot().remoteCameraEnabled).toBeTrue();
  });

  it('lets the callee wait for the caller-owned ICE restart', () => {
    expect(webReconnectDecision(false, false)).toEqual({
      delayMs: 30_000,
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
    const post = jasmine
      .createSpy('post')
      .and.returnValue(of({ code: 0, message: '' }));
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
    post.calls.reset();

    window.dispatchEvent(new Event('soms-call-session-ending'));

    expect(adapter.snapshot().phase).toBe('idle');
    expect(post).toHaveBeenCalledOnceWith(
      jasmine.stringMatching(/\/calls\/end$/),
      {
        callSid: 'call-session-exit',
        endReason: 'completed',
      },
      {
        context: jasmine.any(HttpContext),
      },
    );
  });
});
