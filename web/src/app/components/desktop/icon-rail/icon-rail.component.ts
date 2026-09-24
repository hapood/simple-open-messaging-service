import {
  Component,
  inject,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../../icon/icon.component';
import { RouteService, PopupType } from '../../../services/route.service';
import { UserService } from '../../../services/user.service';
import { ThemeService } from '../../../services/theme.service';
import { LanguageService } from '../../../services/language.service';

/**
 * Telegram-style left rail (desktop): account avatar + navigation actions (friend requests / new group /
 * new-group) at the top, and the system controls (settings / theme) pinned to the bottom — mirroring
 * Telegram's drawer footer (Settings + night-mode toggle). Mobile/tablet reach these actions via the
 * account avatar menu (including the inline settings/profile sections); the rail is the desktop
 * equivalent, exposed as icon-only buttons with translated tooltips. Log out lives in the profile dialog
 * (PopupType.EDIT_PROFILE), not the rail.
 */
@Component({
  selector: 'app-icon-rail',
  imports: [UserAvatarComponent, IconComponent, TranslocoPipe],
  template: `
    <div class="icon-rail">
      <div class="top">
        <button
          class="rail-btn avatar"
          (click)="editProfile()"
          [title]="'nav.editProfileAria' | transloco"
          [attr.aria-label]="'nav.editProfileAria' | transloco"
        >
          <app-user-avatar
            [type]="UserAvatarType.SELF"
            [loading]="!sessionProfile()"
            [name]="$safeNavigationMigration(sessionProfile()?.name)"
          />
        </button>
        <button
          class="rail-btn"
          (click)="friendRequests()"
          [title]="'nav.friendRequests' | transloco"
          [attr.aria-label]="'nav.friendRequests' | transloco"
        >
          <app-icon
            [type]="AppIconType.FRIEND_REQUESTS"
            [style]="{ width: '24px', height: '24px' }"
          />
          @if (friendReqBadge()) {
            <span
              class="friend-badge"
              [attr.aria-label]="'nav.newFriendRequestsAria' | transloco"
            ></span>
          }
        </button>
        <button
          class="rail-btn"
          (click)="newGroup()"
          [title]="'nav.newGroup' | transloco"
          [attr.aria-label]="'nav.newGroup' | transloco"
        >
          <app-icon
            [type]="AppIconType.NEW_GROUP"
            [style]="{ width: '24px', height: '24px' }"
          />
        </button>
      </div>
      <div class="bottom">
        <button
          class="rail-btn"
          (click)="settings()"
          [title]="'nav.settings' | transloco"
          [attr.aria-label]="'nav.settings' | transloco"
        >
          <app-icon
            [type]="AppIconType.SETTINGS"
            [style]="{ width: '24px', height: '24px' }"
          ></app-icon>
        </button>
        <button
          class="rail-btn"
          (click)="cycleTheme()"
          [title]="'nav.themeAria' | transloco: { label: themeLabel() }"
          [attr.aria-label]="
            'nav.themeAria' | transloco: { label: themeLabel() }
          "
        >
          <app-icon
            [type]="themeIcon()"
            [style]="{ width: '24px', height: '24px' }"
          ></app-icon>
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .icon-rail {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        width: 68px;
        height: 100%;
        padding: 12px 0;
        background: var(--app-nav-rail-bg);
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
      .rail-btn:hover {
        background: var(--app-hover);
      }
      .friend-badge {
        position: absolute;
        top: 7px;
        right: 7px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #e53935;
        border: 2px solid var(--app-nav-rail-bg);
      }
      .avatar {
        margin-bottom: 12px;
        border-radius: 8px;
        overflow: hidden;
      }
    `,
  ],
})
export class IconRailComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly AppIconType = AppIconType;
  /** fired after a group is created so the parent can refresh the thread list */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined);

  private readonly routeService = inject(RouteService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly transloco = inject(TranslocoService);
  /** Current logged-in profile (used for the SELF avatar's initial). */
  readonly sessionProfile = this.userService.sessionProfile;
  readonly friendReqBadge = this.userService.friendReqBadge;

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system'
      ? AppIconType.CONTRAST
      : m === 'light'
        ? AppIconType.SUN
        : AppIconType.MOON;
  });
  /** Human label for the current theme mode (tooltip). Reads the language signal so it re-evaluates
   *  on a language switch. */
  readonly themeLabel = computed(() => {
    this.languageService.lang();
    return this.transloco.translate('nav.theme.' + this.themeService.mode());
  });
  cycleTheme(): void {
    this.themeService.cycleMode();
  }

  friendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS, {
      initialTab: this.friendReqBadge() ? 'pending' : 'add',
    });
  }

  editProfile() {
    this.routeService.popupDlg(PopupType.EDIT_PROFILE);
  }

  newGroup() {
    this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (result) => {
      // only refresh when a group was actually created, not on cancel/back
      if (result) this.onThreadListChanged()?.();
    });
  }

  /** Open Settings as a wide two-column dialog. icon-rail is desktop-only, so this is always the dialog
   *  surface (mobile uses the aside via the nav-drawer entry). */
  settings(): void {
    this.routeService.openSettingsDialog();
  }
}
