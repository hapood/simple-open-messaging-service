import { TestBed } from '@angular/core/testing';
import { PushService } from './push.service';
import { PushRegistrationService } from './push-registration.service';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import { apiOrigin } from './runtime';
import type { ThreadNavigationIntent } from './thread-navigation-intent';

describe('PushService required session receipt', () => {
  const offer = vi.fn<(intent: ThreadNavigationIntent) => void>();
  const acknowledgeThreadId = vi.fn();
  let pending: string | null;
  let service: PushService;
  const receipt = (id: string, sessionId: number) => JSON.stringify({ id, threadId: 7, sessionId, origin: 'https://primary' });
  beforeEach(() => {
    apiOrigin.set('https://primary');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    pending = receipt('tap-1', 11); offer.mockClear(); acknowledgeThreadId.mockClear();
    Object.defineProperty(window, 'SomsFcm', { configurable: true, value: {
      getPendingThreadId: () => pending, acknowledgeThreadId, getToken: () => null, requestToken: vi.fn(),
    } });
    TestBed.configureTestingModule({ providers: [
      { provide: ThreadNavigationIntentService, useValue: { offer } },
      { provide: PushRegistrationService, useValue: { setAdapter: vi.fn(), refresh: vi.fn() } },
    ] });
    service = TestBed.inject(PushService);
  });
  afterEach(() => {
    TestBed.resetTestingModule(); vi.restoreAllMocks(); apiOrigin.set('');
    delete window.__TAURI_INTERNALS__; delete window.SomsFcm;
    delete window.__SOMS_DEEP_LINK__; delete window.__SOMS_FCM_TOKEN__;
  });
  it('resolves navigation lazily and acknowledges the exact receipt', () => {
    expect(offer).not.toHaveBeenCalled(); service.init();
    expect(offer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 11, threadId: 7 }));
    expect(acknowledgeThreadId).not.toHaveBeenCalled();
    const intent = offer.mock.calls[0][0]; const old = pending;
    pending = receipt('tap-2', 12); intent.acknowledge!();
    expect(acknowledgeThreadId).toHaveBeenCalledExactlyOnceWith(old);
    window.__SOMS_DEEP_LINK__!();
    expect(offer).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tap-2', sessionId: 12 }));
  });
  it('rejects raw, account-only, invalid session and other-origin receipts', () => {
    for (const value of ['7', '{', 'null', JSON.stringify({ id: 'old', threadId: 7, userId: 11 }),
      ...[undefined, null, 0, -1, '11', 1.5].map(sessionId => JSON.stringify({ id: 'tap', threadId: 7, sessionId, origin: 'https://primary' })),
      JSON.stringify({ id: 'tap', threadId: 7, sessionId: 11, origin: 'https://other' })]) {
      pending = value; service.init();
    }
    expect(offer).not.toHaveBeenCalled(); expect(acknowledgeThreadId).not.toHaveBeenCalled();
  });
});
