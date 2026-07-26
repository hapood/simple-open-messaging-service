import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { OverlayModule } from '@angular/cdk/overlay';
import { AppIconType } from '../icon/icon.component';
import { ChatActionMenuComponent, type ChatMenuEntry } from '../chat-action-menu/chat-action-menu.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

/**
 * Mobile/tablet chat-list top bar: SOMS title + the current user's square avatar. The avatar opens the
 * account/action menu (profile / settings / friend requests / new group / folders / theme), replacing the
 * old floating bottom navigation. It carries the friend-request badge and anchors the shared action menu.
 */
@Component({
  selector: 'app-home-header',
  imports: [OverlayModule, UserAvatarComponent, ChatActionMenuComponent, TranslocoPipe],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss',
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
  readonly UserAvatarType = UserAvatarType
  /** Fired after a group is created so the parent refreshes the thread list (forwarded from the shell). */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)

  private readonly routeService = inject(RouteService)
  private readonly userService = inject(UserService)
  private readonly themeService = inject(ThemeService)
  private readonly nav = inject(NavStateMachineService)

  readonly friendReqBadge = this.userService.friendReqBadge
  readonly sessionProfile = this.userService.sessionProfile
  readonly menuOpen = signal(false)

  /** Icon reflecting the current theme mode (system/light/dark). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode()
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON
  })

  readonly entries = computed<ChatMenuEntry[]>(() => [
    { kind: 'action', key: 'profile', labelKey: 'nav.editProfileAria' },
    { kind: 'action', key: 'settings', labelKey: 'nav.settings', icon: AppIconType.SETTINGS },
    { kind: 'divider' },
    { kind: 'action', key: 'friendRequests', labelKey: 'nav.friendRequests', icon: AppIconType.FRIEND_REQUESTS },
    { kind: 'action', key: 'newGroup', labelKey: 'nav.newGroup', icon: AppIconType.NEW_GROUP },
    { kind: 'action', key: 'folders', labelKey: 'nav.folders', icon: AppIconType.FOLDERS },
    { kind: 'divider' },
    { kind: 'action', key: 'theme', labelKey: 'nav.themeLabel', icon: this.themeIcon() },
  ])

  toggleMenu() { this.menuOpen.update((v) => !v) }
  closeMenu() { this.menuOpen.set(false) }

  onSelect(key: string) {
    switch (key) {
      case 'profile':
        this.nav.setTopSection('profile')
        this.closeMenu()
        break
      case 'settings':
        this.routeService.openSettings()
        this.closeMenu()
        break
      case 'friendRequests':
        this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
        this.closeMenu()
        break
      case 'newGroup':
        this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (r) => { if (r) this.onThreadListChanged()?.() })
        this.closeMenu()
        break
      case 'folders':
        this.routeService.popupDlg(PopupType.FOLDER_EDITOR)
        this.closeMenu()
        break
      case 'theme':
        // Keep the menu open so the icon flips visibly to the new mode.
        this.themeService.cycleMode()
        break
    }
  }
}
