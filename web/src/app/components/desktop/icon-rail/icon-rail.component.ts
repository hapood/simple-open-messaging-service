import { Component, inject, input, computed } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../../icon/icon.component';
import { RouteService, PopupType } from '../../../services/route.service';
import { UserService } from '../../../services/user.service';
import { ThemeService } from '../../../services/theme.service';
import { LanguageService } from '../../../services/language.service';

/**
 * Telegram-style left rail: account avatar on top, section/action buttons at
 * the bottom. Replaces the mobile home-header hamburger menu on desktop. Mirrors
 * <app-nav-drawer>: same actions (friend requests / new group / folders / theme /
 * language), exposed as icon-only buttons with translated tooltips. Log out lives
 * in the profile dialog (PopupType.EDIT_PROFILE), not the rail.
 */
@Component({
  selector: 'app-icon-rail',
  imports: [UserAvatarComponent, IconComponent, TranslocoPipe],
  template: `
    <div class="icon-rail">
      <div class="top">
        <button class="rail-btn avatar" (click)="editProfile()"
          [title]="'nav.editProfileAria' | transloco" [attr.aria-label]="'nav.editProfileAria' | transloco">
          <app-user-avatar [type]="UserAvatarType.SELF" [name]="sessionProfile()?.uniqName || 'SOMS'"
            [src]="sessionProfile()?.userExtra?.avatar" />
        </button>
      </div>
      <div class="bottom">
        <button class="rail-btn" (click)="friendRequests()"
          [title]="'nav.friendRequests' | transloco" [attr.aria-label]="'nav.friendRequests' | transloco">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
          @if (sessionProfile()?.userNotiBox?.hasUrFriendReq) {
            <span class="friend-badge" [attr.aria-label]="'nav.newFriendRequestsAria' | transloco"></span>
          }
        </button>
        <button class="rail-btn" (click)="newGroup()"
          [title]="'nav.newGroup' | transloco" [attr.aria-label]="'nav.newGroup' | transloco">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </button>
        <button class="rail-btn" (click)="folderEditor()"
          [title]="'nav.folders' | transloco" [attr.aria-label]="'nav.folders' | transloco">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </button>
        <button class="rail-btn" (click)="cycleTheme()"
          [title]="'nav.themeAria' | transloco:{ label: themeLabel() }"
          [attr.aria-label]="'nav.themeAria' | transloco:{ label: themeLabel() }">
          <app-icon [type]="themeIcon()" [style]="{ width: '24px', height: '24px' }"></app-icon>
        </button>
        <button class="rail-btn" (click)="cycleLang()"
          [title]="'nav.languageAria' | transloco:{ label: langLabel() }"
          [attr.aria-label]="'nav.languageAria' | transloco:{ label: langLabel() }">
          <app-icon [type]="AppIconType.GLOBE" [style]="{ width: '24px', height: '24px' }"></app-icon>
        </button>
        <button class="rail-btn" (click)="settings()"
          [title]="'nav.settings' | transloco" [attr.aria-label]="'nav.settings' | transloco">
          <app-icon [type]="AppIconType.SETTINGS" [style]="{ width: '24px', height: '24px' }"></app-icon>
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
  readonly AppIconType = AppIconType
  /** fired after a group is created so the parent can refresh the thread list */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined)

  private readonly routeService = inject(RouteService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly transloco = inject(TranslocoService);
  private readonly router = inject(Router);
  /** Current logged-in profile (used for the SELF avatar's initial). */
  readonly sessionProfile = this.userService.sessionProfile

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON;
  });
  /** Human label for the current theme mode (tooltip). Reads the language signal so it re-evaluates
   *  on a language switch. */
  readonly themeLabel = computed(() => {
    this.languageService.lang();
    return this.transloco.translate('nav.theme.' + this.themeService.mode());
  });
  cycleTheme(): void { this.themeService.cycleMode(); }

  /** Native-script label for the current language (always self-identifies). */
  readonly langLabel = this.languageService.langLabel;
  cycleLang(): void { this.languageService.cycleLang(); }

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

  /** Open the Settings page in the aside outlet (same surface profile / group-info use). */
  settings(): void {
    void this.router.navigate([{ outlets: { aside: ['settings'] } }])
  }
}
