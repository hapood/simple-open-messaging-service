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
import { CallScreenComponent } from './call-screen.component';

describe('CallScreenComponent', () => {
  const callState = signal<CallSnapshot>({ ...IDLE_CALL });
  const adapter = {
    accept: jasmine.createSpy('accept'),
    decline: jasmine.createSpy('decline'),
    cancel: jasmine.createSpy('cancel'),
    end: jasmine.createSpy('end'),
    setMuted: jasmine.createSpy('setMuted'),
    upgradeToVideo: jasmine.createSpy('upgradeToVideo'),
    switchCamera: jasmine.createSpy('switchCamera'),
    setCameraEnabled: jasmine.createSpy('setCameraEnabled'),
    setVideoRect: jasmine.createSpy('setVideoRect'),
    setVideoElements: jasmine.createSpy('setVideoElements'),
    setSelfVideoPosition: jasmine.createSpy('setSelfVideoPosition'),
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

    (root.querySelector('.switch') as HTMLButtonElement).click();
    expect(adapter.switchCamera).toHaveBeenCalledTimes(1);
    fixture.destroy();
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
});
