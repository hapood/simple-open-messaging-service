import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { AvatarRepository } from '../../services/avatar-cache.service';
import {
  IDLE_CALL,
  CallAdapterService,
  CallSnapshot,
} from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { CallRingtoneService } from '../../services/call-ringtone.service';
import { CallPresentationService } from '../../services/call-presentation.service';
import { CallScreenComponent } from './call-screen.component';
import { UserService } from '../../services/user.service';

describe('CallScreenComponent', () => {
  const callState = signal<CallSnapshot>({ ...IDLE_CALL });
  const adapter = {
    accept: jasmine.createSpy('accept'),
    decline: jasmine.createSpy('decline'),
    cancel: jasmine.createSpy('cancel'),
    end: jasmine.createSpy('end'),
    setMuted: jasmine.createSpy('setMuted'),
    setSpeakerEnabled: jasmine.createSpy('setSpeakerEnabled'),
    upgradeToVideo: jasmine.createSpy('upgradeToVideo'),
    switchCamera: jasmine.createSpy('switchCamera'),
    setCameraEnabled: jasmine.createSpy('setCameraEnabled'),
    setVideoRect: jasmine.createSpy('setVideoRect'),
    setVideoElements: jasmine.createSpy('setVideoElements'),
    setSelfVideoPosition: jasmine.createSpy('setSelfVideoPosition'),
    swapVideo: jasmine.createSpy('swapVideo'),
    rendererOwnsVideo: true,
  };
  const ringtone = { setMode: jasmine.createSpy('setMode') };
  const presentation = {
    minimized: signal(false),
    minimize: jasmine.createSpy('minimize'),
    restore: jasmine.createSpy('restore'),
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
    Object.values(adapter)
      .filter(
        (value): value is jasmine.Spy => typeof value === 'function',
      )
      .forEach((spy) => spy.calls.reset());
    ringtone.setMode.calls.reset();
    presentation.minimized.set(false);
    presentation.minimize.calls.reset();
    presentation.restore.calls.reset();

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
        {
          provide: CallEventService,
          useValue: {
            callState,
            markLocalTermination: jasmine.createSpy('markLocalTermination'),
          },
        },
        { provide: CallAdapterService, useValue: adapter },
        { provide: CallRingtoneService, useValue: ringtone },
        { provide: CallPresentationService, useValue: presentation },
        { provide: UserService, useValue: { sessionProfile: signal(undefined) } },
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

  it('maps incoming and ringing phases to distinct call tones', () => {
    callState.update((state) => ({ ...state, phase: 'incoming' }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();
    expect(ringtone.setMode).toHaveBeenCalledWith('incoming');

    callState.update((state) => ({ ...state, phase: 'ringing' }));
    fixture.detectChanges();
    expect(ringtone.setMode).toHaveBeenCalledWith('ringback');

    callState.update((state) => ({ ...state, phase: 'connecting' }));
    fixture.detectChanges();
    expect(ringtone.setMode).toHaveBeenCalledWith(null);

    callState.update((state) => ({
      ...state,
      phase: 'ended',
      terminalReason: 'busy',
    }));
    fixture.detectChanges();
    expect(ringtone.setMode).toHaveBeenCalledWith('busy');
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.status')
        ?.textContent?.trim(),
    ).toBe('The other side is busy');
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.call-action')
        .length,
    ).toBe(0);
    fixture.destroy();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('offers a one-way video upgrade from a connected audio call', () => {
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.call-kind')?.textContent?.trim()).toBe(
      'Audio call',
    );
    expect(root.querySelectorAll('.call-action').length).toBe(3);

    (root.querySelector('.upgrade') as HTMLButtonElement).click();
    expect(adapter.upgradeToVideo).toHaveBeenCalledTimes(1);

    (root.querySelector('.end') as HTMLButtonElement).click();
    expect(adapter.end).toHaveBeenCalledOnceWith('call-1', 'completed');
    fixture.destroy();
  });

  it('uses the same control shell for video with camera actions', () => {
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: true,
      remoteCameraEnabled: true,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.call-kind')?.textContent?.trim()).toBe(
      'Video call',
    );
    expect(root.querySelectorAll('.call-action').length).toBe(4);
    expect(root.querySelector('.upgrade')).toBeNull();
    expect(root.querySelectorAll('video').length).toBe(2);
    expect(root.querySelectorAll('.call-action app-icon svg').length).toBe(4);
    expect(root.querySelector('mat-icon')).toBeNull();
    expect(root.querySelector('.remote-camera-off')?.textContent).toContain(
      'Waiting for video…',
    );

    fixture.componentInstance.onRemoteVideoReady();
    fixture.detectChanges();
    expect(root.querySelector('.remote-camera-off')).toBeNull();

    (root.querySelector('.switch') as HTMLButtonElement).click();
    expect(adapter.switchCamera).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('keeps video controls visible while the mouse is moving', () => {
    jasmine.clock().install();
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: true,
      remoteCameraEnabled: true,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    jasmine.clock().tick(2999);
    expect(component.controlsVisible()).toBeTrue();

    component.onScreenMouseMove();
    jasmine.clock().tick(2999);
    expect(component.controlsVisible()).toBeTrue();

    jasmine.clock().tick(1);
    expect(component.controlsVisible()).toBeFalse();
    fixture.destroy();
    jasmine.clock().uninstall();
  });

  it('moves the self view through the lightweight position bridge while dragging', () => {
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: true,
      remoteCameraEnabled: true,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const startLeft = component.selfLeft();
    const startTop = component.selfTop();
    let animationFrame: FrameRequestCallback | undefined;
    spyOn(window, 'requestAnimationFrame').and.callFake((callback) => {
      animationFrame = callback;
      return 1;
    });

    component.onSelfPointerDown({
      stopPropagation: () => undefined,
      clientX: 10,
      clientY: 20,
      pointerId: 1,
      currentTarget: { setPointerCapture: () => undefined },
    } as unknown as PointerEvent);
    component.onSelfPointerMove({
      clientX: 30,
      clientY: 50,
    } as PointerEvent);
    animationFrame?.(0);

    const expectedLeft = Math.min(startLeft + 20, window.innerWidth - 120);
    const expectedTop = Math.min(startTop + 30, window.innerHeight - 160);
    expect(adapter.setSelfVideoPosition).toHaveBeenCalledOnceWith(
      expectedLeft,
      expectedTop,
    );
    expect(component.selfTransform()).toBe(
      `translate3d(${expectedLeft}px, ${expectedTop}px, 0)`,
    );
    fixture.destroy();
  });

  it('keeps video mode while the local and remote cameras are off', () => {
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: false,
      remoteCameraEnabled: false,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.remote-camera-off')?.textContent).toContain(
      `Alice's camera is off`,
    );
    expect(root.querySelector('.self-view.off')).not.toBeNull();
    expect(
      (root.querySelector('.switch') as HTMLButtonElement).disabled,
    ).toBeTrue();

    (root.querySelector('.cam') as HTMLButtonElement).click();
    expect(adapter.setCameraEnabled).toHaveBeenCalledOnceWith(true);
    expect(root.querySelector('.call-kind')?.textContent?.trim()).toBe(
      'Video call',
    );
    fixture.destroy();
  });

  it('moves camera-off placeholders with the native video swap state', () => {
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: false,
      remoteCameraEnabled: false,
      swapped: true,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.call-screen.swapped')).not.toBeNull();
    expect(root.querySelector('.local-camera-off')?.textContent).toContain(
      'Camera off',
    );
    expect(root.querySelector('.self-view .pip-peer-off')).not.toBeNull();
    expect(root.querySelector('.self-view .self-off')).toBeNull();
    fixture.destroy();
  });

  it('disables duplicate upgrade requests while renegotiation is running', () => {
    callState.update((state) => ({ ...state, videoUpgradeState: 'upgrading' }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const upgrade = root.querySelector('.upgrade') as HTMLButtonElement;
    expect(upgrade.disabled).toBeTrue();
    expect(root.querySelector('.status')?.textContent?.trim()).toBe(
      'Starting video…',
    );
    upgrade.click();
    expect(adapter.upgradeToVideo).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('prioritizes reconnecting over stale signaling detail', () => {
    callState.update((state) => ({
      ...state,
      phase: 'reconnecting',
      step: 'offer-sent',
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.status')
        ?.textContent?.trim(),
    ).toBe('Reconnecting…');
    fixture.destroy();
  });

  it('minimizes the call from the independent top control', () => {
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.minimize',
    ) as HTMLButtonElement;
    button.click();

    expect(presentation.minimize).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

});
