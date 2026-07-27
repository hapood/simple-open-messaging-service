import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { IDLE_CALL, CallAdapterService, CallSnapshot } from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { CallScreenComponent } from './call-screen.component';

describe('CallScreenComponent', () => {
  const callState = signal<CallSnapshot>({ ...IDLE_CALL });
  const adapter = {
    accept: jasmine.createSpy('accept'),
    decline: jasmine.createSpy('decline'),
    cancel: jasmine.createSpy('cancel'),
    end: jasmine.createSpy('end'),
    setMuted: jasmine.createSpy('setMuted'),
    switchCamera: jasmine.createSpy('switchCamera'),
    setCameraEnabled: jasmine.createSpy('setCameraEnabled'),
    setVideoRect: jasmine.createSpy('setVideoRect'),
    swapVideo: jasmine.createSpy('swapVideo'),
  };

  beforeEach(() => {
    callState.set({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-1',
      peerUserId: 7,
      peerName: 'Alice',
      startedAt: Date.now(),
    });
    Object.values(adapter).forEach((spy) => spy.calls.reset());

    TestBed.configureTestingModule({
      imports: [CallScreenComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        { provide: CallEventService, useValue: { callState } },
        { provide: CallAdapterService, useValue: adapter },
        {
          provide: AvatarRepository,
          useValue: {
            refreshTick: () => 0,
            getBlob: () => Promise.resolve(undefined),
          },
        },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('renders the shared audio-call controls and hangs up', () => {
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.call-kind')?.textContent?.trim()).toBe('Audio call');
    expect(root.querySelectorAll('.call-action').length).toBe(2);

    (root.querySelector('.end') as HTMLButtonElement).click();
    expect(adapter.end).toHaveBeenCalledOnceWith('call-1', 'completed');
    fixture.destroy();
  });

  it('uses the same control shell for video with camera actions', () => {
    callState.update((state) => ({ ...state, callType: 'VIDEO' }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.call-kind')?.textContent?.trim()).toBe('Video call');
    expect(root.querySelectorAll('.call-action').length).toBe(4);

    (root.querySelector('.switch') as HTMLButtonElement).click();
    expect(adapter.switchCamera).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });
});
