import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { OverlayModule } from '@angular/cdk/overlay';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { ChatActionMenuComponent, type ChatMenuEntry } from '../chat-action-menu/chat-action-menu.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

/**
 * Compact/medium chat-list top bar: profile avatar on the left; friend requests and overflow actions
 * on the right. Expanded uses the icon rail instead of duplicating this navigation.
 */
@Component({
  selector: 'app-home-header',
  imports: [OverlayModule, IconComponent, UserAvatarComponent, ChatActionMenuComponent, TranslocoPipe],
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

  readonly friendReqBadge = this.userService.friendReqBadge
  readonly sessionProfile = this.userService.sessionProfile
  readonly moreMenuOpen = signal(false)

  /** Icon reflecting the current theme mode (system/light/dark). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode()
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON
  })

  readonly moreEntries = computed<ChatMenuEntry[]>(() => [
    { kind: 'action', key: 'newGroup', labelKey: 'nav.newGroup', icon: AppIconType.NEW_GROUP },
    { kind: 'action', key: 'folders', labelKey: 'nav.folders', icon: AppIconType.FOLDERS },
    { kind: 'action', key: 'theme', labelKey: 'nav.themeLabel', icon: this.themeIcon() },
    { kind: 'action', key: 'settings', labelKey: 'nav.settings', icon: AppIconType.SETTINGS },
  ])

  openProfile() { this.routeService.openProfile() }
  openFriendRequests() { this.routeService.popupDlg(PopupType.FRIEND_REQUESTS) }
  toggleMoreMenu() { this.moreMenuOpen.update((open) => !open) }
  closeMoreMenu() { this.moreMenuOpen.set(false) }

  onSelect(key: string) {
    switch (key) {
      case 'settings':
        this.routeService.openSettings()
        this.closeMoreMenu()
        break
      case 'newGroup':
        this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (r) => { if (r) this.onThreadListChanged()?.() })
        this.closeMoreMenu()
        break
      case 'folders':
        this.routeService.popupDlg(PopupType.FOLDER_EDITOR)
        this.closeMoreMenu()
        break
      case 'theme':
        // Keep the menu open so the icon flips visibly to the new mode.
        this.themeService.cycleMode()
        break
    }
  }
}
