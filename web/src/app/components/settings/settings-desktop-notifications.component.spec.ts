import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { SettingsDesktopNotificationsComponent } from './settings-desktop-notifications.component';
import { NotificationPrefsService } from '../../services/notification-prefs.service';

/**
 * `tauriInvoke` resolves `window.__TAURI__.core.invoke` at call time, so this spec installs the
 * Tauri globals and routes them to a spy instead of replacing the runtime module — the Angular
 * browser runner bundles relative modules and does not support vi.mock for them (same pattern as
 * auth.service.native.spec.ts). This also verifies the real runtime routing, not a stand-in.
 */
describe('native desktop notification settings', () => {
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: ReturnType<typeof vi.fn> } };
  };
  const w = window as unknown as MockWindow;
  let invoke: ReturnType<typeof vi.fn>;
  let component: SettingsDesktopNotificationsComponent;
  const prefs = {
    enabled: signal(true),
    sound: signal(true),
    previewMode: signal('message'),
    setEnabled: vi.fn(),
    setSound: vi.fn(),
    setPreviewMode: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    invoke = vi.fn().mockName('invoke').mockResolvedValue('notDetermined');
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = { core: { invoke } };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: NotificationPrefsService, useValue: prefs },
      ],
    }).overrideComponent(SettingsDesktopNotificationsComponent, {
      set: { template: '' },
    });
    component = TestBed.createComponent(
      SettingsDesktopNotificationsComponent,
    ).componentInstance;
    await Promise.resolve();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
  });

  it('queries native permission without requesting it on entry', () => {
    // tauriInvoke forwards the (here absent) args object, so the native invoke
    // receives an explicit `undefined` second argument.
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'desktop_notification_permission',
      undefined,
    );
    expect(component.permission()).toBe('notDetermined');
  });

  it('requests permission only explicitly, and displays denial as a state', async () => {
    invoke.mockResolvedValue('denied');
    await component.requestPermission();
    expect(invoke).toHaveBeenLastCalledWith(
      'desktop_notification_request_permission',
      undefined,
    );
    expect(component.permissionKey()).toBe(
      'settings.nativeNotifPermission_denied',
    );
    const calls = invoke.mock.calls.length;
    await component.requestPermission();
    expect(invoke).toHaveBeenCalledTimes(calls);
    await component.openSettings();
    expect(invoke).toHaveBeenLastCalledWith(
      'desktop_notification_open_settings',
      undefined,
    );
  });

  it('refreshes permission when focus returns from system settings', async () => {
    invoke.mockResolvedValue('authorized');
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(component.permission()).toBe('authorized');
  });

  it('does not invent permission support on other desktops', async () => {
    invoke.mockResolvedValue('unsupported');
    await component.refresh();
    expect(component.permission()).toBe('unsupported');
  });

  it('shows action failures and allows retry', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC failed'));
    await component.refresh();
    expect(component.failed()).toBe(true);
    expect(component.busy()).toBe(false);
    await component.refresh();
    expect(component.failed()).toBe(false);
  });

  it('rejects unexpected permission values', async () => {
    invoke.mockResolvedValue('unexpected');
    await component.refresh();
    expect(component.permission()).toBe('unknown');
  });

  it('does not publish late results or keep a focus listener after destruction', async () => {
    let resolve!: (value: string) => void;
    invoke.mockReturnValueOnce(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const pending = component.refresh();
    TestBed.resetTestingModule();
    const calls = invoke.mock.calls.length;
    resolve('authorized');
    await pending;
    window.dispatchEvent(new Event('focus'));
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(component.permission()).toBe('notDetermined');
  });

  it('writes validated preview values through the existing preference store', () => {
    component.setPreviewMode('private');
    component.setPreviewMode('invalid');
    expect(prefs.setPreviewMode).toHaveBeenCalledExactlyOnceWith('private');
  });
});
