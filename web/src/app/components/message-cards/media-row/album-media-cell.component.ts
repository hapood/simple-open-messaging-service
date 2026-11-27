import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  ElementRef,
  afterRenderEffect,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { FileIconComponent } from '../file-icon.component';
import type { AlbumMedia } from '../chat-item';
import {
  MediaFileProgressService,
  type MediaFileProgress,
} from '../../../services/media-file-progress.service';
import { chatThumbnailUrl } from '../../../services/runtime';
import { formatDuration } from '../file-meta.util';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { MediaDownloadOverlayComponent } from './media-download-overlay.component';
import { MediaThumbnailComponent } from './media-thumbnail.component';
import { onCbItemPredestory } from '../../../lib/chat-box/cb-item-activity';

const KIND_ICONS = {
  image: 'image',
  video: 'movie',
  audio: 'audiotrack',
  file: 'description',
};
const PENDING: MediaFileProgress = {
  status: 'pending',
  loaded: 0,
  total: null,
  bytesPerSecond: null,
};

/** One resource subscription, a type-specific content surface, and a separate download overlay. */
@Component({
  selector: 'app-album-media-cell',
  imports: [
    MatIconModule,
    FileIconComponent,
    AudioPlayerComponent,
    MediaDownloadOverlayComponent,
    MediaThumbnailComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let resource = media();
    <div class="kind" aria-hidden="true">
      @if (resource.kind === 'file') {
        <app-file-icon [media]="resource" />
      } @else {
        <mat-icon>{{ kindIcon() }}</mat-icon>
      }
    </div>
    @if (state().status === 'ready') {
      @switch (resource.kind) {
        @case ('image') {
          <app-media-thumbnail [src]="thumbnailUrl()" />
        }
        @case ('video') {
          <app-media-thumbnail [src]="thumbnailUrl()" />
          @if (showVideoControls()) {
            <span class="play" aria-hidden="true"
              ><mat-icon>play_arrow</mat-icon></span
            >
            <span class="duration">{{
              formatDuration(resource.duration)
            }}</span>
          }
        }
        @case ('audio') {
          @if (audioPlayback()) {
            <app-audio-player
              [src]="media().src"
              [duration]="resource.duration"
              [time]="time()"
              [showUnplayed]="showUnplayed()"
            />
          }
        }
      }
    }
    <app-media-download-overlay [state]="state()" [showSpeed]="showSpeed()" />
    <ng-content />
  `,
  styles: `
    :host {
      display: block;
      position: absolute;
      inset: 0;
      overflow: hidden;
      background: var(--app-surface-elevated, #eee);
      color: var(--app-text-muted, #777);
    }
    :host(.positioned) {
      right: auto;
      bottom: auto;
    }
    :host(.compact) {
      --media-ring-size: 24px;
    }
    .kind {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
    }
    mat-icon {
      width: 24px;
      height: 24px;
      font-size: 24px;
      line-height: 24px;
    }
    :host(.compact) .kind mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
      line-height: 16px;
    }
    app-audio-player {
      position: absolute;
      inset: 0;
    }
    .play {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #0008;
      color: white;
      pointer-events: none;
    }
    .duration {
      position: absolute;
      bottom: 6px;
      left: 6px;
      padding: 1px 6px;
      line-height: 14px;
      font-size: 11px;
      border-radius: 8px;
      background: #0008;
      color: white;
    }
  `,
  host: {
    '[class]': '"msg-media-cell msg-media-cell--" + media().kind',
    '[class.compact]': 'compact()',
    '[class.positioned]': '!!rect()',
    '[attr.data-media-message-id]': 'media().msgId',
    '[style.left.%]': 'rect()?.xPct',
    '[style.width.%]': 'rect()?.wPct',
  },
})
export class AlbumMediaCellComponent {
  private readonly files = inject(MediaFileProgressService);
  readonly media = input.required<AlbumMedia>();
  readonly rect = input<{
    xPct: number;
    yPx: number;
    wPct: number;
    hPx: number;
  }>();
  readonly compact = input(false);
  readonly showSpeed = input(false);
  readonly audioPlayback = input(false);
  readonly showVideoControls = input(false);
  readonly time = input('');
  readonly showUnplayed = input(true);
  readonly state = signal<MediaFileProgress>(PENDING);
  readonly kindIcon = computed(() => KIND_ICONS[this.media().kind]);
  readonly thumbnailUrl = computed(() => chatThumbnailUrl(this.media().src));
  readonly formatDuration = formatDuration;

  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let frame: number | undefined;
    let current: { top: number; height: number } | undefined;
    let target: { top: number; height: number } | undefined;
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    };
    const paint = (value: { top: number; height: number }) => {
      current = value;
      host.style.top = `${value.top}px`;
      host.style.height = `${value.height}px`;
    };
    const settle = () => {
      cancel();
      if (target) paint(target);
    };
    preference.addEventListener('change', settle);
    // The parent commits final album allocation before paint. Only internal cell
    // coordinates interpolate; vertical CSS lengths must be integers every frame.
    const geometry = afterRenderEffect(() => {
      const rect = this.rect();
      cancel();
      if (!rect) {
        current = target = undefined;
        host.style.removeProperty('top');
        host.style.removeProperty('height');
        return;
      }
      target = { top: Math.round(rect.yPx), height: Math.round(rect.hPx) };
      if (!current || preference.matches) {
        paint(target);
        return;
      }
      const from = current;
      const to = target;
      if (from.top === to.top && from.height === to.height) return;
      const start = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, Math.max(0, (now - start) / 180));
        const eased = 1 - (1 - progress) ** 3;
        paint({
          top: Math.round(from.top + (to.top - from.top) * eased),
          height: Math.round(from.height + (to.height - from.height) * eased),
        });
        if (progress < 1) frame = requestAnimationFrame(tick);
        else frame = undefined;
      };
      frame = requestAnimationFrame(tick);
    });
    onCbItemPredestory(() => {
      geometry.destroy();
      cancel();
      for (const animation of host.getAnimations()) animation.cancel();
      preference.removeEventListener('change', settle);
    });
    const observation = effect((onCleanup) => {
      const media = this.media();
      this.state.set(PENDING);
      const subscription = this.files.observe(media).subscribe({
        next: (state) => this.state.set(state),
        error: () =>
          this.state.set({
            status: 'failed',
            loaded: 0,
            total: null,
            bytesPerSecond: null,
          }),
      });
      onCleanup(() => subscription.unsubscribe());
    });
    onCbItemPredestory(() => observation.destroy());
  }
}
