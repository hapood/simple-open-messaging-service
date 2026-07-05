import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand } from '@angular/router';
import { Router } from '@angular/router';
import { AuthService } from './services/auth.service';

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
  return authService.isLoggedIn()
    ? new RedirectCommand(router.parseUrl(''), { replaceUrl: true })
    : true;
};
