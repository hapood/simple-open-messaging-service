import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { scan } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { DownloadService, reduceDownloadTasks, type DownloadTask } from '../../services/download.service';
import { isTauri } from '../../services/runtime';
import { PopupType, RouteService } from '../../services/route.service';

@Component({
  selector: 'app-download-button',
  standalone: true,
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (native) {
      <button type="button" (click)="open()" [title]="'downloadTasks.title' | transloco"
        [attr.aria-label]="'downloadTasks.title' | transloco" [class.downloading]="active()">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <g class="arrow"><path d="M12 3v12m-5-5 5 5 5-5" /></g>
          <path d="M4 16v4h16v-4" />
        </svg>
      </button>
    }
  `,
  styles: [`
    :host { display: contents; }
    button { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 8px; border: 0; border-radius: 8px; color: inherit; background: transparent; cursor: pointer; }
    button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    svg { width: 24px; height: 24px; }
    .downloading .arrow { animation: downloading 1s ease-in-out infinite; }
    @keyframes downloading { 0%, 100% { transform: translateY(-2px); } 50% { transform: translateY(2px); } }
    @media (prefers-reduced-motion: reduce) { .downloading .arrow { animation: none; } }
  `],
})
export class DownloadButtonComponent {
  readonly native = isTauri();
  private readonly route = inject(RouteService);
  private readonly downloads = inject(DownloadService);
  private readonly tasks = toSignal(this.downloads.watchAll().pipe(scan(reduceDownloadTasks, [] as readonly DownloadTask[])), { initialValue: [] });
  readonly active = computed(() => this.tasks().some(task => task.phase === 'downloading'));
  open(): void { if (this.native) this.route.popupDlg(PopupType.DOWNLOAD_DETAIL, {}); }
}
