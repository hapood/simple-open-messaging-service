import { Component, input, output, inject, viewChild, computed } from '@angular/core';
import { Router } from '@angular/router';
import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';

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
  imports: [MatSidenavModule, UserAvatarComponent, IconComponent, TranslocoPipe],
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
  readonly userService = inject(UserService)
  private readonly themeService = inject(ThemeService)
  private readonly languageService = inject(LanguageService)
  private readonly transloco = inject(TranslocoService)
  private readonly router = inject(Router)

  readonly sessionProfile = this.userService.sessionProfile

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

  /** Native-script label for the current language (always self-identifies). */
  readonly langLabel = this.languageService.langLabel;
  /** Cycle language without closing the drawer, so the change is visible and re-toggleable. */
  cycleLang(): void { this.languageService.cycleLang(); }

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

  /** Open the Settings page in the aside outlet (same surface profile / group-info use). */
  settings() {
    this.close()
    void this.router.navigate([{ outlets: { aside: ['settings'] } }])
  }
}
