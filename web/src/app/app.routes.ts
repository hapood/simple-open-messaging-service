import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import {
  authGuard,
  configGuard,
  guestGuard,
  registrationOpenGuard,
} from './auth.guard';
import { isTauri } from './services/runtime';

export const routes: Routes = [
  // App shell. NavStateMachineService drives chat/aside state — there are NO app-nav child routes and NO
  // router-outlets in the shell (ChatPane is always-mounted; the aside is a @switch on nav.aside()). Both
  // `/` and `/chat/:threadId` render the same shell so cold-load / refresh / deep-link match a route
  // (otherwise they'd fall through to `**` → 404); the state machine reads the URL once at boot
  // during navigation-service construction and mirrors it back via replaceState. The aside panel is session-state, not routed.
  { path: '', component: HomeComponent, canActivate: [authGuard] },
  {
    path: 'chat/:threadId',
    component: HomeComponent,
    canActivate: [authGuard],
  },
  {
    path: 'auth/login',
    component: LoginPageComponent,
    canActivate: [configGuard, guestGuard],
  },
  {
    path: 'auth/register',
    component: RegisterPageComponent,
    canActivate: [configGuard, guestGuard, registrationOpenGuard],
  },
  // Unified login handles password, OTP, and QR modes in a single surface. Legacy routes redirect to it.
  {
    path: 'auth/otp',
    redirectTo: 'auth/login',
    pathMatch: 'full',
  },
  {
    path: 'auth/qr',
    redirectTo: 'auth/login',
    pathMatch: 'full',
  },
  // Forced set-own-password — reached proactively after any login whose session is still on the admin-
  // generated initial password (the backend gates every other route until this clears it). A POST-login
  // screen: guarded by `authGuard` (requires a live session), NOT `guestGuard` (which would bounce the
  // just-logged-in user to home). No platform gate — reachable from the OTP (Android) and password/QR
  // (desktop/web) flows alike.
  {
    path: 'auth/set-password',
    loadComponent: () =>
      import('./pages/set-password-page/set-password-page.component').then(
        (m) => m.SetPasswordPageComponent,
      ),
    canActivate: [authGuard],
  },
  // Backend-URL configuration (Tauri shell only) — first-run setup + reconfigure. Now an in-SPA route
  // (the former bundled shell-config bootstrap + the somsapp:// scheme are eliminated). Platform-gated:
  // the browser build is same-origin (no configurable origin), so /config 404s there.
  {
    path: 'config',
    loadComponent: () =>
      import('./pages/server-config-page/server-config-page.component').then(
        (m) => m.ServerConfigPageComponent,
      ),
    canMatch: [() => isTauri()],
  },
  {
    path: 'effects',
    loadComponent: () =>
      import('../playground/effects/effects-page.component').then(
        (m) => m.EffectsPageComponent,
      ),
  },
  { path: 'forbidden', component: ForbiddenPageComponent },
  { path: '**', component: PageNotFoundComponent },
];
