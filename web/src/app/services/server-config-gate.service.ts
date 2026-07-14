import { Injectable } from '@angular/core';

/**
 * One-shot latch for the bundled-APK first-run server-config nudge.
 *
 * `guestGuard` redirects `/auth/login` → `/config` when the backend origin is still the localhost
 * build default (no server configured). Without this latch that redirect is re-evaluated on every
 * navigation into `/auth/login`, so `ServerConfigComponent.cancel()` (which navigates back to
 * `/auth/login`) would bounce straight back to `/config` — an inescapable loop. {@link consumeOnce}
 * lets the nudge fire exactly once per boot; after it has fired, cancel reaches login for real.
 *
 * Lives in DI (not a module-level `let`) so it is mockable in guard unit tests and has explicit
 * ownership. It is in-memory state, so a full page reload — which happens after a successful Save
 * (so the origin is then non-localhost) or any genuine refresh while still unconfigured — resets it.
 * Re-nudging after a reload while unconfigured is correct: the app is unusable without a reachable
 * server, so re-offering the config page is the safe behavior.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigGateService {
  /** True once the first-run nudge has fired this boot. */
  private offered = false;

  /**
   * Returns `true` the first time it is called this boot, then `false` forever after (until the
   * service is re-created by a full reload). Call site: `guestGuard`.
   */
  consumeOnce(): boolean {
    if (this.offered) return false;
    this.offered = true;
    return true;
  }
}
