import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { scan } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslocoPipe } from '@jsverse/transloco';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { PopupType, RouteService } from '../../services/route.service';
import { DownloadService, reduceDownloadTasks, type DownloadTask } from '../../services/download.service';

@Component({
  selector: 'app-download-detail-dialog',
  standalone: true,
  imports: [TranslocoPipe, PageHeaderComponent, MatButtonModule, MatListModule, MatProgressBarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-detail-dialog.component.html',
  styleUrl: './download-detail-dialog.component.scss',
})
export class DownloadDetailDialogComponent {
  private readonly route = inject(RouteService);
  close(): void { this.route.closeDlg(PopupType.DOWNLOAD_DETAIL); }
  hasHistory(): boolean {
    return this.tasks().some(task => task.phase === 'completed' || task.phase === 'failed');
  }
  confirmClear(): void {
    this.route.popupDlg(PopupType.CONFIRM, {
      titleKey: 'downloadTasks.clearHistory',
      messageKey: 'downloadTasks.clearHistoryConfirm',
      confirmKey: 'downloadTasks.clearHistoryAction',
      checkboxKey: 'downloadTasks.deleteFiles',
      danger: true,
    }, result => {
      if (result && typeof result === 'object' && result.confirmed) {
        void this.downloads.clearHistory(result.checked);
      }
    });
  }
  private readonly downloads = inject(DownloadService);
  readonly busy = signal<ReadonlySet<string>>(new Set());
  readonly tasks = toSignal(this.downloads.watchAll().pipe(
    scan(reduceDownloadTasks, [] as readonly DownloadTask[]),
  ), { initialValue: [] as readonly DownloadTask[] });

  percentage(task: DownloadTask): number {
    if (task.total === null) return 0;
    if (task.total === 0) return task.phase === 'completed' ? 100 : 0;
    return Math.max(0, Math.min(100, task.loaded / task.total * 100));
  }

  cancel(id: string): void { this.downloads.cancel(id); }
  dismiss(id: string): void { this.downloads.dismiss(id); }
  async retry(id: string): Promise<void> {
    if (this.busy().has(id)) return;
    this.busy.update(ids => new Set([...ids, id]));
    try { await this.downloads.retry(id); }
    catch { /* The service publishes failure details in the task stream. */ }
    finally { this.busy.update(ids => { const next = new Set(ids); next.delete(id); return next; }); }
  }
}
