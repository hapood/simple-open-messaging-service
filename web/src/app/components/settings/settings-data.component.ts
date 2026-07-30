import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocalDataManagementService } from '../../services/local-data-management.service';
import { LogoutService } from '../../services/logout.service';
import { PopupType, RouteService } from '../../services/route.service';

@Component({
  selector: 'app-settings-data',
  imports: [MatButtonModule, MatListModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.deleteAllData' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.deleteAllDataDesc' | transloco }}</span>
            <button mat-button matListItemMeta type="button" [disabled]="deleting()" (click)="confirmDelete()">
              {{ (deleting() ? 'settings.deletingAllData' : 'settings.deleteAllDataAction') | transloco }}
            </button>
          </mat-list-item>
        </mat-list>
      </div>
      @if (failed()) {
        <span class="hint">{{ 'settings.deleteAllDataFailed' | transloco }}</span>
      }
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsDataComponent {
  private readonly route = inject(RouteService);
  private readonly localData = inject(LocalDataManagementService);
  private readonly logout = inject(LogoutService);
  readonly deleting = signal(false);
  readonly failed = signal(false);

  confirmDelete(): void {
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'settings.deleteAllData',
        messageKey: 'settings.deleteAllDataConfirm',
        confirmKey: 'settings.deleteAllDataAction',
        danger: true,
      },
      (confirmed) => {
        if (confirmed) void this.deleteAll();
      },
    );
  }

  private async deleteAll(): Promise<void> {
    if (this.deleting()) return;
    this.deleting.set(true);
    this.failed.set(false);
    try {
      await this.localData.clearAll();
      this.logout.logout();
    } catch {
      this.failed.set(true);
      this.deleting.set(false);
    }
  }
}
