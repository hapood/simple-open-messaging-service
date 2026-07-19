import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';

/** Mirror of the backend `LoginMode` (src/config/public-config.ts). 1=all, 2=app-otp+qr, 3=password-only. */
export enum LoginMode {
  ALL = 1,
  APP_OTP_AND_QR = 2,
  PASSWORD_ONLY = 3,
}

/** A login method a client UI can offer. `otp` (admin-issued one-time code) is Android-only and yields a
 *  long-term `app` session; `qr` (scan-to-sign-in) is desktop/web-only and yields a 2-week sliding session
 *  confirmed by an already-logged-in phone; `password` is universal. */
export type LoginMethod = 'password' | 'otp' | 'qr';

type ConfigRes = {
  code: number;
  message: string;
  data?: { registrationOpen: boolean; loginMode: LoginMode };
};

/**
 * Public site configuration from `GET /config` — the registration flag + which login methods are enabled.
 *
 * Loaded LAZILY via {@link ensureLoaded} rather than at raw bootstrap: the bundled APK may boot before a
 * backend origin is configured (the apiOrigin signal is empty), and `/config` can only resolve once the
 * guest guard has confirmed an origin and the login flow is reached. Idempotent — concurrent callers share
 * one in-flight request; it never throws so route guards can `await` it unconditionally.
 *
 * Signals stay `null` until the first load settles; consumers treat `null` as "unknown / still loading".
 * Notably `registrationOpen() === true` is required to SHOW the register affordance, so it stays hidden
 * while loading or on load failure — matching the closed-by-default posture.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly http = inject(HttpClient);

  /** `null` until the first successful load (closed-by-default while unknown). */
  readonly registrationOpen = signal<boolean | null>(null);
  readonly loginMode = signal<LoginMode | null>(null);
  /** Flips to true once the first load attempt has settled (success or failure). */
  readonly loaded = signal(false);

  private loadPromise: Promise<void> | null = null;

  /** Methods available on THIS platform under the current `loginMode`. Empty until config is loaded.
   *  Drives which login UI the shell renders (and whether the method switcher shows >1 option).
   *
   *  Both OTP and QR are available on EVERY platform under the alt modes; they differ only in session
   *  lifetime (trusted native clients → permanent; browser → 14-day sliding) and are switchable everywhere. */
  readonly methodsForPlatform = computed<LoginMethod[]>(() => {
    const mode = this.loginMode();
    if (mode === null) return [];
    const passwordOn = mode === LoginMode.ALL || mode === LoginMode.PASSWORD_ONLY;
    const altOn = mode === LoginMode.ALL || mode === LoginMode.APP_OTP_AND_QR; // otp + qr, both on every platform
    const methods: LoginMethod[] = [];
    if (passwordOn) methods.push('password');
    if (altOn) methods.push('otp');
    if (altOn) methods.push('qr');
    return methods;
  });

  /** Fetch `/config` once. Idempotent (concurrent callers share the same promise); never throws — on error
   *  the signals stay `null` and `loaded` flips true so consumers can react (e.g. backend unreachable). */
  ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = firstValueFrom(this.http.get<ConfigRes>(`${apiPrefix()}/config`))
      .then((res) => {
        if (res.code === 0 && res.data) {
          this.registrationOpen.set(res.data.registrationOpen);
          this.loginMode.set(res.data.loginMode);
        }
      })
      .catch(() => {
        /* leave signals null; backend unreachable / not-yet-configured */
      })
      .finally(() => this.loaded.set(true));
    return this.loadPromise;
  }

  /** Force a fresh `/config` fetch, bypassing the cached result. {@link ensureLoaded} caches its settled
   *  promise for the whole app session, so without this two flows stay stale forever: a transient failure
   *  that the user wants to retry, and a reconfigure that pointed the app at a different backend. Resets
   *  the signals so consumers re-enter the loading state (the login page swaps its error card / form for a
   *  spinner) until the new request settles. Concurrent callers share the new in-flight promise. */
  reload(): Promise<void> {
    this.loadPromise = null;
    this.loaded.set(false);
    this.registrationOpen.set(null);
    this.loginMode.set(null);
    return this.ensureLoaded();
  }
}
