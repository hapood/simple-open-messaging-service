import { Component, input, inject, computed } from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { LayoutService } from '../../services/layout.service';

/**
 * Left navigation drawer — a shell-level overlay (host is position:fixed; see the SCSS), NOT a
 * wrapper around the thread list. Rendering only the mat-sidenav panel + its backdrop at the shell
 * level makes the backdrop span the full viewport (covering the inline chat too), instead of being
 * scoped to the thread-list column as it was when the list was projected into mat-sidenav-content.
 * mode=over still gives backdrop-click close, ESC close, focus trap, and the slide animation. The
 * thread list itself is a plain sibling column owned by HomeShellComponent.
 *
 * The drawer's open state is owned by {@link NavStateMachineService.drawerOpen}, NOT inside MatSidenav,
 * so the Android hardware-back handler (`NavStateMachineService.back`) peels it (closes the drawer)
 * instead of exiting the app. The mat-sidenav is a controlled component: `[opened]` reads the signal,
 * `(openedChange)` writes it back, so MatSidenav's own backdrop-click/ESC closes stay in sync.
 */
@Component({
  selector: 'app-nav-drawer',
  imports: [MatSidenavModule, UserAvatarComponent, IconComponent, TranslocoPipe],
  templateUrl: './nav-drawer.component.html',
  styleUrl: './nav-drawer.component.scss',
})
export class NavDrawerComponent {
  readonly UserAvatarType = UserAvatarType
  readonly AppIconType = AppIconType
  /** Callback to refresh the list after a group is created (forwarded from the parent). */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)

  private readonly routeService = inject(RouteService)
  readonly userService = inject(UserService)
  private readonly themeService = inject(ThemeService)
  private readonly languageService = inject(LanguageService)
  private readonly transloco = inject(TranslocoService)
  private readonly nav = inject(NavStateMachineService)
  private readonly layout = inject(LayoutService)

  readonly sessionProfile = this.userService.sessionProfile
  readonly friendReqBadge = this.userService.friendReqBadge
  /** The drawer's open state — sourced from {@link NavStateMachineService} so hardware-back can close
   *  the drawer. Bound two-way to the mat-sidenav (`[opened]` reads, `(openedChange)` writes). */
  readonly drawerOpen = this.nav.drawerOpen

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON;
  });
  /** Human label for the current theme mode, shown as the row text. Reads the language
   *  signal so it re-evaluates when the user switches languages. */
  readonly themeLabel = computed(() => {
    this.languageService.lang();
    return this.transloco.translate('nav.theme.' + this.themeService.mode());
  });
  /** Cycle theme without closing the drawer, so the change is visible and re-toggleable. */
  cycleTheme(): void { this.themeService.cycleMode(); }

  toggle() { this.nav.toggleDrawer() }
  close() { this.nav.closeDrawer() }

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

  /** Open Settings: the aside (drill-in) on mobile, or a wide two-column dialog on tablet. The drawer
   *  closes first either way. Desktop opens the same dialog from the icon-rail. */
  settings() {
    this.close()
    if (this.layout.mode() === 'mobile') this.nav.openAside('settings')
    else this.routeService.openSettingsDialog()
  }
}
