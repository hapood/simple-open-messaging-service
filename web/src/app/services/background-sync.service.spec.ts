import { BackgroundSyncService } from './background-sync.service';

/**
 * BackgroundSyncService unit tests — the Android background-delivery preference + status facade.
 *
 * The service is a thin, pure-logic adapter over the `SomsFcm` @JavascriptInterface: it seeds signals
 * (polling / FGS / FCM status / notification-permission status) from synchronous bridge reads at
 * construction and re-reads on demand. These tests pin the JSON parsing + the off-Android defaults
 * (absent/malformed bridge → benign defaults) so a Kotlin-side shape change can't silently corrupt the
 * Settings panel. No HttpClient / Worker / DI surface — drive `window.SomsFcm` and assert the signals.
 * Mirrors native-event.transport.spec.ts (no Angular TestBed, no fakeAsync — the re-read path under test
 * is synchronous; the 800ms timer in requestPermission is intentionally not exercised here).
 */

/** Install a controllable `window.SomsFcm` stub. Each field defaults to a value the service treats as
 *  "present"; set a return to undefined / a malformed string to exercise the defaulting paths. Records
 *  the request/open channel calls so those wiring assertions don't need timers. */
function installFakeFcm(initial: {
  notifStatus?: string | undefined;
  fcmStatus?: string | undefined;
  pollingEnabled?: boolean;
  fgsEnabled?: boolean;
}): {
  setNotif: (s: string | undefined) => void;
  setFcm: (s: string | undefined) => void;
  requestNotifs: () => number;
  openSettings: () => number;
} {
  let notif: string | undefined = initial.notifStatus;
  let fcm: string | undefined = initial.fcmStatus;
  let reqN = 0;
  let openN = 0;
  (window as unknown as { SomsFcm: Record<string, unknown> }).SomsFcm = {
    getNotificationStatus: () => notif,
    getFcmStatus: () => fcm,
    getPollingEnabled: () => initial.pollingEnabled ?? true,
    getForegroundServiceEnabled: () => initial.fgsEnabled ?? true,
    requestNotificationPermission: () => {
      reqN++;
    },
    openNotificationSettings: () => {
      openN++;
    },
  };
  return {
    setNotif: (s) => {
      notif = s;
    },
    setFcm: (s) => {
      fcm = s;
    },
    requestNotifs: () => reqN,
    openSettings: () => openN,
  };
}

describe('BackgroundSyncService', () => {
  // Restore the global after each test so a fake SomsFcm never leaks to specs that expect it absent
  // (mirrors native-event.transport.spec.ts).
  afterEach(() => {
    (window as unknown as { SomsFcm?: unknown }).SomsFcm = undefined;
  });

  describe('notifStatus (system notification permission)', () => {
    it('seeds from valid JSON', () => {
      installFakeFcm({ notifStatus: '{"enabled":false,"canRequest":true}' });
      const s = new BackgroundSyncService();
      expect(s.notifStatus()).toEqual({ enabled: false, canRequest: true });
    });

    it('defaults to {enabled:true, canRequest:false} on malformed JSON (benign — panel is Android-only)', () => {
      installFakeFcm({ notifStatus: 'not-json' });
      const s = new BackgroundSyncService();
      expect(s.notifStatus()).toEqual({ enabled: true, canRequest: false });
    });

    it('defaults when getNotificationStatus returns undefined (bridge present, value unset)', () => {
      installFakeFcm({ notifStatus: undefined });
      const s = new BackgroundSyncService();
      expect(s.notifStatus()).toEqual({ enabled: true, canRequest: false });
    });

    it('defaults when the SomsFcm bridge is entirely absent (browser/desktop)', () => {
      // No installFakeFcm — window.SomsFcm stays undefined.
      const s = new BackgroundSyncService();
      expect(s.notifStatus()).toEqual({ enabled: true, canRequest: false });
    });

    it('refreshNotifStatus re-reads after the native state changes', () => {
      const fake = installFakeFcm({
        notifStatus: '{"enabled":false,"canRequest":true}',
      });
      const s = new BackgroundSyncService();
      expect(s.notifStatus().enabled).toBe(false);
      fake.setNotif('{"enabled":true,"canRequest":false}');
      s.refreshNotifStatus();
      expect(s.notifStatus()).toEqual({ enabled: true, canRequest: false });
    });
  });

  describe('fcmStatus (FCM availability)', () => {
    it('seeds from valid JSON', () => {
      installFakeFcm({
        fcmStatus:
          '{"hasToken":true,"lastCheck":12345,"playServicesAvailable":true,"playServicesStatus":"SUCCESS","tokenError":null}',
      });
      const s = new BackgroundSyncService();
      expect(s.fcmStatus()).toEqual({
        hasToken: true,
        lastCheck: 12345,
        playServicesAvailable: true,
        playServicesStatus: 'SUCCESS',
        tokenError: null,
      });
    });

    it('defaults to {hasToken:false, lastCheck:0} on malformed JSON', () => {
      installFakeFcm({ fcmStatus: '<<<' });
      const s = new BackgroundSyncService();
      expect(s.fcmStatus()).toEqual({
        hasToken: false,
        lastCheck: 0,
        playServicesAvailable: false,
        playServicesStatus: 'UNKNOWN',
        tokenError: null,
      });
    });

    it('defaults when the bridge is absent', () => {
      const s = new BackgroundSyncService();
      expect(s.fcmStatus()).toEqual({
        hasToken: false,
        lastCheck: 0,
        playServicesAvailable: false,
        playServicesStatus: 'UNKNOWN',
        tokenError: null,
      });
    });
  });

  describe('toggle seeding (polling / FGS)', () => {
    it('seeds enabled/fgsEnabled from the bridge, defaulting to true when absent', () => {
      installFakeFcm({ pollingEnabled: false, fgsEnabled: false });
      const s = new BackgroundSyncService();
      expect(s.enabled()).toBe(false);
      expect(s.fgsEnabled()).toBe(false);

      (window as unknown as { SomsFcm?: unknown }).SomsFcm = undefined;
      const s2 = new BackgroundSyncService();
      expect(s2.enabled()).toBe(true);
      expect(s2.fgsEnabled()).toBe(true);
    });
  });

  describe('action channels', () => {
    it('requestPermission invokes the native requestNotificationPermission', () => {
      const fake = installFakeFcm({
        notifStatus: '{"enabled":false,"canRequest":true}',
      });
      const s = new BackgroundSyncService();
      s.requestPermission();
      expect(fake.requestNotifs()).toBe(1);
      // The 800ms re-read timer is intentionally not awaited (zoneless; the re-read path is covered
      // by the refreshNotifStatus test above).
    });

    it('openSystemSettings invokes the native openNotificationSettings', () => {
      const fake = installFakeFcm({});
      const s = new BackgroundSyncService();
      s.openSystemSettings();
      expect(fake.openSettings()).toBe(1);
    });
  });
});
