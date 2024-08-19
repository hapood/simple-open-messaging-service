import { Routes } from '@angular/router';
import { UserManagementComponent } from './user-management/user-management.component';
import { UserLoginComponent } from './user-login/user-login.component';
import { UserAddFriendComponent } from './user-add-friend/user-add-friend.component';
import { ChatThreadListComponent } from './chat-thread-list/chat-thread-list.component';
import { ChatThreadComponent } from './chat-thread/chat-thread.component';

export const routes: Routes = [
  { path: "user-management", component: UserManagementComponent },
  { path: "login", component: UserLoginComponent },
  { path: "add-friend", component: UserAddFriendComponent },
  { path: "chat-thread-list", component: ChatThreadListComponent },
  { path: "chat-thread/:id", component: ChatThreadComponent }
];
