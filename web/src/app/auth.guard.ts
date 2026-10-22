import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand } from '@angular/router';
import { Router } from '@angular/router';
import { AuthService } from './services/auth.service';
import { ConfigService } from './services/config.service';
import { apiOriginIsEmpty, isTauri, syncApiOriginSignal, tauriInvoke } from './services/runtime';

// Auth-flow history contract: a logged-in user must NEVER be able to press Back from the app and land
// on /auth/login or /auth/register. That is enforced structurally, not by reacting after the fact:
//  - Every explicit navigation INTO an auth page uses `replaceUrl: true` via RouteService.redirect()
//    (login success, register success, logout in icon-rail/nav-drawer, 401-expiry in redoLoginAuth),
//    so the auth URL overwrites — never stacks on top of — the entry the user is leaving.
//  - These guard redirects do the same. A guard redirect is a reactive *correction* of an invalid URL
//    (unauthenticated user hitting a protected route, or a logged-in user hitting login); it must not
//    create a new history entry, otherwise Back walks back onto the very URL we just rejected and
//    re-trips the guard — a back-button trap (especially painful on Android's hardware Back, which
//    fires popstate on every press). RedirectCommand (Angular v16+) is the idiomatic way to attach
//    NavigationExtras — here `replaceUrl: true` — to a guard's UrlTree redirect.

// require auth — bounce to login if no refresh token
export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  return authService.isLoggedIn()
    ? true
    : new RedirectCommand(router.parseUrl('/auth/login'), { replaceUrl: true });
};

// require guest — bounce logged-in users away from login/register
export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  if (authService.isLoggedIn()) {
    return new RedirectCommand(router.parseUrl(''), { replaceUrl: true });
  }
  return true;
};

// Config detection (Tauri shell) — force the in-SPA server-config page until a SOMS backend has been
// configured. Queries the AUTHORITATIVE persisted origin via Rust's `is_origin_configured` (which checks
// the live origin Arc against the non-routable placeholder default), NOT the SPA's secureStore-seeded
// signal — the persisted file is the durable source the media proxy + native layer also read, and it can't
// drift from a bridge-read failure. The browser build is same-origin (never unconfigured), so this is a
// Tauri-only no-op. Runs BEFORE guestGuard on the auth routes.
export const configGuard: CanActivateFn = async () => {
  if (!isTauri()) return true;
  const router = inject(Router);
  // Authoritative "has a SOMS backend been configured?" — queries Rust's is_origin_configured (persisted
  // origin vs the non-routable placeholder), independent of the SPA's secureStore-seeded signal which can
  // drift. Browser build is same-origin (never unconfigured) so this is a Tauri-only no-op there.
  let configured = false;
  try {
    configured = await tauriInvoke<boolean>('is_origin_configured');
  } catch {
    configured = false;
  }
  if (!configured) {
    return new RedirectCommand(router.parseUrl('/config'), { replaceUrl: true });
  }
  // Self-heal (existing installs): if Rust has a configured origin but the SPA signal is empty (secureStore
  // drifted — e.g. a pre-merge configure wrote Rust but not secureStore), sync it so HttpClient/SSE reach
  // the backend without a manual reconfigure.
  if (apiOriginIsEmpty()) {
    try {
      const origin = await tauriInvoke<string>('get_api_origin');
      if (origin) syncApiOriginSignal(origin);
    } catch {
      /* leave as-is — the user can reconfigure from /config */
    }
  }
  return true;
};

// require registration open — bounce /auth/register to login when self-registration is closed. Awaits the
// public config load (idempotent, never throws); when registrationOpen is not confirmed true (closed, still
// loading, or load failed) the register page is unreachable by direct navigation.
export const registrationOpenGuard: CanActivateFn = async () => {
  const config = inject(ConfigService);
  await config.ensureLoaded();
  if (config.registrationOpen() === true) return true;
  const router = inject(Router);
  return new RedirectCommand(router.parseUrl('/auth/login'), { replaceUrl: true });
};
