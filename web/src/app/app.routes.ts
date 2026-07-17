import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import { authGuard, guestGuard, registrationOpenGuard } from './auth.guard';
import { isAndroidNative } from './services/runtime';
import { devRoutes } from './dev-tools';

export const routes: Routes = [
  // App shell. NavStateMachineService drives chat/aside state — there are NO app-nav child routes and NO
  // router-outlets in the shell (ChatPane is always-mounted; the aside is a @switch on nav.aside()). Both
  // `/` and `/chat/:threadId` render the same shell so cold-load / refresh / deep-link match a route
  // (otherwise they'd fall through to `**` → 404); the state machine reads the URL once at boot
  // (initFromUrl) and mirrors it back via replaceState. The aside panel is session-state, not routed.
  { path: '', component: HomeComponent, canActivate: [authGuard] },
  { path: 'chat/:threadId', component: HomeComponent, canActivate: [authGuard] },
  { path: 'nav', component: PageNavgatorComponent, canActivate: [authGuard] },
  { path: 'auth/login', component: LoginPageComponent, canActivate: [guestGuard] },
  { path: 'auth/register', component: RegisterPageComponent, canActivate: [guestGuard, registrationOpenGuard] },
  // One-time-code login — Android only (the long-term app-session method). Reached automatically from
  // /auth/login under APP_OTP_AND_QR mode; the route is platform-gated so it 404s off the Android build.
  {
    path: 'auth/otp',
    loadComponent: () => import('./pages/otp-login-page/otp-login-page.component').then((m) => m.OtpLoginPageComponent),
    canActivate: [guestGuard],
    canMatch: [() => isAndroidNative()],
  },
  // QR-scan login — desktop/web only (the 2-week sliding-session method, confirmed by a logged-in phone).
  {
    path: 'auth/qr',
    loadComponent: () => import('./pages/qr-login-page/qr-login-page.component').then((m) => m.QrLoginPageComponent),
    canActivate: [guestGuard],
    canMatch: [() => !isAndroidNative()],
  },
  // Forced set-own-password — reached proactively after any login whose session is still on the admin-
  // generated initial password (the backend gates every other route until this clears it). A POST-login
  // screen: guarded by `authGuard` (requires a live session), NOT `guestGuard` (which would bounce the
  // just-logged-in user to home). No platform gate — reachable from the OTP (Android) and password/QR
  // (desktop/web) flows alike.
  {
    path: 'auth/set-password',
    loadComponent: () => import('./pages/set-password-page/set-password-page.component').then((m) => m.SetPasswordPageComponent),
    canActivate: [authGuard],
  },
  // Backend-URL configuration in the Tauri shell now lives in the bundled `init` window (shell-config
  // bootstrap), opened by Rust on first run + by the login page's "Configure server" button — NOT an
  // in-SPA route. The browser build is same-origin (no configurable origin). So there is no /config route.
  { path: 'forbidden', component: ForbiddenPageComponent },
  // Dev-only routes (chatbox playground rig) come from dev-tools.ts, which the prod build swaps for
  // dev-tools.prod.ts (empty devRoutes) — so the playground chunk is not emitted in prod. See dev-tools.ts.
  ...devRoutes,
  { path: '**', component: PageNotFoundComponent },
];
