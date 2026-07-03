import { Component, input, output, inject, viewChild, computed } from '@angular/core';
import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { RouteService, RoutePage, PopupType } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';

/**
 * Left navigation drawer: mat-sidenav(mode=over) + avatar/user-name + action items.
 * Replaces the home-header's hand-written material-menu. The over mode ships
 * backdrop-click close, ESC close, focus trap, and slide animation — fixing every
 * shortcoming of the old dropdown at once. Main content is projected via
 * <ng-content> into mat-sidenav-content, so mobile/tablet-home wrap their content
 * in <app-nav-drawer>.
 */
@Component({
  selector: 'app-nav-drawer',
  imports: [MatSidenavModule, UserAvatarComponent, IconComponent],
  templateUrl: './nav-drawer.component.html',
  styleUrl: './nav-drawer.component.scss',
})
export class NavDrawerComponent {
  readonly UserAvatarType = UserAvatarType
  readonly AppIconType = AppIconType
  /** Callback to refresh the list after a group is created (forwarded from the parent). */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)
  /** Emits when the drawer opens/closes (so the parent can react, e.g. close the search box). */
  readonly drawerOpenChange = output<boolean>()

  private readonly sidenav = viewChild(MatSidenav)
  private readonly routeService = inject(RouteService)
  private readonly authService = inject(AuthService)
  private readonly wsService = inject(WebsocketService)
  readonly userService = inject(UserService)
  private readonly themeService = inject(ThemeService)

  readonly sessionProfile = this.userService.sessionProfile

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON;
  });
  /** Human label for the current mode, shown as the row text. */
  readonly themeLabel = computed(() => {
    const m = this.themeService.mode();
    return m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark';
  });
  /** Cycle theme without closing the drawer, so the change is visible and re-toggleable. */
  cycleTheme(): void { this.themeService.cycleMode(); }

  toggle() { this.sidenav()?.toggle() }
  close() { this.sidenav()?.close() }

  editProfile() {
    this.close()
    this.routeService.popupDlg(PopupType.EDIT_PROFILE)
  }

  // Each menu action first closes the drawer, then triggers its popup/navigation (logic migrated from the old home-header.clickMenu).
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
    // Disconnect the WS first, then clear credentials + go to the login page (logout already calls clearToken
    // internally, so the login redirect happens whether or not backend revocation succeeds).
    this.close()
    this.wsService.disconnect()
    this.authService.logout().subscribe({
      complete: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
      error: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
    })
  }
}
