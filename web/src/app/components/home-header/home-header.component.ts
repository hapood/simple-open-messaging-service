import { DownloadButtonComponent } from '../download-detail-dialog/download-button.component';
import {
  Component,
  computed,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { OverlayModule } from '@angular/cdk/overlay';
import { AppIconType, IconComponent } from '../icon/icon.component';
import {
  ChatActionMenuComponent,
  type ChatMenuEntry,
} from '../chat-action-menu/chat-action-menu.component';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { ThemeService } from '../../services/theme.service';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType } from '../user-avatar/model';

/** Chat-list navigation only. Task status belongs to each conversation row. */
@Component({
  selector: 'app-home-header',
  imports: [
    OverlayModule,
    DownloadButtonComponent,
    IconComponent,
    DemandAvatarComponent,
    ChatActionMenuComponent,
    TranslocoPipe,
  ],
  templateUrl: './home-header.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home-header.component.scss',
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined);
  private readonly routeService = inject(RouteService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  readonly friendReqBadge = this.userService.friendReqBadge;
  readonly sessionProfile = this.userService.sessionProfile;
  readonly moreMenuOpen = signal(false);
  readonly themeIcon = computed<AppIconType>(() => {
    const mode = this.themeService.mode();
    return mode === 'system'
      ? AppIconType.CONTRAST
      : mode === 'light'
        ? AppIconType.SUN
        : AppIconType.MOON;
  });
  readonly moreEntries = computed<ChatMenuEntry[]>(() => [
    {
      kind: 'action',
      key: 'newGroup',
      labelKey: 'nav.newGroup',
      icon: AppIconType.NEW_GROUP,
    },
    {
      kind: 'action',
      key: 'theme',
      labelKey: 'nav.themeLabel',
      icon: this.themeIcon(),
    },
    {
      kind: 'action',
      key: 'settings',
      labelKey: 'nav.settings',
      icon: AppIconType.SETTINGS,
    },
  ]);
  openProfile() {
    this.routeService.openProfile();
  }
  openFriendRequests() {
    this.routeService.openFriendRequests(
      this.friendReqBadge() ? 'pending' : 'add',
    );
  }
  toggleMoreMenu() {
    this.moreMenuOpen.update((open) => !open);
  }
  closeMoreMenu() {
    this.moreMenuOpen.set(false);
  }
  onSelect(key: string) {
    switch (key) {
      case 'settings':
        this.routeService.openSettings();
        this.closeMoreMenu();
        break;
      case 'newGroup':
        this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (result) => {
          if (result) this.onThreadListChanged()?.();
        });
        this.closeMoreMenu();
        break;
      case 'theme':
        this.themeService.cycleMode();
        break;
    }
  }
}
