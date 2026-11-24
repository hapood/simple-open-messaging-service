import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { MediaFileProgress } from '../../../services/media-file-progress.service';
import { formatBytes } from '../file-meta.util';
import { ThumbnailProgressComponent } from './thumbnail-progress.component';

/** Presentation only. Neither thumbnail loading nor client transfers enter this overlay. */
@Component({
  selector: 'app-media-download-overlay',
  imports: [MatIconModule, TranslocoPipe, ThumbnailProgressComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state().status) {
      @case ('ready') {}
      @case ('failed') {
        <div
          class="mask"
          role="status"
          [attr.aria-label]="'chat.mediaFailed' | transloco"
        >
          <mat-icon>error_outline</mat-icon>
        </div>
      }
      @default {
        <div
          class="mask"
          role="status"
          [attr.aria-label]="'chat.mediaDownloading' | transloco"
        >
          <span class="ring"
            ><app-thumbnail-progress [value]="percent()"
          /></span>
          @if (showSpeed()) {
            <span class="speed">{{ speed() }}</span>
          }
        </div>
      }
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .mask {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: #0002;
    }
    .ring {
      position: relative;
      width: var(--media-ring-size, 44px);
      height: var(--media-ring-size, 44px);
    }
    mat-icon {
      width: 24px;
      height: 24px;
      font-size: 24px;
      line-height: 24px;
    }
    .speed {
      position: absolute;
      top: calc(50% + var(--media-speed-offset, 28px));
      height: 20px;
      line-height: 20px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
  `,
})
export class MediaDownloadOverlayComponent {
  readonly state = input.required<MediaFileProgress>();
  readonly showSpeed = input(false);
  readonly percent = computed(() => {
    const { loaded, total } = this.state();
    return total !== null && total > 0
      ? Math.min(100, (loaded / total) * 100)
      : null;
  });
  readonly speed = computed(() => {
    const state = this.state();
    if (state.status !== 'downloading') return '';
    // Zero is a real stalled rate, not a missing-field fallback.
    return state.bytesPerSecond === 0
      ? '0 B/s'
      : `${formatBytes(state.bytesPerSecond)}/s`;
  });
}
