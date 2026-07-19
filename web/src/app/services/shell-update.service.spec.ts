import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ShellUpdateService, ShellUpdateStatus } from './shell-update.service';
import { apiOrigin } from './runtime';

/**
 * ShellUpdateService unit tests — the launch probe + user-initiated download contract.
 *
 * isTauri() / tauriInvoke read `window.__TAURI__` + `window.__TAURI_INTERNALS__` at CALL time, so (like
 * auth.service.native.spec) we install those globals and route invoke to a spy. Locked down here:
 *  - `check()` writes the `init_update_status` result into `updateStatus`, with the origin it reads from
 *    the live `apiOrigin` signal;
 *  - `check()` is a no-op outside the Tauri shell (no invoke) and when no origin is configured;
 *  - `check()` swallows a rejected probe (offline/server down) — it never throws, `updateStatus` is left
 *    as-is (the cached bundle keeps the app usable);
 *  - `downloadUpdate()` invokes `init_download_web`, then re-probes so About flips to "up to date".
 *
 * What this does NOT cover: the Rust `init_update_status`/`init_download_web` commands themselves, the
 * `web-download-progress` stream (that's the init-window + About component's concern), and real install —
 * those need an apk-debug device smoke.
 */
describe('ShellUpdateService', () => {
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: jasmine.Spy } };
  };

  let svc: ShellUpdateService;
  let invokeSpy: jasmine.Spy;
  const ORIGIN = 'https://server.example';

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {}; // isTauri() → true
    invokeSpy = jasmine.createSpy('invoke');
    w.__TAURI__ = { core: { invoke: invokeSpy } };
    apiOrigin.set(ORIGIN); // apiOriginIsEmpty() → false
    svc = TestBed.inject(ShellUpdateService);
    svc.updateStatus.set(null);
  });

  afterEach(() => {
    const w = window as unknown as MockWindow;
    delete w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
    apiOrigin.set('');
  });

  const aStatus = (over: Partial<ShellUpdateStatus> = {}): ShellUpdateStatus => ({
    shellVersion: '0.1.0',
    serverVersion: '0.1.0',
    installedWebVersion: '0.2.0',
    serverWebVersion: '0.2.0',
    incompatible: false,
    webUpdateAvailable: false,
    ...over,
  });

  it('check() writes the init_update_status result into updateStatus (origin from the live signal)', async () => {
    const status = aStatus({ serverWebVersion: '0.2.1', webUpdateAvailable: true });
    invokeSpy.withArgs('init_update_status', { origin: ORIGIN }).and.resolveTo(status);

    await svc.check();

    expect(invokeSpy).toHaveBeenCalledOnceWith('init_update_status', { origin: ORIGIN });
    expect(svc.updateStatus()).toEqual(status);
  });

  it('check() is a no-op outside the Tauri shell (no invoke, updateStatus untouched)', async () => {
    delete (window as unknown as MockWindow).__TAURI_INTERNALS__; // isTauri() → false

    await svc.check();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(svc.updateStatus()).toBeNull();
  });

  it('check() is a no-op when no origin is configured (apiOriginIsEmpty)', async () => {
    apiOrigin.set('');

    await svc.check();

    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('check() swallows a rejected probe (offline) — never throws, updateStatus untouched', async () => {
    const prior = aStatus({ webUpdateAvailable: true });
    svc.updateStatus.set(prior);
    invokeSpy.and.rejectWith(new Error('offline'));

    await expectAsync(svc.check()).toBeResolved(); // does NOT throw
    expect(svc.updateStatus()).toEqual(prior); // unchanged — cached bundle keeps the app usable
  });

  it('downloadUpdate() invokes init_download_web, then re-probes so About flips to "up to date"', async () => {
    const fresh = aStatus({ serverWebVersion: '0.2.0', webUpdateAvailable: false });
    invokeSpy.withArgs('init_download_web', { origin: ORIGIN }).and.resolveTo(undefined);
    invokeSpy.withArgs('init_update_status', { origin: ORIGIN }).and.resolveTo(fresh);

    await svc.downloadUpdate();

    expect(invokeSpy).toHaveBeenCalledWith('init_download_web', { origin: ORIGIN });
    expect(svc.updateStatus()).toEqual(fresh);
  });

  it('downloadUpdate() is a no-op outside the Tauri shell', async () => {
    delete (window as unknown as MockWindow).__TAURI_INTERNALS__;

    await svc.downloadUpdate();

    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
