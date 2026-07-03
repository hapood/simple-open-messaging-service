import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ChatEmptyComponent } from './components/chat-empty/chat-empty.component';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import { ChatboxPlaygroundComponent } from './pages/chatbox-playground/chatbox-playground.component';
import { authGuard, guestGuard } from './auth.guard';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    canActivate: [authGuard],
    // Guards don't inherit to children — re-protect the chat / aside child routes.
    canActivateChild: [authGuard],
    children: [
      // No chat selected: branded placeholder (desktop/tablet inline slot; mobile hides the overlay).
      { path: '', component: ChatEmptyComponent },
      {
        // The open chat (primary outlet). :threadId binds to ChatPane's input via withComponentInputBinding.
        // loadComponent keeps the chat kernel + its components out of the initial bundle.
        path: 'chat/:threadId',
        loadComponent: () =>
          import('./components/desktop/chat-pane/chat-pane.component').then((m) => m.ChatPaneComponent),
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
  { path: 'playground/chatbox-a', component: ChatboxPlaygroundComponent, data: { useNativeAnchor: true } },
  { path: 'playground/chatbox-b', component: ChatboxPlaygroundComponent },
  { path: '**', component: PageNotFoundComponent },
];
