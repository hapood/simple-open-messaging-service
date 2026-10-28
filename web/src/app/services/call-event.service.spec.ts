import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { CallAdapterService, IDLE_CALL } from './call-adapter';
import { CallEventService } from './call-event.service';
import { WebsocketService, type StandardMessage } from './websocket.service';

describe('CallEventService web call routing', () => {
  const events = new Subject<StandardMessage>();
  const adapter = {
    snapshot: () => ({ ...IDLE_CALL }),
    setSnapshotListener: vi.fn().mockName('setSnapshotListener'),
    handleSignal: vi.fn().mockName('handleSignal'),
    onIncoming: vi.fn().mockName('onIncoming'),
    applyLifecycle: vi.fn().mockName('applyLifecycle'),
  };

  beforeEach(() => {
    events.observers.slice().forEach((observer) => observer.complete());
    Object.values(adapter)
      .filter(
        (value): value is Mock =>
          typeof value === 'function' && vi.isMockFunction(value),
      )
      .forEach((spy) => spy.mockClear());
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        CallEventService,
        { provide: WebsocketService, useValue: { eventSubject: events } },
        { provide: CallAdapterService, useValue: adapter },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('normalizes an identity-less terminal snapshot to idle without terminal chrome', () => {
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];

    listener({ ...IDLE_CALL, phase: 'ended', terminalReason: 'failed' });

    expect(service.callState()).toEqual(IDLE_CALL);
    expect(adapter.applyLifecycle).not.toHaveBeenCalled();
  });

  it('routes CALL_SIGNAL frames to the selected media adapter', () => {
    TestBed.inject(CallEventService);
    const signal = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'offer',
      payload: 'offer-sdp',
    };

    events.next({
      event: 'CALL_SIGNAL',
      status: 200,
      message: '',
      data: signal,
    });

    expect(adapter.handleSignal).toHaveBeenCalledTimes(1);

    expect(adapter.handleSignal).toHaveBeenCalledWith(signal);
  });

  it('retains answer correlation in realtime delivery', () => {
    TestBed.inject(CallEventService);
    const answer = {
      id: 'answer-id',
      callSid: 'call-1',
      fromUserId: 7,
      kind: 'answer',
      payload: 'opaque-sdp',
      inReplyTo: 'offer-id',
    };
    events.next({
      event: 'CALL_SIGNAL',
      status: 200,
      message: '',
      data: answer,
    });
    expect(adapter.handleSignal).toHaveBeenCalledWith(answer);
  });

  it('ignores wrong-call video upgrades and absorbs late setup progress on connected calls', () => {
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];
    listener({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'owned',
      isCaller: true,
      startedAt: 1234,
    });
    const lifecycle = (type: string, callSid: string) =>
      events.next({
        event: 'CALL_EVENT',
        status: 200,
        message: '',
        data: { type, callSid },
      });
    lifecycle('video-upgraded', 'other');
    expect(service.callState().callType).toBe('AUDIO');
    lifecycle('accepted', 'owned');
    lifecycle('ringing', 'owned');
    expect(service.callState()).toMatchObject({
      phase: 'connected',
      startedAt: 1234,
    });
    lifecycle('video-upgraded', 'owned');
    expect(service.callState().callType).toBe('VIDEO');
  });

  it('seeds the incoming state and lets the web adapter acknowledge ringing', () => {
    const service = TestBed.inject(CallEventService);

    events.next({
      event: 'CALL_EVENT',
      status: 200,
      message: '',
      data: {
        type: 'incoming',
        callSid: 'call-2',
        threadId: 12,
        callerUserId: 7,
        callerName: 'Alice',
        callType: 'AUDIO',
      },
    });

    expect(service.callState().phase).toBe('incoming');
    expect(service.callState().peerName).toBe('Alice');
    expect(adapter.onIncoming).toHaveBeenCalledTimes(1);
    expect(adapter.onIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'call-2', peerUserId: 7 }),
    );
  });

  it('accepts renderer-owned snapshots without feeding them back into the adapter', () => {
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];

    listener({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-3',
      peerUserId: 9,
    });

    expect(service.callState().phase).toBe('connected');
    expect(adapter.applyLifecycle).not.toHaveBeenCalled();
  });

  it('ignores lifecycle events for a call this renderer does not own', () => {
    const service = TestBed.inject(CallEventService);

    events.next({
      event: 'CALL_EVENT',
      status: 200,
      message: '',
      data: { type: 'accepted', callSid: 'accepted-on-another-device' },
    });

    expect(service.callState().phase).toBe('idle');
    expect(adapter.applyLifecycle).not.toHaveBeenCalled();
  });

  it('holds a terminal result when an adapter reaches idle before SSE', () => {
    vi.useFakeTimers();
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];
    listener({ ...IDLE_CALL, phase: 'ringing', callSid: 'call-4' });
    listener({ ...IDLE_CALL });

    events.next({
      event: 'CALL_EVENT',
      status: 200,
      message: '',
      data: { type: 'declined', callSid: 'call-4' },
    });

    expect(service.callState().phase).toBe('ended');
    expect(service.callState().terminalReason).toBe('declined');
    vi.advanceTimersByTime(1399);
    expect(service.callState().phase).toBe('ended');
    vi.advanceTimersByTime(1);
    expect(service.callState()).toEqual({ ...IDLE_CALL });
    vi.useRealTimers();
  });

  it('briefly presents a locally initiated hang-up before returning to idle', () => {
    vi.useFakeTimers();
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];
    listener({ ...IDLE_CALL, phase: 'connected', callSid: 'call-local' });

    listener({
      ...IDLE_CALL,
      phase: 'ended',
      callSid: 'call-local',
      terminalReason: 'completed',
    });

    expect(service.callState().phase).toBe('ended');
    expect(service.callState().terminalReason).toBe('completed');
    vi.advanceTimersByTime(1400);
    expect(service.callState()).toEqual({ ...IDLE_CALL });
    vi.useRealTimers();
  });

  it('shows a web busy snapshot without a later completed terminal', () => {
    vi.useFakeTimers();
    try {
      const service = TestBed.inject(CallEventService);
      const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];
      listener({ ...IDLE_CALL, phase: 'starting', callSid: 'web-busy' });
      listener({
        ...IDLE_CALL,
        phase: 'ended',
        callSid: 'web-busy',
        terminalReason: 'busy',
      });
      // Cleanup or a late idle snapshot must not replace the busy terminal.
      listener({ ...IDLE_CALL });

      expect(service.callState().phase).toBe('ended');
      expect(service.callState().terminalReason).toBe('busy');
      vi.advanceTimersByTime(1800);
      expect(service.callState()).toEqual(IDLE_CALL);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['unreachable', 'failed', 'busy'] as const)(
    'preserves the Rust-owned %s reason through native cleanup',
    (terminalReason) => {
      vi.useFakeTimers();
      try {
        const service = TestBed.inject(CallEventService);
        window.__SOMS_CALL_EVENT__!({
          ...IDLE_CALL,
          phase: 'starting',
          callSid: 'native-call',
        });
        window.__SOMS_CALL_EVENT__!({
          ...IDLE_CALL,
          phase: 'ended',
          callSid: 'native-call',
          terminalReason,
        });
        window.__SOMS_CALL_EVENT__!({ ...IDLE_CALL });
        expect(service.callState()).toMatchObject({
          phase: 'ended',
          callSid: 'native-call',
          terminalReason,
        });
        const displayMs = terminalReason === 'busy' ? 1800 : 1400;
        vi.advanceTimersByTime(displayMs - 1);
        expect(service.callState().phase).toBe('ended');
        vi.advanceTimersByTime(1);
        expect(service.callState()).toEqual(IDLE_CALL);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
