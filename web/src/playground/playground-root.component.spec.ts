import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { CallBannerComponent } from '../app/components/call-banner/call-banner.component';
import { AvatarRepository } from '../app/services/avatar-cache.service';
import { CallAdapterService, IDLE_CALL } from '../app/services/call-adapter';
import { CallEventService } from '../app/services/call-event.service';
import { CallPresentationService } from '../app/services/call-presentation.service';
import { InlineTranslocoLoader } from '../app/i18n/transloco.loader';
import { UserService } from '../app/services/user.service';
import { PlaygroundCallState } from './playground-call.mock';
import { PlaygroundRootComponent } from './playground-root.component';

@Component({ selector: 'app-call-screen', template: 'Call screen' })
class TestCallScreenComponent {}

@Component({
  selector: 'app-playground-shell',
  imports: [CallBannerComponent],
  template: '<app-call-banner />',
})
class TestPlaygroundShellComponent {}

describe('PlaygroundRootComponent', () => {
  let fixture: ComponentFixture<PlaygroundRootComponent>;
  let callState: PlaygroundCallState;
  let presentation: CallPresentationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PlaygroundRootComponent],
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
        { provide: CallEventService, useExisting: PlaygroundCallState },
        {
          provide: CallAdapterService,
          useValue: {
            accept: jasmine.createSpy('accept'),
            decline: jasmine.createSpy('decline'),
            cancel: jasmine.createSpy('cancel'),
            end: jasmine.createSpy('end'),
          },
        },
        {
          provide: UserService,
          useValue: { sessionProfile: signal(undefined) },
        },
        {
          provide: AvatarRepository,
          useValue: {
            refreshTick: () => 0,
            getBlob: () => Promise.resolve(undefined),
          },
        },
      ],
    });
    TestBed.overrideComponent(PlaygroundRootComponent, {
      set: {
        imports: [TestCallScreenComponent, TestPlaygroundShellComponent],
      },
    });

    callState = TestBed.inject(PlaygroundCallState);
    presentation = TestBed.inject(CallPresentationService);
    fixture = TestBed.createComponent(PlaygroundRootComponent);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('unmounts an active call when minimized and restores it from the call banner', () => {
    callState.callState.set({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'playground-call',
      threadId: 1,
      peerUserId: 2,
      peerName: 'Alice',
      startedAt: Date.now(),
    });
    fixture.detectChanges();

    expect(query('app-call-screen')).not.toBeNull();
    expect(query('app-call-banner')).not.toBeNull();
    expect(query('.call-banner')).toBeNull();

    presentation.minimize();
    fixture.detectChanges();

    expect(query('app-call-screen')).toBeNull();
    const returnToCall = query<HTMLButtonElement>('.call-summary');
    expect(returnToCall).not.toBeNull();
    expect(returnToCall?.getAttribute('aria-label')).toBe('Return to call');

    returnToCall?.click();
    fixture.detectChanges();

    expect(presentation.minimized()).toBeFalse();
    expect(query('app-call-screen')).not.toBeNull();
    expect(query('.call-banner')).toBeNull();
  });

  it('never mounts the call screen while the call is idle', () => {
    fixture.detectChanges();
    expect(query('app-call-screen')).toBeNull();

    presentation.minimize();
    fixture.detectChanges();
    expect(query('app-call-screen')).toBeNull();

    presentation.restore();
    fixture.detectChanges();
    expect(query('app-call-screen')).toBeNull();
  });

  function query<T extends Element = HTMLElement>(selector: string): T | null {
    return fixture.nativeElement.querySelector(selector) as T | null;
  }
});
