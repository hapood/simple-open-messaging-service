import {
  Component,
  inject,
  OnInit,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { LocalDataManagementService } from '../../services/local-data-management.service';
import { PopupType, RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-settings-data',
  imports: [MatButtonModule, MatListModule, MatCardModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <mat-card appearance="outlined" class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.cachedMessages' | transloco
            }}</span>
            <span matListItemMeta>{{ loading() ? '…' : messageCount() }}</span>
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.cachedMediaFiles' | transloco
            }}</span>
            <span matListItemMeta>{{ mediaUsage() }}</span>
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.clearChatCache' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.clearChatCacheDesc' | transloco
            }}</span>
            <button
              mat-button
              matListItemMeta
              class="check-btn"
              type="button"
              [disabled]="clearing()"
              (click)="confirmClear()"
            >
              {{
                (clearing()
                  ? 'settings.clearingChatCache'
                  : 'settings.clearChatCacheAction'
                ) | transloco
              }}
            </button>
          </mat-list-item>
        </mat-list>
      </mat-card>
      <span class="hint">{{ 'settings.cacheStorageHint' | transloco }}</span>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sub-page.scss',
})
export class SettingsDataComponent implements OnInit {
  private readonly route = inject(RouteService);
  private readonly localData = inject(LocalDataManagementService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  readonly loading = signal(true);
  readonly clearing = signal(false);
  readonly messageCount = signal(0);
  readonly mediaBytes = signal<number | null>(null);

  readonly mediaUsage = () => {
    const bytes = this.mediaBytes();
    if (bytes === null)
      return this.transloco.translate('settings.browserMediaCacheUnavailable');
    return this.formatBytes(bytes);
  };

  ngOnInit(): void {
    void this.refresh();
  }

  confirmClear(): void {
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'settings.clearChatCache',
        messageKey: 'settings.clearChatCacheConfirm',
        confirmKey: 'settings.clearChatCacheAction',
        danger: true,
      },
      (confirmed) => {
        if (confirmed) void this.clearCache();
      },
    );
  }

  private async refresh(): Promise<void> {
    try {
      const stats = await this.localData.stats();
      this.messageCount.set(stats.messageCount);
      this.mediaBytes.set(stats.mediaBytes);
    } catch {
      this.toast.warn(this.transloco.translate('settings.cacheStatsFailed'));
    } finally {
      this.loading.set(false);
    }
  }

  private async clearCache(): Promise<void> {
    if (this.clearing()) return;
    this.clearing.set(true);
    try {
      await this.localData.clearChatCache();
      this.toast.info(this.transloco.translate('settings.chatCacheCleared'));
    } catch {
      this.toast.warn(
        this.transloco.translate('settings.clearChatCacheFailed'),
      );
      this.clearing.set(false);
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
