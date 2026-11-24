import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';

/** A derivative load failure never changes original-file readiness. */
@Component({
  selector: 'app-media-thumbnail',
  imports: [MatIconModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (failed()) {
      <span
        class="failure"
        role="img"
        [attr.aria-label]="'gallery.failed' | transloco"
      >
        <mat-icon>broken_image</mat-icon>
      </span>
    } @else {
      <img [src]="src()" decoding="async" alt="" (error)="failed.set(true)" />
    }
  `,
  styles: `
    :host,
    img,
    .failure {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    img {
      display: block;
      object-fit: cover;
      pointer-events: none;
    }
    .failure {
      display: grid;
      place-items: center;
      background: var(--app-surface-elevated, #eee);
    }
    mat-icon {
      width: 24px;
      height: 24px;
      font-size: 24px;
      line-height: 24px;
    }
  `,
})
export class MediaThumbnailComponent {
  readonly src = input.required<string>();
  readonly failed = signal(false);
  constructor() {
    effect(() => {
      this.src();
      this.failed.set(false);
    });
  }
}
