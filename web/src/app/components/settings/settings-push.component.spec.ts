import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  BackgroundSyncService,
  type FcmStatus,
} from '../../services/background-sync.service';
import { LanguageService } from '../../services/language.service';
import { SettingsPushComponent } from './settings-push.component';
import { SettingsPushProbeComponent } from './settings-push-probe.component';

@Component({ selector: 'app-settings-push-probe', template: '' })
class PushProbeStub {}

describe('Android notification badge settings', () => {
  const lang = signal('en');
  const bgSync = {
    notifStatus: signal({ enabled: true, canRequest: false }),
    alertPolicy: signal('cooldown_5s'),
    fcmStatus: signal<FcmStatus>({
      hasToken: false,
      lastCheck: 0,
      playServicesAvailable: true,
      playServicesStatus: 'SUCCESS',
      tokenError: null,
    }),
    refreshFcmStatus: vi.fn(),
    fgsEnabled: signal(false),
    enabled: signal(false),
    nextPullTime: signal(0),
    previewMode: signal('message'),
    refreshNotifStatus: vi.fn(),
    openSystemSettings: vi.fn(),
    requestPermission: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lang.set('en');
    bgSync.notifStatus.set({ enabled: true, canRequest: false });
    bgSync.fcmStatus.set({
      hasToken: false,
      lastCheck: 0,
      playServicesAvailable: true,
      playServicesStatus: 'SUCCESS',
      tokenError: null,
    });
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        { provide: BackgroundSyncService, useValue: bgSync },
        { provide: LanguageService, useValue: { lang } },
      ],
    }).overrideComponent(SettingsPushComponent, {
      remove: { imports: [SettingsPushProbeComponent] },
      add: { imports: [PushProbeStub] },
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    [
      'en',
      'Not ready (no token obtained)',
      'FCM registration failed, possibly due to network or temporary service unavailability. Check connectivity to Google/Firebase and try again later (IOException).',
    ],
    [
      'zh-CN',
      '尚未就绪（未获取到 Token）',
      'FCM 注册失败，可能是网络或服务暂时不可用。请检查 Google/Firebase 连接，稍后重试（IOException）。',
    ],
  ])(
    'does not mistake token failures for missing Google services in %s',
    async (language, status, hint) => {
      lang.set(language);
      TestBed.inject(TranslocoService).setActiveLang(language);
      bgSync.fcmStatus.update((current) => ({
        ...current,
        tokenError: 'IOException',
      }));
      const fixture = TestBed.createComponent(SettingsPushComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.componentInstance.fcmStatusLabel()).toBe(status);
      expect(fixture.componentInstance.fcmHint()).toBe(hint);
      expect(fixture.nativeElement.textContent).toContain(hint);
    },
  );

  it.each([
    ['SERVICE_NOT_AVAILABLE', 'settings.fcmConnectionError'],
    ['UnknownHostException', 'settings.fcmConnectionError'],
    ['SocketTimeoutException', 'settings.fcmConnectionError'],
    ['ConnectException', 'settings.fcmConnectionError'],
    ['NETWORK_ERROR', 'settings.fcmConnectionError'],
    ['FIREBASE_NOT_CONFIGURED', 'settings.fcmTokenError'],
    ['SecurityException', 'settings.fcmTokenError'],
  ])('uses an appropriate hint for %s', async (error, key) => {
    bgSync.fcmStatus.update((current) => ({ ...current, tokenError: error }));
    const fixture = TestBed.createComponent(SettingsPushComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.fcmHint()).toBe(
      TestBed.inject(TranslocoService).translate(key, { error }),
    );
  });

  it('prioritizes the actual Play services failure over a token error', async () => {
    bgSync.fcmStatus.update((current) => ({
      ...current,
      playServicesAvailable: false,
      playServicesStatus: 'SERVICE_DISABLED',
      tokenError: 'IOException',
    }));
    const fixture = TestBed.createComponent(SettingsPushComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.fcmHint()).toBe(
      'Google Play services unavailable: SERVICE_DISABLED',
    );
  });

  it('wraps diagnostics within a narrow settings panel', async () => {
    bgSync.fcmStatus.update((current) => ({
      ...current,
      tokenError: 'IOException',
    }));
    const fixture = TestBed.createComponent(SettingsPushComponent);
    fixture.nativeElement.style.display = 'block';
    fixture.nativeElement.style.width = '320px';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const hint: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="fcm-hint"]',
    );
    expect(hint.offsetHeight).toBeGreaterThan(20);
    expect(hint.scrollHeight).toBe(hint.clientHeight);
    expect(hint.scrollWidth).toBeLessThanOrEqual(hint.clientWidth);
  });

  it('refreshes native diagnostics on open, focus, and while visible, then stops on destroy', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const fixture = TestBed.createComponent(SettingsPushComponent);
    fixture.detectChanges();
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2500);
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(3);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(2500);
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(3);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(4);
    fixture.destroy();
    vi.advanceTimersByTime(5000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(bgSync.refreshFcmStatus).toHaveBeenCalledTimes(4);
    vi.restoreAllMocks();
  });

  it.each([
    [
      'en',
      'not your total unread messages',
      'without marking messages as read',
    ],
    ['zh-CN', '不代表全部未读消息数', '不会将消息标为已读'],
  ])(
    'explains notification-owned badges in %s',
    async (language, count, read) => {
      lang.set(language);
      TestBed.inject(TranslocoService).setActiveLang(language);
      const fixture = TestBed.createComponent(SettingsPushComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const hint: HTMLElement = fixture.nativeElement.querySelector(
        '[data-testid="notification-badge-hint"]',
      );
      expect(hint.textContent).toContain(count);
      expect(hint.textContent).toContain(read);
      // Use a wrapping footnote, not a clipped Material list subtitle.
      expect(hint.parentElement?.classList.contains('settings-group')).toBe(
        true,
      );
    },
  );

  it('keeps system settings accessible even when notifications are allowed', async () => {
    const fixture = TestBed.createComponent(SettingsPushComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    const settings = buttons.find((button) =>
      button.textContent?.includes(
        TestBed.inject(TranslocoService).translate(
          'settings.notifPermOpenSettings',
        ),
      ),
    );
    expect(settings).toBeDefined();
    settings!.click();
    expect(bgSync.openSystemSettings).toHaveBeenCalledExactlyOnceWith();
    expect(bgSync.requestPermission).not.toHaveBeenCalled();

    bgSync.refreshNotifStatus.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(bgSync.refreshNotifStatus).toHaveBeenCalledExactlyOnceWith();
    fixture.destroy();
    window.dispatchEvent(new Event('focus'));
    expect(bgSync.refreshNotifStatus).toHaveBeenCalledTimes(1);
  });
});
