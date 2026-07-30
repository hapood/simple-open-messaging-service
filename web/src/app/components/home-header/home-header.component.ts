import { Component, computed, inject, input, signal } from '@angular/core';
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
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  MediaTransferService,
  type ThreadTransferSummary,
} from '../../services/media-transfer.service';
import { displayThreadName } from '../../services/model';
import { ImageDownloadService } from '../../services/image-download.service';
import { formatBytes } from '../message-cards/file-meta.util';

/**
 * Compact/medium chat-list top bar: profile avatar on the left; friend requests and overflow actions
 * on the right. Expanded uses the icon rail instead of duplicating this navigation.
 */
@Component({
  selector: 'app-home-header',
  imports: [
    OverlayModule,
    IconComponent,
    UserAvatarComponent,
    ChatActionMenuComponent,
    TranslocoPipe,
  ],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss',
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  /** Fired after a group is created so the parent refreshes the thread list (forwarded from the shell). */
  readonly onThreadListChanged = input<(() => void) | undefined>(undefined);

  private readonly routeService = inject(RouteService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  private readonly convList = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
  private readonly transfers = inject(MediaTransferService);
  readonly imageDownloads = inject(ImageDownloadService);

  readonly friendReqBadge = this.userService.friendReqBadge;
  readonly sessionProfile = this.userService.sessionProfile;
  readonly moreMenuOpen = signal(false);
  readonly transferMenuOpen = signal(false);
  readonly transferSummaries = this.transfers.summaries;
  readonly transferTasks = this.transfers.tasks;
  readonly downloadTasks = computed(() =>
    this.imageDownloads
      .tasks()
      .filter(
        (task) =>
          task.status === 'downloading' ||
          task.status === 'saving' ||
          task.status === 'failed',
      ),
  );
  readonly downloadActiveCount = this.imageDownloads.activeCount;
  readonly hasTransfers = computed(
    () =>
      this.transferSummaries().length > 0 || this.downloadTasks().length > 0,
  );
  readonly transferCount = computed(() =>
    this.transferSummaries().reduce((sum, item) => sum + item.uploading, 0),
  );
  readonly transferTotal = computed(() =>
    this.transferSummaries().reduce((sum, item) => sum + item.total, 0),
  );
  readonly transferCompleted = computed(() =>
    this.transferSummaries().reduce((sum, item) => sum + item.completed, 0),
  );
  readonly transferProgress = computed<number | null>(() => {
    const summaries = this.transferSummaries();
    const total = summaries.reduce((sum, item) => sum + item.bytes, 0);
    if (total <= 0) return null;
    const loaded = summaries.reduce((sum, item) => sum + item.loadedBytes, 0);
    return Math.round((loaded / total) * 100);
  });
  readonly transferFailedCount = computed(() =>
    this.transferSummaries().reduce((sum, item) => sum + item.failed, 0),
  );
  readonly downloadFailedCount = computed(
    () =>
      this.downloadTasks().filter((task) => task.status === 'failed').length,
  );
  readonly downloadProgress = computed<number | null>(() => {
    const tasks = this.downloadTasks().filter(
      (task) => task.status !== 'failed',
    );
    const total = tasks.reduce(
      (sum, task) => sum + (task.total || task.expectedSize),
      0,
    );
    if (total <= 0) return null;
    return Math.round(
      (tasks.reduce(
        (sum, task) =>
          sum + Math.min(task.loaded, task.total || task.expectedSize),
        0,
      ) /
        total) *
        100,
    );
  });
  readonly globalProgress = computed(() => {
    const uploadBytes = this.transferSummaries().reduce(
      (sum, item) => sum + item.bytes,
      0,
    );
    const uploadLoaded = this.transferSummaries().reduce(
      (sum, item) => sum + item.loadedBytes,
      0,
    );
    const downloadBytes = this.downloadTasks().reduce(
      (sum, item) => sum + (item.total || item.expectedSize),
      0,
    );
    const downloadLoaded = this.downloadTasks().reduce(
      (sum, item) =>
        sum + Math.min(item.loaded, item.total || item.expectedSize),
      0,
    );
    return uploadBytes + downloadBytes > 0
      ? Math.round(
          ((uploadLoaded + downloadLoaded) / (uploadBytes + downloadBytes)) *
            100,
        )
      : null;
  });

  /** Icon reflecting the current theme mode (system/light/dark). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system'
      ? AppIconType.CONTRAST
      : m === 'light'
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
      key: 'folders',
      labelKey: 'nav.folders',
      icon: AppIconType.FOLDERS,
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
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS, {
      initialTab: this.friendReqBadge() ? 'pending' : 'add',
    });
  }
  toggleMoreMenu() {
    this.moreMenuOpen.update((open) => !open);
  }
  closeMoreMenu() {
    this.moreMenuOpen.set(false);
  }

  toggleTransferMenu() {
    if (this.transferTasks().length > 0) {
      this.closeTransferMenu();
      this.routeService.popupDlg(PopupType.UPLOAD_DETAIL, {});
      return;
    }
    const summaries = this.transferSummaries();
    if (summaries.length === 1 && this.downloadTasks().length === 0) {
      this.openTransferThread(summaries[0]);
      return;
    }
    this.transferMenuOpen.update((open) => !open);
  }

  openDownloadThread(threadId: number) {
    this.closeTransferMenu();
    this.nav.openChat(threadId);
  }

  cancelDownload(key: string, event: Event) {
    event.stopPropagation();
    const task = this.downloadTasks().find((item) => item.key === key);
    if (task) this.imageDownloads.cancel({ msgId: task.msgId, src: task.src });
  }

  downloadProgressText(loaded: number, total: number): string {
    return total > 0
      ? `${formatBytes(loaded) || '0 B'} / ${formatBytes(total)}`
      : formatBytes(loaded);
  }

  closeTransferMenu() {
    this.transferMenuOpen.set(false);
  }

  transferThreadName(summary: ThreadTransferSummary): string {
    const item = this.convList
      .items()
      .find((thread) => thread.threadId === summary.threadId);
    return item ? displayThreadName(item) : `#${summary.threadId}`;
  }

  openTransferThread(summary: ThreadTransferSummary) {
    this.closeTransferMenu();
    this.transfers.requestLatest(summary.threadId);
    this.nav.openChat(summary.threadId);
  }

  tasksForThread(threadId: number) {
    return this.transferTasks().filter((task) => task.threadId === threadId);
  }

  cancelThread(threadId: number, event: Event) {
    event.stopPropagation();
    for (const task of this.tasksForThread(threadId)) {
      if (task.status === 'uploading')
        this.transfers.cancel(task.clientMessageId);
    }
  }

  retryThread(threadId: number, event: Event) {
    event.stopPropagation();
    for (const task of this.tasksForThread(threadId)) {
      if (task.status === 'failed') this.transfers.retry(task.clientMessageId);
    }
  }

  onSelect(key: string) {
    switch (key) {
      case 'settings':
        this.routeService.openSettings();
        this.closeMoreMenu();
        break;
      case 'newGroup':
        this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (r) => {
          if (r) this.onThreadListChanged()?.();
        });
        this.closeMoreMenu();
        break;
      case 'folders':
        this.routeService.popupDlg(PopupType.FOLDER_EDITOR);
        this.closeMoreMenu();
        break;
      case 'theme':
        // Keep the menu open so the icon flips visibly to the new mode.
        this.themeService.cycleMode();
        break;
    }
  }
}
