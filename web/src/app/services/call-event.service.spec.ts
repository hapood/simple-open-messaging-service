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
    setSnapshotListener: jasmine.createSpy('setSnapshotListener'),
    handleSignal: jasmine.createSpy('handleSignal'),
    onIncoming: jasmine.createSpy('onIncoming'),
    applyLifecycle: jasmine.createSpy('applyLifecycle'),
  };

  beforeEach(() => {
    events.observers.slice().forEach((observer) => observer.complete());
    Object.values(adapter)
      .filter((value) => jasmine.isSpy(value))
      .forEach((spy) => spy.calls.reset());
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

    expect(adapter.handleSignal).toHaveBeenCalledOnceWith(signal);
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
    expect(adapter.onIncoming).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({ callSid: 'call-2', peerUserId: 7 }),
    );
  });

  it('accepts renderer-owned snapshots without feeding them back into the adapter', () => {
    const service = TestBed.inject(CallEventService);
    const listener = adapter.setSnapshotListener.calls.mostRecent().args[0];

    listener({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-3',
      peerUserId: 9,
    });

    expect(service.callState().phase).toBe('connected');
    expect(adapter.applyLifecycle).not.toHaveBeenCalled();
  });
});
