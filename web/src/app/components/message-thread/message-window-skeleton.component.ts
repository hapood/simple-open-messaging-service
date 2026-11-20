import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

export const SKELETON_ROW_HEIGHT = 64;
export const SKELETON_ROW_GAP = 16;
export function skeletonRowCount(height: number): number {
  return Math.max(
    1,
    Math.ceil(
      (height + SKELETON_ROW_GAP) / (SKELETON_ROW_HEIGHT + SKELETON_ROW_GAP),
    ),
  );
}

/** Whole-window loading presentation, deliberately outside historical row geometry. */
@Component({
  selector: 'app-message-window-skeleton',
  standalone: true,
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="status" role="status">{{ 'common.loading' | transloco }}</span>
    <div #area class="area" aria-hidden="true">
      <div class="rows">
        @for (row of rows(); track row) {
          <div class="row" [class.self]="row % 2 === 0"></div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: block;
      background: var(--app-surface);
      color: var(--app-text);
      pointer-events: none;
    }
    .status {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      line-height: 1px;
    }
    .area {
      position: absolute;
      inset: 0 0 var(--soms-content-bottom-reserve, 0px);
      overflow: hidden;
    }
    .rows {
      position: absolute;
      bottom: 0;
      left: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .row {
      height: 64px;
      flex: 0 0 64px;
      width: 64%;
      max-width: 360px;
      border-radius: 16px;
      background: color-mix(in srgb, currentColor 10%, transparent);
      animation: pulse 1200ms ease-in-out infinite alternate;
    }
    .self {
      align-self: flex-end;
    }
    @keyframes pulse {
      to {
        opacity: 0.45;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .row {
        animation: none;
      }
    }
  `,
})
export class MessageWindowSkeletonComponent {
  readonly rows = signal([0]);
  private readonly area = viewChild.required<ElementRef<HTMLElement>>('area');
  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const area = this.area().nativeElement;
      const measure = () => {
        const count = skeletonRowCount(area.clientHeight);
        if (count !== this.rows().length)
          this.rows.set(Array.from({ length: count }, (_, index) => index));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(area);
      measure();
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
