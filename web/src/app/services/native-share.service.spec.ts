import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NativeShareService } from './native-share.service';

describe('NativeShareService', () => {
  let originalUserAgent: string;
  let originalTauriInternals: Window['__TAURI_INTERNALS__'];
  let originalShare: Window['SomsShare'];

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
    originalTauriInternals = window.__TAURI_INTERNALS__;
    originalShare = window.SomsShare;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Android test WebView',
    });
    window.__TAURI_INTERNALS__ = {};
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    window.SomsShare = originalShare;
    delete window.__SOMS_SHARE_AVAILABLE__;
    TestBed.resetTestingModule();
  });

  it('pulls a pending payload and only clears it after native acknowledgement', () => {
    window.SomsShare = {
      getPending: () =>
        JSON.stringify({ id: 'share-1', text: 'https://example.com' }),
      acknowledge: () => true,
    };

    const service = TestBed.inject(NativeShareService);
    expect(service.pending()).toEqual({
      id: 'share-1',
      text: 'https://example.com',
    });
    service.claimRecipients(service.pending()!, [3, 7]);
    expect(service.draft()).toEqual({
      id: 'share-1',
      text: 'https://example.com',
      threadIds: [3, 7],
    });
    service.releaseDraft();
    expect(service.draft()).toBeNull();
    service.claimRecipients(service.pending()!, [3, 7]);
    expect(service.acknowledge('share-1')).toBeTrue();
    expect(service.pending()).toBeNull();
  });
});
