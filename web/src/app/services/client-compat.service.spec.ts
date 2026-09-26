import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ClientCompatService, type ClientCompatStatus } from './client-compat.service';
import { apiOrigin, apiOriginSecondary } from './runtime';

describe('ClientCompatService', () => {
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: Mock } };
  };
  let svc: ClientCompatService;
  let invokeSpy: Mock;
  const ORIGIN = 'https://server.example';

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {};
    invokeSpy = vi.fn();
    w.__TAURI__ = { core: { invoke: invokeSpy } };
    apiOrigin.set(ORIGIN);
    apiOriginSecondary.set(null);
    svc = TestBed.inject(ClientCompatService);
  });

  afterEach(() => {
    const w = window as unknown as MockWindow;
    delete w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
    apiOrigin.set('');
    apiOriginSecondary.set(null);
  });

  it('fetches server information using the active origin without downloading assets', async () => {
    const status: ClientCompatStatus = { serverVersion: '0.1.0', incompatible: false };
    invokeSpy.mockImplementation((command: string) =>
      Promise.resolve(command === 'get_active_api_origin' ? ORIGIN : status),
    );
    await svc.check();
    expect(invokeSpy).toHaveBeenCalledWith('init_compat_status', { origin: ORIGIN });
    expect(svc.status()).toEqual(status);
    expect(svc.probedOrigin()).toBe(ORIGIN);
    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });

  it('does nothing outside Tauri or without a configured origin', async () => {
    delete (window as unknown as MockWindow).__TAURI_INTERNALS__;
    await svc.check();
    apiOrigin.set('');
    await svc.check();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('preserves the previous status on network errors', async () => {
    const prior = { serverVersion: '0.1.0', incompatible: false };
    svc.status.set(prior);
    invokeSpy.mockRejectedValue(new Error('offline'));
    await svc.check();
    expect(svc.status()).toEqual(prior);
  });
});
