import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import { authGuard, guestGuard } from './auth.guard';
import { isTauri } from './services/runtime';
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
  { path: 'auth/register', component: RegisterPageComponent, canActivate: [guestGuard] },
  // Bundled-APK backend-URL configuration (Tauri/Android only). `canMatch` short-circuits to 404 in the
  // browser build, where the same-origin NestJS host makes a configurable origin meaningless. Reached
  // automatically on first run via guestGuard (when the origin is still the localhost default), and any
  // time later from the login page's "Server settings" link to re-point the app at a different backend.
  {
    path: 'config',
    loadComponent: () => import('./pages/server-config/server-config.component').then((m) => m.ServerConfigComponent),
    canMatch: [() => isTauri()],
  },
  { path: 'forbidden', component: ForbiddenPageComponent },
  // Dev-only routes (chatbox playground rig) come from dev-tools.ts, which the prod build swaps for
  // dev-tools.prod.ts (empty devRoutes) — so the playground chunk is not emitted in prod. See dev-tools.ts.
  ...devRoutes,
  { path: '**', component: PageNotFoundComponent },
];
