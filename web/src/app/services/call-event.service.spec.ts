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
    rejected$: new Subject<'busy'>(),
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
    service.markLocalTermination('call-local');

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

  it('shows native busy rejection as a terminal call state', () => {
    vi.useFakeTimers();
    const service = TestBed.inject(CallEventService);
    const listener = vi.mocked(adapter.setSnapshotListener).mock.lastCall![0];
    listener({ ...IDLE_CALL, phase: 'ringing', callSid: 'call-5' });
    listener({ ...IDLE_CALL });
    adapter.rejected$.next('busy');

    expect(service.callState().phase).toBe('ended');
    expect(service.callState().terminalReason).toBe('busy');
    vi.advanceTimersByTime(1799);
    expect(service.callState().phase).toBe('ended');
    vi.advanceTimersByTime(1);
    expect(service.callState()).toEqual({ ...IDLE_CALL });
    vi.useRealTimers();
  });
});
