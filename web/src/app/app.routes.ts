import { Routes } from '@angular/router';
import { UserManageComponent } from './pages/server-manage/user-manage/user-manage.component';
import { LoginComponent } from './pages/auth/login/login.component';
import { MyFriendsComponent } from './pages/relation/my-firends/my-friends.component';
import { ThreadListComponent } from './pages/home/thread-list/thread-list.component';
import { FriendMessageComponent } from './pages/message/friend-message/friend-message.component';

export const routes: Routes = [
  { path: "user-manage", component: UserManageComponent },
  { path: "login", component: LoginComponent },
  { path: "my-friends", component: MyFriendsComponent },
  { path: "thread-list", component: ThreadListComponent },
  { path: "friend-message/:id", component: FriendMessageComponent }
];
