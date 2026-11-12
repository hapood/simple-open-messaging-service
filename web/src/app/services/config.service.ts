import { computed, Injectable, signal } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { apiPrefix } from './constants';
import { REQUEST_SCOPE, RequestScope } from '../request-context';

/** A login method a client UI can offer, mirroring the backend `LoginMethod` (src/config/public-config.ts).
 *  `otp` (admin-issued one-time code) yields a long-term `app` session on trusted native clients (14-day
 *  sliding in browser); `qr` (scan-to-sign-in) yields a 2-week sliding session confirmed by an
 *  already-logged-in phone; `password` is universal. */
export type LoginMethod = 'password' | 'otp' | 'qr';

/** One advertised login method. The list order IS the presentation order (e.g. login tab order);
 *  `disabled` entries stay advertised so the UI renders them as visible-but-unavailable options. */
export interface LoginMethodOption {
  key: LoginMethod;
  disabled: boolean;
}

/** The validated policy stored in the service signals. */
interface LoginPolicy {
  methods: LoginMethodOption[];
  defaultMethod: LoginMethod;
}

const KNOWN_LOGIN_METHODS: readonly LoginMethod[] = [
  'password',
  'otp',
  'qr',
];

/** Normalize the advertised policy: keep only well-formed entries with known keys, PRESERVE the array
 *  order (it is the presentation order per the API contract — do not re-sort), and keep only the first
 *  occurrence of a duplicated key. The default is resolved with the documented fallback: a missing,
 *  unknown, or disabled `defaultLoginMethod` falls back to the first non-disabled entry. Returns `null`
 *  when no usable method remains — a policy with zero enabled methods is a misconfiguration the login
 *  surface must surface as a config failure rather than a login page with nothing selectable. */
function normalizeLoginPolicy(
  advertised: unknown,
  advertisedDefault: unknown,
): LoginPolicy | null {
  if (!Array.isArray(advertised)) return null;
  const methods: LoginMethodOption[] = [];
  for (const raw of advertised) {
    if (raw === null || typeof raw !== 'object') continue;
    const key = (raw as { key?: unknown }).key;
    if (typeof key !== 'string' || !KNOWN_LOGIN_METHODS.includes(key as LoginMethod))
      continue;
    if (methods.some((m) => m.key === key)) continue;
    methods.push({
      key: key as LoginMethod,
      disabled: (raw as { disabled?: unknown }).disabled === true,
    });
  }
  const firstEnabled = methods.find((m) => !m.disabled);
  if (!firstEnabled) return null;
  const defaultKey = advertisedDefault;
  const defaultMethod =
    typeof defaultKey === 'string' &&
    KNOWN_LOGIN_METHODS.includes(defaultKey as LoginMethod) &&
    methods.some((m) => m.key === defaultKey && !m.disabled)
      ? (defaultKey as LoginMethod)
      : firstEnabled.key;
  return { methods, defaultMethod };
}

type ConfigRes = {
  code: number;
  message: string;
  data?: {
    registrationOpen: boolean;
    loginMethods: LoginMethodOption[];
    defaultLoginMethod: LoginMethod;
  };
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
  constructor(private readonly http: HttpClient) {}

  /** `null` until the first successful load (closed-by-default while unknown). */
  readonly registrationOpen = signal<boolean | null>(null);
  /** `null` until the first successful load of a usable, well-formed policy (closed-by-default while
   *  unknown). Order is the presentation order; disabled entries are kept for grayed-out rendering. */
  readonly loginMethods = signal<LoginMethodOption[] | null>(null);
  /** `null` alongside `loginMethods`; otherwise the resolved pre-selected method (server default with the
   *  documented fallback already applied). */
  readonly defaultLoginMethod = signal<LoginMethod | null>(null);
  /** Flips to true once the first load attempt has settled (success or failure). */
  readonly loaded = signal(false);
  /** The user explicitly stopped the current connection attempt. Kept separate from a network failure so
   * the login surface can report an accurate idle state instead of claiming the server was unreachable. */
  readonly cancelled = signal(false);

  private loadPromise: Promise<void> | null = null;
  private cancelRequest = new Subject<void>();
  /** Monotonic request generation. A response from the previously configured server may arrive after
   *  reconfigure/reload; only the newest generation is allowed to publish signals. */
  private loadGeneration = 0;

  /** Enabled methods in presentation order. Empty until config is loaded; drives the login-page ready
   *  gate (a loaded policy always has ≥1 enabled entry — normalization nulls it otherwise). */
  readonly methodsForPlatform = computed<LoginMethod[]>(() =>
    (this.loginMethods() ?? []).filter((m) => !m.disabled).map((m) => m.key),
  );

  /** Fetch `/config` once. Idempotent (concurrent callers share the same promise); never throws — on error
   *  the signals stay `null` and `loaded` flips true so consumers can react (e.g. backend unreachable). */
  ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const generation = ++this.loadGeneration;
    this.loadPromise = firstValueFrom(
      this.http
        .get<ConfigRes>(`${apiPrefix()}/config`, {
          context: new HttpContext().set(REQUEST_SCOPE, RequestScope.Server),
        })
        .pipe(takeUntil(this.cancelRequest)),
    )
      .then((res) => {
        if (generation === this.loadGeneration && res.code === 0 && res.data) {
          this.registrationOpen.set(res.data.registrationOpen);
          const policy = normalizeLoginPolicy(
            res.data.loginMethods,
            res.data.defaultLoginMethod,
          );
          this.loginMethods.set(policy?.methods ?? null);
          this.defaultLoginMethod.set(policy?.defaultMethod ?? null);
          this.cancelled.set(false);
        }
      })
      .catch(() => {
        /* leave signals null; backend unreachable / not-yet-configured */
      })
      .finally(() => {
        if (generation === this.loadGeneration) this.loaded.set(true);
      });
    return this.loadPromise;
  }

  /** Force a fresh `/config` fetch, bypassing the cached result. {@link ensureLoaded} caches its settled
   *  promise for the whole app session, so without this two flows stay stale forever: a transient failure
   *  that the user wants to retry, and a reconfigure that pointed the app at a different backend. Resets
   *  the signals so consumers re-enter the loading state (the login page swaps its error card / form for a
   *  spinner) until the new request settles. Concurrent callers share the new in-flight promise. */
  reload(): Promise<void> {
    // Invalidate the old generation before resetting its cached promise. Even though Fetch/IPC work may
    // continue underneath an unsubscribed consumer, its late result can no longer overwrite the new server.
    this.loadGeneration++;
    this.cancelRequest.next();
    this.cancelRequest.complete();
    this.cancelRequest = new Subject<void>();
    this.loadPromise = null;
    this.loaded.set(false);
    this.cancelled.set(false);
    this.registrationOpen.set(null);
    this.loginMethods.set(null);
    this.defaultLoginMethod.set(null);
    return this.ensureLoaded();
  }

  /** Immediately unsubscribe the active HTTP request. The settled promise remains cached so guards and
   * components cannot silently restart the cancelled connection; only an explicit retry/reload does. */
  cancelLoad(): void {
    if (!this.loadPromise || this.loaded()) return;
    this.loadGeneration++;
    this.cancelled.set(true);
    this.loaded.set(true);
    this.registrationOpen.set(null);
    this.loginMethods.set(null);
    this.defaultLoginMethod.set(null);
    this.cancelRequest.next();
    this.cancelRequest.complete();
  }
}
