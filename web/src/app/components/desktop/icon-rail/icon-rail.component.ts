import { Component, inject, input } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { RouteService, RoutePage, PopupType } from '../../../services/route.service';
import { AuthService } from '../../../services/auth.service';
import { UserService } from '../../../services/user.service';
import { WebsocketService } from '../../../services/websocket.service';

/**
 * Telegram-style left rail: account avatar on top, section/action buttons at
 * the bottom. Replaces the mobile home-header hamburger menu on desktop.
 */
@Component({
  selector: 'app-icon-rail',
  imports: [UserAvatarComponent],
  template: `
    <div class="icon-rail">
      <div class="top">
        <button class="rail-btn avatar" (click)="editProfile()" title="编辑资料" aria-label="edit profile">
          <app-user-avatar [type]="UserAvatarType.SELF" [name]="sessionProfile()?.uniqName || 'SOMS'"
            [src]="sessionProfile()?.userExtra?.avatar" />
        </button>
      </div>
      <div class="bottom">
        <button class="rail-btn" (click)="friendRequests()" title="好友请求" aria-label="friend requests">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          @if (sessionProfile()?.userNotiBox?.hasUrFriendReq) {
            <span class="friend-badge" aria-label="new friend requests"></span>
          }
        </button>
        <button class="rail-btn" (click)="newGroup()" title="新建群组" aria-label="new group">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v8M8 12h8"/>
          </svg>
        </button>
        <button class="rail-btn" (click)="folderEditor()" title="文件夹" aria-label="folders">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </button>
        <button class="rail-btn" (click)="logout()" title="登出" aria-label="logout">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <path d="M16 17l5-5-5-5"/>
            <path d="M21 12H9"/>
          </svg>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .icon-rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      width: 68px;
      height: 100%;
      padding: 12px 0;
      background: var(--app-bg-muted);
      border-right: 1px solid var(--app-border);
      box-sizing: border-box;
    }
    .rail-btn {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      margin: 4px 0;
      padding: 0;
      border: none;
      border-radius: var(--app-radius-pill);
      background: transparent;
      color: var(--app-text);
      cursor: pointer;
    }
    .rail-btn:hover { background: var(--app-hover); }
    .friend-badge {
      position: absolute;
      top: 7px;
      right: 7px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #e53935;
      border: 2px solid var(--app-bg-muted);
    }
    .avatar { margin-bottom: 8px; border-radius: 8px; overflow: hidden; }
  `]
})
export class IconRailComponent {
  readonly UserAvatarType = UserAvatarType
  /** fired after a group is created so the parent can refresh the thread list */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)

  private readonly routeService = inject(RouteService);
  private readonly authService = inject(AuthService);
  private readonly userService = inject(UserService);
  private readonly wsService = inject(WebsocketService);
  /** 当前登录用户资料（供 SELF 头像取首字）。 */
  readonly sessionProfile = this.userService.sessionProfile

  friendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  editProfile() {
    this.routeService.popupDlg(PopupType.EDIT_PROFILE)
  }

  newGroup() {
    this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, result => {
      // only refresh when a group was actually created, not on cancel/back
      if (result) this.onThreadListChanged()?.()
    })
  }

  folderEditor() {
    this.routeService.popupDlg(PopupType.FOLDER_EDITOR)
  }

  logout() {
    // 先断 WS，再清凭据 + 跳登录页（logout 内部已 clearToken，故后端吊销成败都跳登录）
    this.wsService.disconnect();
    this.authService.logout().subscribe({
      complete: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
      error: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
    })
  }
}
