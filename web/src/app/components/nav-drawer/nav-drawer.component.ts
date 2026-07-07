import { Component, input, output, inject, viewChild, computed, effect } from '@angular/core';
import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { SearchService } from '../../services/search.service';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';
import { NavStateMachineService } from '../../services/nav-state.service';

/**
 * Left navigation drawer — a shell-level overlay (host is position:fixed; see the SCSS), NOT a
 * wrapper around the thread list. Rendering only the mat-sidenav panel + its backdrop at the shell
 * level makes the backdrop span the full viewport (covering the inline chat too), instead of being
 * scoped to the thread-list column as it was when the list was projected into mat-sidenav-content.
 * mode=over still gives backdrop-click close, ESC close, focus trap, and the slide animation. The
 * thread list itself is a plain sibling column owned by HomeShellComponent.
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
  /** Emits when the drawer opens/closes (so the parent can react, e.g. close the search box). Fires
   *  at the end of the open/close animation — Material's `openedChange` semantics. */
  readonly drawerOpenChange = output<boolean>()

  private readonly sidenav = viewChild(MatSidenav)
  private readonly routeService = inject(RouteService)
  readonly userService = inject(UserService)
  private readonly searchService = inject(SearchService)
  private readonly themeService = inject(ThemeService)
  private readonly languageService = inject(LanguageService)
  private readonly transloco = inject(TranslocoService)
  private readonly nav = inject(NavStateMachineService)

  readonly sessionProfile = this.userService.sessionProfile

  constructor() {
    // Close when a chat opens (state machine) — mode=over is a covering drawer, so leaving it open would
    // occlude the chat the user just opened from the inline list. (Replaces the old router NavigationEnd
    // subscription: app nav no longer goes through the router.) The menu actions below call close()
    // themselves before opening a pane.
    effect(() => {
      const tid = this.nav.chatThreadId();
      console.log('[DRAWER-DBG] effect run; chatThreadId=', tid)
      this.close();
    });
  }

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

  toggle() {
    // TEMP debug — locate where the hamburger→drawer chain breaks. Remove once diagnosed.
    const sv = this.sidenav()
    console.log('[DRAWER-DBG] toggle(); sidenav=', sv)
    const p = sv?.toggle()
    console.log('[DRAWER-DBG] toggle() returned:', p)
    p?.then(
      (r) => console.log('[DRAWER-DBG] toggle PROMISE resolved:', r),
      (e) => console.error('[DRAWER-DBG] toggle PROMISE rejected:', e),
    )
  }
  close() {
    console.log('[DRAWER-DBG] close() called')
    this.sidenav()?.close()
  }

  // TEMP debug.
  onOpenedChange(open: boolean): void {
    console.log('[DRAWER-DBG] mat-sidenav openedChange:', open)
    this.drawerOpenChange.emit(open)
  }

  editProfile() {
    this.close()
    this.routeService.popupDlg(PopupType.EDIT_PROFILE)
  }

  // Each menu action first closes the drawer, then triggers its popup/navigation (logic migrated from the old home-header.clickMenu).
  search() {
    this.close()
    this.searchService.open()
  }

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

  /** Open the Settings page in the aside slot (same surface profile / group-info use). */
  settings() {
    this.close()
    this.nav.openAside('settings')
  }
}
