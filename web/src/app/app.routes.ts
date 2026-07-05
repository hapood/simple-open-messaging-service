import { Routes } from '@angular/router';
import { isDevMode } from '@angular/core';
import { HomeComponent } from './pages/home/home.component';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import { authGuard, guestGuard } from './auth.guard';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    canActivate: [authGuard],
    // Guards don't inherit to children — re-protect the chat / aside child routes.
    canActivateChild: [authGuard],
    children: [
      // Both children render ChatPane. ChatReuseStrategy (see app.config) reuses the SAME instance across
      // `''` ↔ `chat/:threadId`, so the chat surface is effectively always-mounted: navigating list ↔ chat
      // never remounts the kernel. ChatPane reads ConversationListService.openThreadId (synced from the URL
      // by the home shell, lagged on mobile close so the real chat slides out before its data resets) and
      // renders the thread, the deep-link loading state, or ChatEmpty when idle.
      {
        path: '',
        loadComponent: () => import('./components/desktop/chat-pane/chat-pane.component').then((m) => m.ChatPaneComponent),
      },
      {
        path: 'chat/:threadId',
        loadComponent: () => import('./components/desktop/chat-pane/chat-pane.component').then((m) => m.ChatPaneComponent),
      },
      // The profile / group-info panels target the `aside` auxiliary outlet (siblings of the chat route,
      // so the outlet lives in the home shell alongside the primary one). The active conversation is read
      // from ConversationListService.openThreadId, so no :threadId needs to be duplicated into these paths.
      {
        path: 'profile',
        outlet: 'aside',
        loadComponent: () =>
          import('./components/peer-profile/peer-profile.component').then((m) => m.PeerProfileComponent),
      },
      {
        path: 'group-info',
        outlet: 'aside',
        loadComponent: () =>
          import('./components/group-info/group-info.component').then((m) => m.GroupInfoComponent),
      },
    ],
  },
  { path: 'nav', component: PageNavgatorComponent, canActivate: [authGuard] },
  { path: 'auth/login', component: LoginPageComponent, canActivate: [guestGuard] },
  { path: 'auth/register', component: RegisterPageComponent, canActivate: [guestGuard] },
  { path: 'forbidden', component: ForbiddenPageComponent },
  // Dev-only kernel test rig (count/latency/edge/threshold knobs driving the real chat kernel against MockItemSource).
  // Lazy `loadComponent` keeps the playground + MockItemSource out of the main bundle; `canMatch` isDevMode makes a
  // production build never match the route — a prod request for /playground/* falls through to '**' (404). Same
  // dynamic-import + isDevMode pattern used for eruda in main.ts.
  {
    path: 'playground/chatbox-a',
    loadComponent: () => import('./pages/chatbox-playground/chatbox-playground.component').then((m) => m.ChatboxPlaygroundComponent),
    canMatch: [() => isDevMode()],
    data: { useNativeAnchor: true },
  },
  {
    path: 'playground/chatbox-b',
    loadComponent: () => import('./pages/chatbox-playground/chatbox-playground.component').then((m) => m.ChatboxPlaygroundComponent),
    canMatch: [() => isDevMode()],
  },
  { path: '**', component: PageNotFoundComponent },
];
