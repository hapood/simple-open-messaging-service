import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpBackend, provideHttpClient, withFetch } from '@angular/common/http';
import { TauriHttpBackend } from './tauri-http.backend';

/**
 * TauriHttpBackend DI wiring — regression guard for the NG0201 that occurred because `TauriHttpBackend`
 * does `inject(FetchBackend)` in a field initializer, but `FetchBackend` is only registered on its own
 * token by the `withFetch()` feature of `provideHttpClient`. Without `withFetch()` the token is unbound
 * and the very first HTTP request (which constructs the backend) throws NG0201 at
 * `<instance_members_initializer>`. app.config.ts must therefore always pair
 * `provideHttpClient(withFetch(), …)` with the `{ provide: HttpBackend, useClass: TauriHttpBackend }`
 * override (last provider wins, so TauriHttpBackend stays the chain terminus while FetchBackend remains
 * the resolvable delegate).
 */
describe('TauriHttpBackend DI wiring (regression: NG0201 without withFetch)', () => {
  it('constructs when HttpBackend is overridden on top of withFetch() (FetchBackend resolves)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withFetch()),
        { provide: HttpBackend, useClass: TauriHttpBackend },
      ],
    });
    const backend = TestBed.inject(HttpBackend);
    expect(backend).toBeInstanceOf(TauriHttpBackend);
  });

  it('throws NG0201 when withFetch() is omitted — the FetchBackend token is unbound otherwise', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // Deliberately NO withFetch(): the base provideHttpClient() provides HttpXhrBackend only and
        // leaves the FetchBackend token unbound, so TauriHttpBackend's inject(FetchBackend) fails.
        provideHttpClient(),
        { provide: HttpBackend, useClass: TauriHttpBackend },
      ],
    });
    expect(() => TestBed.inject(HttpBackend)).toThrowError(/NG0201/i);
  });
});
