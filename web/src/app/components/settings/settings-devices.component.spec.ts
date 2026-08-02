import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import {
  InlineTranslocoLoader,
  translations,
} from '../../i18n/transloco.loader';
import { of } from 'rxjs';
import { SettingsDevicesComponent } from './settings-devices.component';
import { AuthService, type SessionInfo } from '../../services/auth.service';
import { RouteService, PopupType } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';

/**
 * SettingsDevicesComponent unit tests — the class logic behind the "Devices" list.
 *
 * Locked down here:
 *  - deviceLabel(): isCurrent → "This device"; a named device → that name; missing → "Unknown device";
 *  - clientLabel(): app/web/desktop → Android/Web/Desktop;
 *  - expiresLabel(): no-expiry app tokens → "No expiry"; otherwise the formatted deadline;
 *  - location(): prefers lastSeenIp, falls back to the sign-in ip, then '-';
 *  - othersCount(): counts non-current rows (drives the "sign out everywhere else" affordance);
 *  - revoke(s) + terminateOthers(): confirm-first, then call AuthService.revokeSession with the right
 *    id(s) — the confirm gating lives here (popupDlg callback), not in the service.
 *
 * Template blanked (the unit is the class logic, matching the peer settings-*.spec pattern).
 */
describe('SettingsDevicesComponent', () => {
  let comp: SettingsDevicesComponent;
  let getSessions: jasmine.Spy;
  let getSessionSettings: jasmine.Spy;
  let setSessionAutoTerminateDays: jasmine.Spy;
  let revokeSession: jasmine.Spy;
  let confirmCb: ((result: unknown) => void) | undefined;

  /** A minimal row factory (id + overrides) so each assertion reads only what it varies. */
  function row(id: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      id,
      client: 'web',
      device: null,
      userAgent: null,
      ip: null,
      lastSeenIp: null,
      createdAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-02T00:00:00Z',
      expiresAt: '2026-02-01T00:00:00Z',
      autoTerminateDays: 30,
      isCurrent: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    confirmCb = undefined;
    getSessions = jasmine
      .createSpy('getSessions')
      .and.returnValue(
        of({ code: 0, message: 'ok', data: [] as SessionInfo[] }),
      );
    getSessionSettings = jasmine
      .createSpy('getSessionSettings')
      .and.returnValue(
        of({ code: 0, message: 'ok', data: { autoTerminateDays: 30 } }),
      );
    setSessionAutoTerminateDays = jasmine
      .createSpy('setSessionAutoTerminateDays')
      .and.returnValue(of({ code: 0, message: 'ok' }));
    revokeSession = jasmine
      .createSpy('revokeSession')
      .and.returnValue(of({ code: 0, message: 'ok' }));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: '简体中文' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        SettingsDevicesComponent,
        {
          provide: AuthService,
          useValue: {
            getSessions,
            getSessionSettings,
            setSessionAutoTerminateDays,
            revokeSession,
          } as unknown as AuthService,
        },
        {
          provide: RouteService,
          useValue: {
            popupDlg: jasmine
              .createSpy('popupDlg')
              .and.callFake(
                (_t: PopupType, _i: unknown, cb?: (r: unknown) => void) => {
                  confirmCb = cb;
                  return { id: 0 };
                },
              ),
          } as unknown as RouteService,
        },
        {
          provide: LanguageService,
          useValue: { lang: signal('en') } as unknown as LanguageService,
        },
      ],
    }).overrideComponent(SettingsDevicesComponent, { set: { template: '' } });
    comp = TestBed.createComponent(SettingsDevicesComponent).componentInstance;

    // Prime the `en` dictionary synchronously so translate() resolves the real strings.
    const transloco = TestBed.inject(TranslocoService);
    transloco.setTranslation(translations['en'], 'en');
    transloco.setActiveLang('en');
  });
  afterEach(() => TestBed.resetTestingModule());

  // ── label / formatting routing ─────────────────────────────────────────────────────────────

  it('deviceLabel(): isCurrent → "This device"; named → name; missing → "Unknown device"', () => {
    expect(comp.deviceLabel(row(1, { isCurrent: true }))).toBe('This device');
    expect(comp.deviceLabel(row(2, { device: 'Pixel 8' }))).toBe('Pixel 8');
    expect(comp.deviceLabel(row(3, { device: null }))).toBe('Unknown device');
  });

  it('clientLabel(): maps app/web/desktop to Android/Web/Desktop', () => {
    expect(comp.clientLabel('app')).toBe('Android');
    expect(comp.clientLabel('web')).toBe('Web');
    expect(comp.clientLabel('desktop')).toBe('Desktop');
  });

  it('expiresLabel(): null → "No expiry"; otherwise a formatted date', () => {
    expect(comp.expiresLabel(row(1, { expiresAt: null }))).toBe('No expiry');
    const labelled = comp.expiresLabel(
      row(2, { expiresAt: '2026-02-01T00:00:00Z' }),
    );
    expect(labelled).toMatch(/2026-02-0/); // dayjs YYYY-MM-DD in the formatted string
  });

  it('location(): prefers lastSeenIp, then ip, then "-"', () => {
    expect(
      comp.location(row(1, { lastSeenIp: '1.1.1.1', ip: '2.2.2.2' })),
    ).toBe('1.1.1.1');
    expect(comp.location(row(2, { lastSeenIp: null, ip: '2.2.2.2' }))).toBe(
      '2.2.2.2',
    );
    expect(comp.location(row(3, { lastSeenIp: null, ip: null }))).toBe('-');
  });

  // ── othersCount ────────────────────────────────────────────────────────────────────────────

  it('othersCount(): counts non-current rows', () => {
    expect(comp.othersCount()).toBe(0); // list starts empty (ngOnInit load stubbed to [])
    comp.list.set([row(1, { isCurrent: true }), row(2), row(3)]);
    expect(comp.othersCount()).toBe(2);
  });

  // ── revoke / terminateOthers (confirm-first) ───────────────────────────────────────────────

  it('revoke(s): confirms, then on confirm calls revokeSession with the row id and reloads', () => {
    getSessions.and.returnValue(of({ code: 0, message: 'ok', data: [] }));
    comp.revoke(row(7, { device: 'Pixel' }));
    expect(revokeSession).not.toHaveBeenCalled(); // nothing happens before confirm
    expect(confirmCb).toEqual(jasmine.any(Function));
    confirmCb!(true);
    expect(revokeSession).toHaveBeenCalledWith(7);
    expect(getSessions).toHaveBeenCalled(); // reload after revoke
  });

  it('revoke(s): on cancel does nothing', () => {
    comp.revoke(row(7));
    confirmCb!(undefined);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('terminateOthers(): confirms, then revokes every non-current session in parallel', () => {
    comp.list.set([row(1, { isCurrent: true }), row(2), row(3), row(4)]);
    comp.terminateOthers();
    expect(revokeSession).not.toHaveBeenCalled();
    confirmCb!(true);
    expect(revokeSession.calls.allArgs().map((a) => a[0])).toEqual([2, 3, 4]);
  });

  it('terminateOthers(): no-op when there are no other sessions (no confirm)', () => {
    comp.list.set([row(1, { isCurrent: true })]);
    comp.terminateOthers();
    expect(confirmCb).toBeUndefined();
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
