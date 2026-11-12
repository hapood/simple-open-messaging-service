import type { Mock } from 'vitest';
import { Subject, of } from 'rxjs';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  IDLE_CALL,
  CallAdapterService,
  CallSnapshot,
} from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { CallRingtoneService } from '../../services/call-ringtone.service';
import { CallPresentationService } from '../../services/call-presentation.service';
import { CallScreenComponent } from './call-screen.component';
import { CallBannerComponent } from '../call-banner/call-banner.component';
import { By } from '@angular/platform-browser';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { UserService } from '../../services/user.service';
import { WebdbService, WebdbStorage } from '../../services/webdb.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { ConversationListService } from '../../services/conversation-list.service';
import type {
  ConversationItem,
  P2PConversationItem,
} from '../../services/model';
import { createP2PConversation } from '../../services/model';

describe('CallScreenComponent', () => {
  const callState = signal<CallSnapshot>({ ...IDLE_CALL });
  const conversations = signal<ConversationItem[]>([]);
  const adapter = {
    accept: vi.fn().mockName('accept'),
    decline: vi.fn().mockName('decline'),
    cancel: vi.fn().mockName('cancel'),
    end: vi.fn().mockName('end'),
    setMuted: vi.fn().mockName('setMuted'),
    setSpeakerEnabled: vi.fn().mockName('setSpeakerEnabled'),
    upgradeToVideo: vi.fn().mockName('upgradeToVideo'),
    switchCamera: vi.fn().mockName('switchCamera'),
    setCameraEnabled: vi.fn().mockName('setCameraEnabled'),
    setVideoRect: vi.fn().mockName('setVideoRect'),
    setVideoElements: vi.fn().mockName('setVideoElements'),
    setSelfVideoPosition: vi.fn().mockName('setSelfVideoPosition'),
    swapVideo: vi.fn().mockName('swapVideo'),
    rendererOwnsVideo: true,
  };
  const ringtone = { setMode: vi.fn().mockName('setMode') };
  const presentation = {
    minimized: signal(false),
    minimize: vi.fn().mockName('minimize'),
    restore: vi.fn().mockName('restore'),
  };

  beforeEach(() => {
    conversations.set([]);
    callState.set({
      ...IDLE_CALL,
      phase: 'connected',
      callSid: 'call-1',
      peerUserId: 7,
      peerName: 'Alice',
      startedAt: Date.now(),
    });
    Object.values(adapter)
      .filter((value): value is Mock => typeof value === 'function')
      .forEach((spy) => spy.mockClear());
    ringtone.setMode.mockClear();
    presentation.minimized.set(false);
    presentation.minimize.mockClear();
    presentation.restore.mockClear();

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
          },
        },
        { provide: CallAdapterService, useValue: adapter },
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
        { provide: CallRingtoneService, useValue: ringtone },
        { provide: CallPresentationService, useValue: presentation },
        {
          provide: WebdbService,
          useFactory: () =>
            new WebdbStorage(
              () => null,
              new SessionLifecycleService(),
            ) as WebdbService,
        },
        {
          provide: UserService,
          useValue: {
            sessionProfile: signal(undefined),
            sessionUserId: signal(null),
          },
        },
      ],
    });
  });

  it('uses common Web conversation presentation, not native snapshot strings', () => {
    const thread = createP2PConversation({
      threadId: 4,
      account: 'bob',
      publisherNamespaceId: 2,
      profileRev: 7,
      alias: 'Local alias',
      profile: { name: 'Bob', bio: '', avatarDigest: null },
    });
    conversations.set([thread]);
    callState.update((state) => ({
      ...state,
      threadId: 4,
      peerName: 'Native name',
      peerAvatar: 'native-avatar',
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    const component = fixture.componentInstance;
    expect(component.peerName()).toBe('Local alias');
    expect(component).not.toHaveProperty('peerAvatar');
    expect(component.peerProfile()).toEqual({
      account: 'bob',
      publisherNamespaceId: 2,
      profileNamespaceId: 0,
      rev: 7,
      linked: true,
    });
    conversations.set([{ ...thread, alias: null } as ConversationItem]);
    expect(component.peerName()).toBe('Bob');
    conversations.set([]);
    expect(component.peerName()).toBe('');
    expect(component.peerProfile()).toBeUndefined();
    fixture.destroy();
  });

  for (const componentType of [CallScreenComponent, CallBannerComponent]) {
    it(`${componentType.name} consumes the shared demand and refreshed conversation presentation`, async () => {
      const updates = new Subject<ResolvedProfile>();
      const resolve = vi.fn(() => updates);
      TestBed.overrideProvider(ProfileRepository, { useValue: { resolve } });
      TestBed.overrideProvider(ProfileNamespaceRepository, {
        useValue: {
          resolve: vi.fn(() => of({ domain: 'remote.test', status: 'ACTIVE' })),
        },
      });
      const createImage = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValue('blob:call-profile');
      const revokeImage = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {});
      const seed = createP2PConversation({
        threadId: 4,
        account: 'bob',
        publisherNamespaceId: 2,
        profileRev: 7,
      });
      const thread: P2PConversationItem = {
        ...seed,
        profile: { ...seed.profile, name: 'bob' },
      };
      const refreshed: P2PConversationItem = {
        ...thread,
        profile: { ...thread.profile, name: 'Selected Bob' },
      };
      const aliased: P2PConversationItem = { ...thread, alias: 'Local alias' };
      const selectedProfile: ResolvedProfile = {
        publisherNamespaceId: 2,
        namespaceId: 0,
        account: 'bob',
        rev: 7,
        name: 'Selected Bob',
        bio: '',
        avatarDigest: 'b'.repeat(64),
        avatarBlob: new Blob(['profile']),
      };
      conversations.set([thread]);
      presentation.minimized.set(componentType === CallBannerComponent);
      callState.update((state) => ({
        ...state,
        phase: 'incoming',
        threadId: 4,
        peerName: 'Transport name',
        peerAvatar: 'data:image/png;base64,dHJhbnNwb3J0',
      }));
      const fixture = TestBed.createComponent<
        CallScreenComponent | CallBannerComponent
      >(componentType);
      try {
        fixture.detectChanges();
        await fixture.whenStable();
        const avatar = fixture.debugElement.query(
          By.directive(DemandAvatarComponent),
        ).componentInstance as DemandAvatarComponent;
        expect(resolve).toHaveBeenCalledWith({
          publisherNamespaceId: 2,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'bob', profileNamespaceId: 0, rev: 7 },
        });
        expect(avatar.view().imageUrl).toBeNull();
        expect(fixture.componentInstance.peerName()).toBe('bob');

        updates.next(selectedProfile);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(avatar.view().imageUrl).toBe('blob:call-profile');
        expect(avatar.view().name).toBe('Selected Bob');

        // The thread repository publishes the same selected profile's display fields.
        conversations.set([refreshed]);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.peerName()).toBe('Selected Bob');
        expect((fixture.nativeElement as HTMLElement).textContent).toContain(
          'Selected Bob',
        );
        expect(
          (fixture.nativeElement as HTMLElement).textContent,
        ).not.toContain('Transport name');
        // A new presentation source re-resolves; the same shared demand delivers it.
        updates.next(selectedProfile);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(avatar.view().imageUrl).toBe('blob:call-profile');

        conversations.set([aliased]);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.peerName()).toBe('Local alias');
        updates.next(selectedProfile);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(avatar.view().imageUrl).toBe('blob:call-profile');
      } finally {
        fixture.destroy();
        expect(updates.observed).toBe(false);
        expect(revokeImage).toHaveBeenCalledWith('blob:call-profile');
        createImage.mockRestore();
        revokeImage.mockRestore();
      }
    });
  }

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

  it.each([
    ['unreachable', 0, "Couldn't connect. Please try again later"],
    ['failed', 0, 'Call connection failed'],
    ['failed', 1000, 'The call disconnected unexpectedly'],
  ] as const)(
    'renders %s with connection start %s accurately',
    (terminalReason, startedAt, text) => {
      callState.update((state) => ({
        ...state,
        phase: 'ended',
        terminalReason,
        startedAt,
      }));
      const fixture = TestBed.createComponent(CallScreenComponent);
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement)
          .querySelector('.status')
          ?.textContent?.trim(),
      ).toBe(text);
      expect(ringtone.setMode).toHaveBeenCalledWith('ended');
      fixture.destroy();
    },
  );

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
    expect(adapter.end).toHaveBeenCalledTimes(1);
    expect(adapter.end).toHaveBeenCalledWith('call-1', 'completed');
    fixture.destroy();
  });

  it('uses the same control shell for video with camera actions', () => {
    let frameReady!: VideoFrameRequestCallback;
    vi.spyOn(
      HTMLVideoElement.prototype,
      'requestVideoFrameCallback',
    ).mockImplementation((callback) => {
      frameReady = callback;
      return 1;
    });
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

    frameReady(0, {} as VideoFrameCallbackMetadata);
    fixture.detectChanges();
    expect(root.querySelector('.remote-camera-off')).toBeNull();

    (root.querySelector('.switch') as HTMLButtonElement).click();
    expect(adapter.switchCamera).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('waits for a new video frame after camera resume and cancels stale callbacks', () => {
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextId = 0;
    const request = vi.fn((callback: VideoFrameRequestCallback) => {
      callbacks.set(++nextId, callback);
      return nextId;
    });
    const cancel = vi.fn();
    const prototype = HTMLVideoElement.prototype;
    const originalRequest = Object.getOwnPropertyDescriptor(
      prototype,
      'requestVideoFrameCallback',
    );
    const originalCancel = Object.getOwnPropertyDescriptor(
      prototype,
      'cancelVideoFrameCallback',
    );
    Object.defineProperty(prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: request,
    });
    Object.defineProperty(prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      value: cancel,
    });
    const fire = (id: number) =>
      callbacks.get(id)!(0, {} as VideoFrameCallbackMetadata);
    const fixture = TestBed.createComponent(CallScreenComponent);
    try {
      callState.update((state) => ({
        ...state,
        callType: 'VIDEO',
        remoteCameraEnabled: true,
      }));
      fixture.detectChanges();
      const component = fixture.componentInstance;
      const first = nextId;
      expect(first).toBeGreaterThan(0);
      component.onRemoteVideoReady();
      expect(component.remoteVideoReady()).toBe(false);
      fire(first);
      expect(component.remoteVideoReady()).toBe(true);

      callState.update((state) => ({ ...state, remoteCameraEnabled: false }));
      fixture.detectChanges();
      expect(component.remoteVideoReady()).toBe(false);
      expect(cancel).toHaveBeenCalledWith(first);
      fire(first);
      expect(component.remoteVideoReady()).toBe(false);

      callState.update((state) => ({ ...state, remoteCameraEnabled: true }));
      fixture.detectChanges();
      const resumed = nextId;
      expect(resumed).toBeGreaterThan(first);
      expect(component.remoteVideoReady()).toBe(false);
      fire(resumed);
      fixture.detectChanges();
      expect(component.remoteVideoReady()).toBe(true);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '.remote-camera-off',
        ),
      ).toBeNull();

      // Unrelated call updates must not invalidate an already presented frame.
      callState.update((state) => ({ ...state, muted: true }));
      fixture.detectChanges();
      expect(nextId).toBe(resumed);
      expect(component.remoteVideoReady()).toBe(true);

      callState.update((state) => ({ ...state, callSid: 'replacement-call' }));
      fixture.detectChanges();
      const replacement = nextId;
      expect(component.remoteVideoReady()).toBe(false);
      fire(resumed);
      expect(component.remoteVideoReady()).toBe(false);

      callState.update((state) => ({ ...state, callType: 'AUDIO' }));
      fixture.detectChanges();
      expect(cancel).toHaveBeenCalledWith(replacement);
      fire(replacement);
      expect(component.remoteVideoReady()).toBe(false);
      callState.update((state) => ({ ...state, callType: 'VIDEO' }));
      fixture.detectChanges();
      const remounted = nextId;
      expect(remounted).toBeGreaterThan(replacement);
      fire(remounted);
      expect(component.remoteVideoReady()).toBe(true);
      callState.update((state) => ({ ...state, remoteCameraEnabled: false }));
      fixture.detectChanges();
      callState.update((state) => ({ ...state, remoteCameraEnabled: true }));
      fixture.detectChanges();
      const pendingAtDestroy = nextId;
      fixture.destroy();
      expect(cancel).toHaveBeenCalledWith(pendingAtDestroy);
      fire(pendingAtDestroy);
      expect(component.remoteVideoReady()).toBe(false);
    } finally {
      if (!fixture.componentRef.hostView.destroyed) fixture.destroy();
      if (originalRequest)
        Object.defineProperty(
          prototype,
          'requestVideoFrameCallback',
          originalRequest,
        );
      else Reflect.deleteProperty(prototype, 'requestVideoFrameCallback');
      if (originalCancel)
        Object.defineProperty(
          prototype,
          'cancelVideoFrameCallback',
          originalCancel,
        );
      else Reflect.deleteProperty(prototype, 'cancelVideoFrameCallback');
    }
  });

  it('keeps video controls visible while the mouse is moving', () => {
    vi.useFakeTimers();
    callState.update((state) => ({
      ...state,
      callType: 'VIDEO',
      cameraEnabled: true,
      remoteCameraEnabled: true,
    }));
    const fixture = TestBed.createComponent(CallScreenComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    vi.advanceTimersByTime(2999);
    expect(component.controlsVisible()).toBe(true);

    component.onScreenMouseMove();
    vi.advanceTimersByTime(2999);
    expect(component.controlsVisible()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(component.controlsVisible()).toBe(false);
    fixture.destroy();
    vi.useRealTimers();
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
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
    expect(adapter.setSelfVideoPosition).toHaveBeenCalledTimes(1);
    expect(adapter.setSelfVideoPosition).toHaveBeenCalledWith(
      expectedLeft,
      expectedTop,
    );
    expect(component.selfTransform()).toBe(
      `translate3d(${expectedLeft}px, ${expectedTop}px, 0)`,
    );
    fixture.destroy();
  });

  it('keeps video mode while the local and remote cameras are off', () => {
    conversations.set([
      createP2PConversation({
        threadId: 4,
        account: 'alice',
        publisherNamespaceId: 0,
        profileRev: 0,
        profile: { name: 'Alice', bio: '', avatarDigest: null },
      }),
    ]);
    callState.update((state) => ({
      ...state,
      threadId: 4,
      peerName: 'Ignored native name',
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
    expect((root.querySelector('.switch') as HTMLButtonElement).disabled).toBe(
      true,
    );

    (root.querySelector('.cam') as HTMLButtonElement).click();
    expect(adapter.setCameraEnabled).toHaveBeenCalledTimes(1);
    expect(adapter.setCameraEnabled).toHaveBeenCalledWith(true);
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
    expect(upgrade.disabled).toBe(true);
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
