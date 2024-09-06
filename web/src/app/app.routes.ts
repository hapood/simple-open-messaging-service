import { Routes } from '@angular/router';
import { LoginPageComponent } from './pages/auth/login/login-page.component';
import { MyFriendsComponent } from './pages/relation/my-firends/my-friends.component';
import { HomeComponent } from './pages/home/home.component';
import { MessageThreadComponent } from './components/message-thread/friend-message.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenComponent } from './pages/auth/forbidden/forbidden.component';

export const routes: Routes = [
  { path: "", component: HomeComponent },
  { path: "thread/:threadId", component: HomeComponent },
  { path: "nav", component: PageNavgatorComponent },
  { path: "login", component: LoginPageComponent },
  { path: "my-friends", component: MyFriendsComponent, },
  { path: "friend-message/:threadId", component: MessageThreadComponent, },
  { path: "friend-message/:threadId/:startMsgId", component: MessageThreadComponent, },
  { path: 'forbidden', component: ForbiddenComponent },
  { path: '**', component: PageNotFoundComponent }
];
