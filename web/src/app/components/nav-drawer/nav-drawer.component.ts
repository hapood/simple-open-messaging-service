import { Component, input, output, inject, viewChild } from '@angular/core';
import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { RouteService, RoutePage, PopupType } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { UserService } from '../../services/user.service';

/**
 * 左侧导航抽屉：mat-sidenav(mode=over) + 头像/用户名 + 4 个操作项。
 * 替代 home-header 的手写 material-menu。over 模式自带 backdrop 点击关闭、ESC 关闭、
 * focus trap、滑出动画——一次性解决原下拉的所有短板。主内容经 <ng-content> 投影到
 * mat-sidenav-content，供 mobile/tablet-home 用 <app-nav-drawer> 包裹各自内容。
 */
@Component({
  selector: 'app-nav-drawer',
  imports: [MatSidenavModule, UserAvatarComponent],
  templateUrl: './nav-drawer.component.html',
  styleUrl: './nav-drawer.component.scss',
})
export class NavDrawerComponent {
  readonly UserAvatarType = UserAvatarType
  /** 新建群组成功后刷新列表的回调（透传自父） */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)
  /** 抽屉打开变化（供父组件联动，如关闭搜索框） */
  readonly drawerOpenChange = output<boolean>()

  private readonly sidenav = viewChild(MatSidenav)
  private readonly routeService = inject(RouteService)
  private readonly authService = inject(AuthService)
  private readonly wsService = inject(WebsocketService)
  readonly userService = inject(UserService)

  readonly sessionProfile = this.userService.sessionProfile

  toggle() { this.sidenav()?.toggle() }
  close() { this.sidenav()?.close() }

  editProfile() {
    this.close()
    this.routeService.popupDlg(PopupType.EDIT_PROFILE)
  }

  // 每个菜单动作先关抽屉，再触发对应弹窗/跳转（逻辑迁自原 home-header.clickMenu）
  friendRequests() {
    this.close()
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  newGroup() {
    this.close()
    this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, result => {
      // only refresh when a group was actually created, not on cancel/back
      if (result) this.onThreadListChanged()?.()
    })
  }

  folderEditor() {
    this.close()
    this.routeService.popupDlg(PopupType.FOLDER_EDITOR)
  }

  logout() {
    // 先断 WS，再清凭据 + 跳登录页（logout 内部已 clearToken，后端吊销成败都跳登录）
    this.close()
    this.wsService.disconnect()
    this.authService.logout().subscribe({
      complete: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
      error: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
    })
  }
}
