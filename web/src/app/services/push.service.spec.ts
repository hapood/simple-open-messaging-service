import { TestBed } from '@angular/core/testing';
import { PushService } from './push.service';
import { PushRegistrationService } from './push-registration.service';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import type { ThreadNavigationIntent } from './thread-navigation-intent';

describe('PushService native navigation receipt', () => {
  const offer = vi.fn<(intent: ThreadNavigationIntent) => void>();
  const acknowledgeThreadId = vi.fn();
  let pending: string | null;
  let service: PushService;
  const receipt = (id: string) =>
    JSON.stringify({ id, target: { kind: 'thread', threadId: 7 } });
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    pending = receipt('tap-1');
    offer.mockClear();
    acknowledgeThreadId.mockClear();
    Object.defineProperty(window, 'SomsFcm', {
      configurable: true,
      value: {
        getPendingThreadId: () => pending,
        acknowledgeThreadId,
        getToken: () => null,
        requestToken: vi.fn(),
      },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadNavigationIntentService, useValue: { offer } },
        {
          provide: PushRegistrationService,
          useValue: { setAdapter: vi.fn(), refresh: vi.fn() },
        },
      ],
    });
    service = TestBed.inject(PushService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    delete window.__TAURI_INTERNALS__;
    delete window.SomsFcm;
    delete window.__SOMS_DEEP_LINK__;
    delete window.__SOMS_FCM_TOKEN__;
  });
  it('resolves navigation lazily and acknowledges the exact receipt', () => {
    expect(offer).not.toHaveBeenCalled();
    service.init();
    expect(offer).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'android',
        id: 'tap-1',
        target: { kind: 'thread', threadId: 7 },
      }),
    );
    expect(acknowledgeThreadId).not.toHaveBeenCalled();
    const intent = offer.mock.calls[0][0];
    const old = pending;
    pending = receipt('tap-2');
    intent.acknowledge!();
    expect(acknowledgeThreadId).toHaveBeenCalledExactlyOnceWith(old);
    window.__SOMS_DEEP_LINK__!();
    expect(offer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: 'android',
        id: 'tap-2',
        target: { kind: 'thread', threadId: 7 },
      }),
    );
  });
  it('rejects malformed receipts, missing IDs and invalid thread coordinates', () => {
    for (const value of [
      '7',
      '{',
      'null',
      JSON.stringify({ threadId: 7 }),
      ...[undefined, null, 0, -1, '7', 1.5].map((threadId) =>
        JSON.stringify({
          id: 'tap',
          target: { kind: 'thread', threadId },
        }),
      ),
      ...['', ' ', 123].map((id) =>
        JSON.stringify({ id, target: { kind: 'thread', threadId: 7 } }),
      ),
    ]) {
      pending = value;
      service.init();
    }
    expect(offer).not.toHaveBeenCalled();
    expect(acknowledgeThreadId).not.toHaveBeenCalled();
  });
});
