import { Routes } from '@angular/router';
import { UserManageComponent } from './pages/server-manage/user-manage/user-manage.component';
import { LoginPageComponent } from './pages/auth/login/login-page.component';
import { MyFriendsComponent } from './pages/relation/my-firends/my-friends.component';
import { ThreadListComponent } from './pages/home/thread-list/thread-list.component';
import { FriendMessageComponent } from './pages/message/friend-message/friend-message.component';
import { PageNotFoundComponent } from './pages/home/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/home/page-navgator/page-navgator.component';
import { ForbiddenComponent } from './pages/auth/forbidden/forbidden.component';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: "", component: PageNavgatorComponent },
  { path: "login", component: LoginPageComponent },
  { path: "user-manage", component: UserManageComponent, canActivate: [authGuard] },
  { path: "my-friends", component: MyFriendsComponent, canActivate: [authGuard] },
  { path: "thread-list", component: ThreadListComponent, canActivate: [authGuard] },
  { path: "friend-message/:threadId", component: FriendMessageComponent, canActivate: [authGuard] },
  { path: "friend-message/:threadId/:startMsgId", component: FriendMessageComponent, canActivate: [authGuard] },
  { path: 'forbidden', component: ForbiddenComponent },
  { path: '**', component: PageNotFoundComponent }
];
